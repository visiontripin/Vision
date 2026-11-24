import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { fileURLToPath } from 'node:url';
import { runPlatformMigrations } from '../src/platform/migrations.js';
import { createUploadIntent, completeUploadIntent } from '../src/platform/upload.js';
import { dispatchPlatformOutbox } from '../src/platform/outbox.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/platform/migrations/', import.meta.url));
let database;
let pool;
let actorCounter = 0;
const objects = new Map();
const storage = {
  bucket: 'vision-private-media',
  makeQuarantineKey: ({ ownerId, trackId, intentId }) => `quarantine/${ownerId}/${trackId}/${intentId}`,
  makeMediaKey: ({ ownerId, trackId, objectId }) => `media/${ownerId}/${trackId}/${objectId}`,
  async createUploadUrl({ key, contentType, expiresInSeconds }) {
    return { url: `http://storage.test/${key}?ttl=${expiresInSeconds}`, method: 'PUT', headers: { 'Content-Type': contentType }, expiresInSeconds };
  },
  async headObject(key) {
    const object = objects.get(key);
    return object ? { sizeBytes: object.body.length, contentType: object.contentType, etag: 'test' } : null;
  },
  async hashObject(key, { maxBytes }) {
    const object = objects.get(key);
    if (!object) return null;
    if (object.body.length > maxBytes) throw new Error('object too large');
    return {
      sha256: createHash('sha256').update(object.body).digest('hex'),
      sizeBytes: object.body.length,
      prefix: object.body.subarray(0, 64),
    };
  },
  async copyObject({ sourceKey, destinationKey }) {
    const source = objects.get(sourceKey);
    if (!source) throw new Error('source missing');
    objects.set(destinationKey, source);
  },
  async deleteObject(key) { objects.delete(key); },
};

async function seedActor(role, quota) {
  actorCounter += 1;
  const user = await pool.query(`
    INSERT INTO users (email, display_name, primary_role)
    VALUES ($1, $2, $3) RETURNING id
  `, [`upload-${actorCounter}@example.test`, `Upload ${actorCounter}`, role]);
  const actor = { id: user.rows[0].id, role };
  if (quota) {
    await pool.query(`
      INSERT INTO user_quotas (user_id, storage_limit_bytes, monthly_upload_limit, storage_used_bytes, uploads_this_month)
      VALUES ($1, $2, $3, $4, $5)
    `, [actor.id, quota.storageLimit, quota.monthlyLimit, quota.storageUsed || 0, quota.uploadsThisMonth || 0]);
  }
  return actor;
}

async function makeIntent(actor, options = {}) {
  return createUploadIntent(pool, actor, {
    title: 'Test track', artistDisplay: 'Test artist', contentType: 'audio/mpeg', sizeBytes: 64,
  }, { storage, maxUploadBytes: 1024, ...options });
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
});

after(async () => { if (database) await database.close(); });

