import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { fileURLToPath } from 'node:url';
import { runPlatformMigrations } from '../src/platform/migrations.js';
import { getRadioSchedule, recordRadioFeedback, startRadioSession } from '../src/platform/radio.js';
import { getRecommendations } from '../src/platform/recsys.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/platform/migrations/', import.meta.url));
let database;
let pool;
let userId;
let strangerId;
let mediaUrlCount = 0;
const storage = {
  async createDownloadUrl({ key, contentType, expiresInSeconds }) {
    mediaUrlCount += 1;
    return `https://private-storage.test/${encodeURIComponent(key)}?type=${encodeURIComponent(contentType)}&ttl=${expiresInSeconds}`;
  },
};

before(async () => {
  database = new PGlite({ extensions: { vector } });
  await database.waitReady;
  const query = async (sql, values) => {
    if (values?.length) return database.query(sql, values);
    const results = await database.exec(sql);
    return results.at(-1) ?? { rows: [] };
  };
  const client = { query, release() {} };
  pool = { connect: async () => client, query };
  await runPlatformMigrations(pool, { directory: MIGRATIONS_DIR });
  userId = (await pool.query("INSERT INTO users (email, display_name) VALUES ('radio-user@example.test', 'Radio user') RETURNING id")).rows[0].id;
  strangerId = (await pool.query("INSERT INTO users (email, display_name) VALUES ('radio-stranger@example.test', 'Radio stranger') RETURNING id")).rows[0].id;

  const ownerId = (await pool.query("INSERT INTO users (email, display_name, primary_role) VALUES ('radio-artist@example.test', 'Radio artist', 'artist') RETURNING id")).rows[0].id;
  const trackId = (await pool.query(`
    INSERT INTO tracks (owner_id, title, artist_display, genre, mood, duration_ms, rights_confirmed_at, rights_offer_version)
    VALUES ($1, 'Radio fixture', 'Radio artist', 'ambient', ARRAY['calm'], 180000, now(), 'radio-test-v1') RETURNING id
  `, [ownerId])).rows[0].id;
  await pool.query(`
    INSERT INTO moderation_queue (track_id, reason, status, decision, decided_at)
    VALUES ($1, 'radio approval', 'approved', 'approve', now())
  `, [trackId]);
  await pool.query(`UPDATE tracks SET status = 'published', visibility = 'public', published_at = now() WHERE id = $1`, [trackId]);
  await pool.query(`
    INSERT INTO media_objects (track_id, object_kind, bucket_name, object_key, sha256, size_bytes, lifecycle_state, content_type)
    VALUES ($1, 'original', 'vision-private-media', $2, repeat('b', 64), 1024, 'ready', 'audio/mpeg')
  `, [trackId, `media/${ownerId}/${trackId}/54e45c19-63ee-4ecf-9b72-6836ca0ee3a4`]);
});

after(async () => { if (database) await database.close(); });

describe('owner-scoped music-only radio scheduler', () => {
  test('creates a private schedule from eligible ready media only', async () => {
    const started = await startRadioSession(pool, userId, { mood: 'calm', genre: 'ambient' }, { storage });
    assert.equal(started.status, 'active');
    assert.equal(started.mood, 'calm');
    assert.equal(started.schedule.schedulerPolicy, 'music-only-v1');
    assert.equal(started.schedule.items.length, 1);
    const item = started.schedule.items[0];
    assert.equal(item.segmentType, 'music');
    assert.equal(item.durationMs, 180000);
    assert.equal(item.codec, 'original');
    assert.match(item.url, /^https:\/\/private-storage\.test\//);
    assert.equal(item.cacheControl, 'private, no-store');
    assert.equal(mediaUrlCount, 1);
    const stored = await pool.query('SELECT segment_type FROM radio_schedule WHERE session_id = $1', [started.id]);
    assert.deepEqual(stored.rows, [{ segment_type: 'music' }]);

    await assert.rejects(getRadioSchedule(pool, started.id, strangerId, { storage }),
      (error) => error.status === 404);
    await assert.rejects(getRadioSchedule(pool, started.id, userId, { storage, aheadSeconds: 30 }),
      (error) => error.code === 'invalid_input' && error.status === 400);
  });

  test('segment feedback is scoped to the owner and skipped segments leave the upcoming window', async () => {
    const started = await startRadioSession(pool, userId, { mood: 'calm' }, { storage });
    const segmentId = started.schedule.items[0].id;
    const liked = await recordRadioFeedback(pool, started.id, userId, { segmentId, reaction: 'like' });
    assert.equal(liked.reaction, 'like');
    const skipped = await recordRadioFeedback(pool, started.id, userId, { segmentId, reaction: 'skip' });
    assert.equal(skipped.reaction, 'skip');
    const next = await getRadioSchedule(pool, started.id, userId, { storage });
    assert.equal(next.items.length, 0);
    const recommendations = await getRecommendations(pool, userId, new URLSearchParams('genre=ambient'));
    assert.deepEqual(recommendations.items, [], 'a skipped radio track is suppressed in later recommendations');
    await assert.rejects(recordRadioFeedback(pool, started.id, strangerId, { segmentId, reaction: 'like' }),
      (error) => error.status === 404);
    await assert.rejects(recordRadioFeedback(pool, started.id, userId, { segmentId, reaction: 'ad' }),
      (error) => error.code === 'invalid_input' && error.status === 400);
  });
});
