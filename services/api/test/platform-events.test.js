import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { fileURLToPath } from 'node:url';
import { runPlatformMigrations } from '../src/platform/migrations.js';
import { ingestPlayEvents } from '../src/platform/events.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/platform/migrations/', import.meta.url));
let database;
let pool;
let userId;
let publicTrackId;
let privateTrackId;

async function makeTrack(isPublic) {
  const inserted = await pool.query(`
    INSERT INTO tracks (owner_id, title, artist_display, rights_confirmed_at, rights_offer_version)
    VALUES ($1, 'Event fixture', 'Event artist', $2, $3) RETURNING id
  `, [userId, isPublic ? new Date() : null, isPublic ? 'event-offer-v1' : null]);
  const trackId = inserted.rows[0].id;
  if (isPublic) {
    await pool.query(`
      INSERT INTO moderation_queue (track_id, reason, status, decision, decided_at)
      VALUES ($1, 'approved fixture', 'approved', 'approve', now())
    `, [trackId]);
    await pool.query(`UPDATE tracks SET status = 'published', visibility = 'public', published_at = now() WHERE id = $1`, [trackId]);
  }
  return trackId;
}

function event(trackId, patch = {}) {
  return {
    eventId: randomUUID(),
    trackId,
    sessionId: randomUUID(),
    kind: 'start',
    positionMs: 0,
    durationMs: 180_000,
    source: 'wave',
    device: 'web',
    occurredAt: new Date().toISOString(),
    ...patch,
  };
}

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
  const user = await pool.query("INSERT INTO users (email, display_name) VALUES ('events@example.test', 'Events user') RETURNING id");
  userId = user.rows[0].id;
  publicTrackId = await makeTrack(true);
  privateTrackId = await makeTrack(false);
});

after(async () => { if (database) await database.close(); });

describe('privacy-minimal play event ingestion', () => {
  test('accepts deduplicated batches only for approved public tracks', async () => {
    const first = event(publicTrackId, { kind: 'play_30s', positionMs: 30_000 });
    const second = event(publicTrackId, { kind: 'finish', positionMs: 180_000 });
    const result = await ingestPlayEvents(pool, userId, { events: [first, second] });
    assert.deepEqual(result, { accepted: 2, duplicates: 0 });
    assert.deepEqual(await ingestPlayEvents(pool, userId, { events: [first] }), { accepted: 0, duplicates: 1 });
    const rows = await pool.query(`
      SELECT kind, source, device, ip_hash FROM play_events WHERE user_id = $1 ORDER BY kind
    `, [userId]);
    assert.deepEqual(rows.rows, [
      { kind: 'finish', source: 'wave', device: 'web', ip_hash: null },
      { kind: 'play_30s', source: 'wave', device: 'web', ip_hash: null },
    ]);
  });

  test('private tracks and malformed batches fail closed without partial writes', async () => {
    const privateEvent = event(privateTrackId);
    await assert.rejects(ingestPlayEvents(pool, userId, { events: [event(publicTrackId), privateEvent] }),
      (error) => error.code === 'not_found' && error.status === 404);
    const count = await pool.query('SELECT count(*)::int AS count FROM play_events WHERE user_id = $1', [userId]);
    assert.equal(count.rows[0].count, 2);

    await assert.rejects(ingestPlayEvents(pool, userId, { events: [event(publicTrackId, { extraIp: '198.51.100.10' })] }),
      (error) => error.code === 'invalid_input' && error.status === 400);
    await assert.rejects(ingestPlayEvents(pool, userId, { events: [event(publicTrackId, { kind: 'play_30s', positionMs: 10_000 })] }),
      (error) => error.code === 'invalid_input' && error.status === 400);
    await assert.rejects(ingestPlayEvents(pool, userId, { events: [event(publicTrackId, { occurredAt: new Date(Date.now() - 8 * 86400_000).toISOString() })] }),
      (error) => error.code === 'invalid_input' && error.status === 400);
    await assert.rejects(ingestPlayEvents(pool, userId, { events: [] }),
      (error) => error.code === 'invalid_input' && error.status === 400);
  });
});