describe('private upload intents and quota enforcement', () => {
  test('uploads require artist role and an operator-configured quota', async () => {
    const listener = await seedActor('listener');
    await assert.rejects(makeIntent(listener), (error) => error.code === 'forbidden' && error.status === 403);

    const artist = await seedActor('artist');
    await assert.rejects(makeIntent(artist), (error) => error.code === 'upload_quota_unconfigured' && error.status === 403);
  });

  test('size, storage, monthly quotas and idempotency keys are enforced atomically', async () => {
    const artist = await seedActor('artist', { storageLimit: 1_000, monthlyLimit: 1, storageUsed: 100 });
    const created = await makeIntent(artist, { idempotencyKey: 'upload-request-1' });
    assert.equal(created.status, 'pending');
    assert.match(created.upload.url, /^http:\/\/storage\.test\/quarantine\//);

    const replay = await makeIntent(artist, { idempotencyKey: 'upload-request-1' });
    assert.equal(replay.uploadId, created.uploadId);
    assert.equal(replay.trackId, created.trackId);

    await assert.rejects(
      createUploadIntent(pool, artist, {
        title: 'Different track', artistDisplay: 'Test artist', contentType: 'audio/mpeg', sizeBytes: 64,
      }, { storage, maxUploadBytes: 1024, idempotencyKey: 'upload-request-1' }),
      (error) => error.code === 'idempotency_conflict' && error.status === 409,
    );
    await assert.rejects(makeIntent(artist, { idempotencyKey: 'upload-request-2' }),
      (error) => error.code === 'upload_quota_exceeded' && error.status === 429);
    await assert.rejects(createUploadIntent(pool, artist, {
      title: 'Huge file', artistDisplay: 'Test artist', contentType: 'audio/mpeg', sizeBytes: 2048,
    }, { storage, maxUploadBytes: 1024 }), (error) => error.status === 400);

    const constrained = await seedActor('artist', { storageLimit: 50, monthlyLimit: 3 });
    await assert.rejects(makeIntent(constrained), (error) => error.code === 'storage_quota_exceeded' && error.status === 413);
    const quota = await pool.query('SELECT storage_reserved_bytes, uploads_this_month FROM user_quotas WHERE user_id = $1', [artist.id]);
    assert.equal(Number(quota.rows[0].storage_reserved_bytes), 64);
    assert.equal(Number(quota.rows[0].uploads_this_month), 1);
  });

  test('completion verifies bytes, moves to immutable private storage and enqueues exactly once', async () => {
    const artist = await seedActor('artist', { storageLimit: 1_000, monthlyLimit: 5 });
    const intent = await makeIntent(artist, { idempotencyKey: 'complete-once' });
    const intentRow = await pool.query('SELECT object_key FROM upload_intents WHERE id = $1', [intent.uploadId]);
    const sourceKey = intentRow.rows[0].object_key;
    const bytes = Buffer.alloc(64, 0x41);
    objects.set(sourceKey, { body: bytes, contentType: 'audio/mpeg' });

    const result = await completeUploadIntent(pool, intent.uploadId, artist, { storage });
    assert.equal(result.status, 'queued');
    assert.equal(result.trackId, intent.trackId);
    assert.equal(objects.has(sourceKey), false, 'presigned upload key is deleted after immutable copy');
    assert.equal(objects.size, 1);

    const track = await pool.query('SELECT status, visibility, sha256, size_bytes FROM tracks WHERE id = $1', [intent.trackId]);
    assert.equal(track.rows[0].status, 'quarantine');
    assert.equal(track.rows[0].visibility, 'private');
    assert.equal(track.rows[0].sha256.trim(), createHash('sha256').update(bytes).digest('hex'));
    assert.equal(Number(track.rows[0].size_bytes), bytes.length);
    const media = await pool.query('SELECT lifecycle_state, object_key FROM media_objects WHERE id = $1', [result.mediaObjectId]);
    assert.equal(media.rows[0].lifecycle_state, 'quarantine');
    assert.match(media.rows[0].object_key, /^media\//);
    const reserved = await pool.query('SELECT storage_used_bytes, storage_reserved_bytes FROM user_quotas WHERE user_id = $1', [artist.id]);
    assert.equal(Number(reserved.rows[0].storage_used_bytes), bytes.length);
    assert.equal(Number(reserved.rows[0].storage_reserved_bytes), 0);
    const outbox = await pool.query('SELECT topic, payload FROM platform_outbox WHERE aggregate_id = $1', [intent.trackId]);
    assert.equal(outbox.rows.length, 1);
    assert.equal(outbox.rows[0].topic, 'ingest.requested');
    const queuedJobs = [];
    const dispatched = await dispatchPlatformOutbox(pool, {
      async add(name, payload, options) { queuedJobs.push({ name, payload, options }); return { id: options.jobId }; },
    });
    assert.deepEqual(dispatched, { dispatched: 1, retried: 0, deadLettered: 0 });
    assert.equal(queuedJobs[0].name, 'ingest.requested');
    assert.equal(queuedJobs[0].payload.trackId, intent.trackId);
    assert.equal(queuedJobs[0].options.jobId, (await pool.query(
      'SELECT id FROM platform_outbox WHERE aggregate_id = $1', [intent.trackId],
    )).rows[0].id);
    const outboxState = await pool.query('SELECT processed_at FROM platform_outbox WHERE aggregate_id = $1', [intent.trackId]);
    assert.ok(outboxState.rows[0].processed_at);

    const replay = await completeUploadIntent(pool, intent.uploadId, artist, { storage });
    assert.equal(replay.mediaObjectId, result.mediaObjectId);
    const outboxAfterReplay = await pool.query('SELECT id FROM platform_outbox WHERE aggregate_id = $1', [intent.trackId]);
    assert.equal(outboxAfterReplay.rows.length, 1);

    const stranger = await seedActor('artist', { storageLimit: 1_000, monthlyLimit: 5 });
    await assert.rejects(completeUploadIntent(pool, intent.uploadId, stranger, { storage }),
      (error) => error.code === 'forbidden' && error.status === 403);
  });

  test('completion rejects missing or mismatched objects without queueing them', async () => {
    const artist = await seedActor('artist', { storageLimit: 1_000, monthlyLimit: 5 });
    const intent = await makeIntent(artist);
    await assert.rejects(completeUploadIntent(pool, intent.uploadId, artist, { storage }),
      (error) => error.code === 'upload_missing' && error.status === 409);

    const row = await pool.query('SELECT object_key FROM upload_intents WHERE id = $1', [intent.uploadId]);
    objects.set(row.rows[0].object_key, { body: Buffer.from('too short'), contentType: 'audio/mp4' });
    await assert.rejects(completeUploadIntent(pool, intent.uploadId, artist, { storage }),
      (error) => error.code === 'upload_mismatch' && error.status === 409);
    const outbox = await pool.query('SELECT id FROM platform_outbox WHERE aggregate_id = $1', [intent.trackId]);
    assert.equal(outbox.rows.length, 0);
  });
});
