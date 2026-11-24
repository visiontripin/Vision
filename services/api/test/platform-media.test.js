import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { fileURLToPath } from 'node:url';
import { runPlatformMigrations } from '../src/platform/migrations.js';
import { createTrackMediaUrl } from '../src/platform/media.js';
import { createRightsClaim, decideModeration, requestTrackPublication } from '../src/platform/moderation.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/platform/migrations/', import.meta.url));
let database;
let pool;
let owner;
let moderator;
let stranger;
let publicTrackId;
let privateTrackId;
const signedKeys = [];
const storage = {
  async createDownloadUrl({ key, contentType, expiresInSeconds }) {
    signedKeys.push({ key, contentType, expiresInSeconds });
    return `https://private-storage.test/${encodeURIComponent(key)}?ttl=${expiresInSeconds}`;
  },
};

async function makeTrack({ isPublic = false, status = 'quarantine', lifecycle = 'quarantine' } = {}) {
  const track = await pool.query(`
    INSERT INTO tracks (owner_id, title, artist_display, status, visibility, rights_confirmed_at, rights_offer_version)
    VALUES ($1, 'Media fixture', 'Media artist', 'quarantine', 'private', $2, $3) RETURNING id
  `, [owner.id, isPublic ? new Date() : null, isPublic ? 'test-offer-v1' : null]);
  const id = track.rows[0].id;
  if (isPublic) {
    await pool.query(`
      INSERT INTO moderation_queue (track_id, reason, status, decision, decided_at)
      VALUES ($1, 'approved fixture', 'approved', 'approve', now())
    `, [id]);
    await pool.query(`UPDATE tracks SET status = 'published', visibility = 'public', published_at = now() WHERE id = $1`, [id]);
  }
  await pool.query(`
    INSERT INTO media_objects (track_id, object_kind, bucket_name, object_key, sha256, size_bytes, lifecycle_state, content_type)
    VALUES ($1, 'original', 'vision-private-media', $2, repeat('a', 64), 128, $3, 'audio/mpeg')
  `, [id, `quarantine/${owner.id}/${id}/54e45c19-63ee-4ecf-9b72-6836ca0ee3a4`, lifecycle]);
  return id;
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
  const ownerRow = await pool.query("INSERT INTO users (email, display_name) VALUES ('media-owner@example.test', 'Media owner') RETURNING id");
  owner = { id: ownerRow.rows[0].id, role: 'artist' };
  const moderatorRow = await pool.query("INSERT INTO users (email, display_name, primary_role) VALUES ('media-moderator@example.test', 'Media moderator', 'moderator') RETURNING id");
  moderator = { id: moderatorRow.rows[0].id, role: 'moderator' };
  const strangerRow = await pool.query("INSERT INTO users (email, display_name) VALUES ('media-stranger@example.test', 'Media stranger') RETURNING id");
  stranger = { id: strangerRow.rows[0].id, role: 'artist' };
  publicTrackId = await makeTrack({ isPublic: true, status: 'published', lifecycle: 'ready' });
  privateTrackId = await makeTrack();
});

after(async () => { if (database) await database.close(); });

describe('private signed media access control', () => {
  test('public access requires latest approved decision and produces short private-cache URLs', async () => {
    const result = await createTrackMediaUrl(pool, publicTrackId, null, { storage });
    assert.equal(result.trackId, publicTrackId);
    assert.equal(result.codec, 'original');
    assert.equal(result.contentType, 'audio/mpeg');
    assert.equal(result.expiresInSeconds, 60);
    assert.equal(result.cacheControl, 'private, no-store');
    assert.match(result.url, /^https:\/\/private-storage\.test\//);
    assert.equal(signedKeys.at(-1).expiresInSeconds, 60);
  });

  test('quarantine objects are owner-only and hidden from strangers', async () => {
    const ownerUrl = await createTrackMediaUrl(pool, privateTrackId, owner, { storage, codec: 'original' });
    assert.equal(ownerUrl.codec, 'original');
    await assert.rejects(createTrackMediaUrl(pool, privateTrackId, stranger, { storage }),
      (error) => error.status === 404);
    await assert.rejects(createTrackMediaUrl(pool, privateTrackId, null, { storage }),
      (error) => error.status === 404);
    await assert.rejects(createTrackMediaUrl(pool, privateTrackId, owner, { storage, codec: 'wave' }),
      (error) => error.code === 'invalid_input' && error.status === 400);
  });

  test('owner rights confirmation plus a moderator approval unlocks only ready objects', async () => {
    const submission = await requestTrackPublication(pool, privateTrackId, owner, {
      rightsConfirmed: true, offerVersion: 'owner-offer-test-v1',
    });
    assert.equal(submission.status, 'in_review');
    await assert.rejects(createTrackMediaUrl(pool, privateTrackId, null, { storage }),
      (error) => error.status === 404);
    const decision = await decideModeration(pool, submission.moderation.id, moderator, {
      decision: 'approve', reason: 'manual test approval',
    });
    assert.equal(decision.status, 'approved');
    const lifecycle = await pool.query('SELECT lifecycle_state FROM media_objects WHERE track_id = $1', [privateTrackId]);
    assert.equal(lifecycle.rows[0].lifecycle_state, 'ready');
    const signed = await createTrackMediaUrl(pool, privateTrackId, null, { storage });
    assert.equal(signed.contentType, 'audio/mpeg');
  });

  test('rights takedown blocks new signed links before asynchronous object deletion', async () => {
    const claim = await createRightsClaim(pool, {
      trackId: publicTrackId,
      claimantEmail: 'rights-holder@example.test',
      claimantName: 'Rights holder',
      evidenceUrl: 'https://rights.example.test/evidence/1',
      claimText: 'I own the rights to this recording and request its immediate removal.',
    });
    assert.equal(claim.status, 'open');
    const track = await pool.query('SELECT status, visibility FROM tracks WHERE id = $1', [publicTrackId]);
    assert.deepEqual(track.rows[0], { status: 'taken_down', visibility: 'private' });
    const media = await pool.query('SELECT lifecycle_state FROM media_objects WHERE track_id = $1', [publicTrackId]);
    assert.equal(media.rows[0].lifecycle_state, 'pending_delete');
    await assert.rejects(createTrackMediaUrl(pool, publicTrackId, null, { storage }),
      (error) => error.status === 404);
    const deleteJobs = await pool.query("SELECT topic FROM platform_outbox WHERE aggregate_id = $1", [publicTrackId]);
    assert.deepEqual(deleteJobs.rows, [{ topic: 'media.delete.requested' }]);
  });
});
