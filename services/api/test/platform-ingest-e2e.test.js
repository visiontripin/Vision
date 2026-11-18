import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { createPlatformServer } from '../src/platform/server.js';
import { createInMemoryRateLimiter } from '../src/platform/rate-limit.js';
import { runPlatformMigrations } from '../src/platform/migrations.js';
import { issueAccessToken } from '../src/platform/auth-crypto.js';
import { dispatchPlatformOutbox } from '../src/platform/outbox.js';
import { createPlatformJobProcessor } from '../src/platform/worker.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/platform/migrations/', import.meta.url));
const AUTH_SECRET = 'platform-pipeline-e2e-secret-with-at-least-32-bytes';

function makeStorage() {
  const objects = new Map();
  const uploadKeys = new Map();
  return {
    bucket: 'vision-private-media',
    async createUploadUrl({ key, contentType, expiresInSeconds }) {
      const url = `https://upload.storage.test/${encodeURIComponent(key)}?ttl=${expiresInSeconds}`;
      uploadKeys.set(url, key);
      return { url, method: 'PUT', headers: { 'Content-Type': contentType }, expiresInSeconds };
    },
    async putSignedUpload(upload, body) {
      const key = uploadKeys.get(upload.url);
      assert.ok(key, 'the simulated client can only PUT to a URL issued by the storage adapter');
      objects.set(key, { body: Buffer.from(body), contentType: upload.headers['Content-Type'] });
    },
    makeQuarantineKey({ ownerId, trackId, intentId = randomUUID() }) {
      return `quarantine/${ownerId}/${trackId}/${intentId}`;
    },
    makeMediaKey({ ownerId, trackId, objectId = randomUUID() }) {
      return `media/${ownerId}/${trackId}/${objectId}`;
    },
    async headObject(key) {
      const object = objects.get(key);
      return object ? { sizeBytes: object.body.length, contentType: object.contentType, etag: 'synthetic' } : null;
    },
    async hashObject(key, { maxBytes }) {
      const object = objects.get(key);
      if (!object) return null;
      if (object.body.length > maxBytes) throw new Error('synthetic object exceeds configured limit');
      return {
        sha256: createHash('sha256').update(object.body).digest('hex'),
        sizeBytes: object.body.length,
        prefix: object.body.subarray(0, 64),
      };
    },
    async copyObject({ sourceKey, destinationKey }) {
      const source = objects.get(sourceKey);
      if (!source) throw new Error('synthetic upload source is missing');
      objects.set(destinationKey, { body: Buffer.from(source.body), contentType: source.contentType });
    },
    async deleteObject(key) { objects.delete(key); },
    async downloadObjectToFile(key, filePath) {
      const object = objects.get(key);
      if (!object) throw new Error('synthetic media object is missing');
      await writeFile(filePath, object.body);
    },
    async putPrivateObject({ key, body, contentType }) {
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, { body: Buffer.concat(chunks), contentType });
    },
    async createDownloadUrl({ key, contentType, expiresInSeconds }) {
      assert.ok(objects.has(key), 'only an object that exists in private storage receives a playback URL');
      return `https://media.storage.test/${encodeURIComponent(key)}?type=${encodeURIComponent(contentType)}&ttl=${expiresInSeconds}`;
    },
    objects,
  };
}

async function apiRequest(base, pathname, { method = 'GET', body, token, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

test('HTTP upload completes the private pipeline through explicit moderation to publication', async () => {
  const database = new PGlite({ extensions: { vector } });
  await database.waitReady;
  const query = async (sql, values) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [], rowCount: 0 };
    if (values?.length) return database.query(sql, values);
    const results = await database.exec(sql);
    return results.at(-1) ?? { rows: [] };
  };
  const client = { query, release() {} };
  const pool = { connect: async () => client, query };
  await runPlatformMigrations(pool, { directory: MIGRATIONS_DIR });

  const artistRow = await pool.query(`
    INSERT INTO users (email, display_name, primary_role)
    VALUES ('pipeline-artist@example.test', 'Pipeline artist', 'artist') RETURNING id
  `);
  const moderatorRow = await pool.query(`
    INSERT INTO users (email, display_name, primary_role)
    VALUES ('pipeline-moderator@example.test', 'Pipeline moderator', 'moderator') RETURNING id
  `);
  const artistId = artistRow.rows[0].id;
  const moderatorId = moderatorRow.rows[0].id;
  await pool.query(`
    INSERT INTO user_quotas (user_id, storage_limit_bytes, monthly_upload_limit)
    VALUES ($1, 1048576, 5)
  `, [artistId]);

  const artistToken = issueAccessToken(artistId, AUTH_SECRET).token;
  const moderatorToken = issueAccessToken(moderatorId, AUTH_SECRET).token;
  const storage = makeStorage();
  const rateLimiter = createInMemoryRateLimiter({ secret: AUTH_SECRET });
  const server = createPlatformServer({
    pool,
    secret: AUTH_SECRET,
    registrationEnabled: false,
    uploadsEnabled: true,
    maxUploadBytes: 1024 * 1024,
    storage,
    rateLimiter,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const audioBytes = Buffer.from('ID3 synthetic audio fixture for the isolated pipeline');
    const intent = await apiRequest(base, '/api/v2/uploads', {
      method: 'POST',
      token: artistToken,
      headers: { 'idempotency-key': 'pipeline-e2e-upload-1' },
      body: {
        title: 'Closed-loop demo',
        artistDisplay: 'Synthetic artist',
        contentType: 'audio/mpeg',
        sizeBytes: audioBytes.length,
      },
    });
    assert.equal(intent.response.status, 201);
    assert.equal(intent.body.status, 'pending');
    assert.equal(intent.body.upload.method, 'PUT');

    const initial = await pool.query('SELECT status, visibility FROM tracks WHERE id = $1', [intent.body.trackId]);
    assert.deepEqual(initial.rows[0], { status: 'quarantine', visibility: 'private' });
    await storage.putSignedUpload(intent.body.upload, audioBytes);

    const complete = await apiRequest(base, `/api/v2/uploads/${intent.body.uploadId}/complete`, {
      method: 'POST', token: artistToken,
    });
    assert.equal(complete.response.status, 200);
    assert.equal(complete.body.status, 'queued');

    const outboxBeforeDispatch = await pool.query(
      'SELECT topic FROM platform_outbox WHERE aggregate_id = $1', [intent.body.trackId],
    );
    assert.deepEqual(outboxBeforeDispatch.rows, [{ topic: 'ingest.requested' }]);
    const queued = [];
    const relay = await dispatchPlatformOutbox(pool, {
      async add(name, payload, options) {
        queued.push({ name, payload, options });
        return { id: options.jobId };
      },
    });
    assert.deepEqual(relay, { dispatched: 1, retried: 0, deadLettered: 0 });
    assert.equal(queued[0].name, 'ingest.requested');

    const fakeTranscoder = async (_inputPath, { outputDirectory }) => {
      const opusPath = path.join(outputDirectory, 'pipeline.ogg');
      const aacPath = path.join(outputDirectory, 'pipeline.m4a');
      const opus = Buffer.from('synthetic opus output');
      const aac = Buffer.from('synthetic aac output');
      await writeFile(opusPath, opus);
      await writeFile(aacPath, aac);
      return {
        variants: [
          { codec: 'opus', contentType: 'audio/ogg', bitrateKbps: 96, path: opusPath, sizeBytes: opus.length },
          { codec: 'aac', contentType: 'audio/mp4', bitrateKbps: 128, path: aacPath, sizeBytes: aac.length },
        ],
        async cleanup() {},
      };
    };
    const processJob = createPlatformJobProcessor({ pool, storage, transcoder: fakeTranscoder, maxUploadBytes: 1024 * 1024 });
    const ingested = await processJob({ name: queued[0].name, data: queued[0].payload });
    assert.equal(ingested.status, 'quarantine_ready');
    assert.equal(ingested.fingerprint, 'not_configured');

    const quarantined = await pool.query(`
      SELECT t.status, t.visibility, t.fingerprint->>'status' AS fingerprint_status,
        t.fingerprint->>'ingestComplete' AS ingest_complete,
        count(m.id)::int AS media_objects,
        bool_and(m.lifecycle_state = 'quarantine') AS all_private_quarantine
      FROM tracks t JOIN media_objects m ON m.track_id = t.id
      WHERE t.id = $1 GROUP BY t.id
    `, [intent.body.trackId]);
    assert.deepEqual(quarantined.rows[0], {
      status: 'quarantine', visibility: 'private', fingerprint_status: 'not_configured',
      ingest_complete: 'true', media_objects: 3, all_private_quarantine: true,
    });
    const beforeSubmission = await apiRequest(base, '/api/v2/catalog');
    assert.equal(beforeSubmission.body.total, 0, 'ingest and fingerprint completion never auto-publish');
    const emptyQueue = await apiRequest(base, '/api/v2/moderation/queue', { token: moderatorToken });
    assert.equal(emptyQueue.body.items.length, 0, 'owner rights confirmation is required before moderation');

    const submission = await apiRequest(base, `/api/v2/tracks/${intent.body.trackId}/publish`, {
      method: 'POST',
      token: artistToken,
      body: { rightsConfirmed: true, offerVersion: 'synthetic-owner-offer-v1' },
    });
    assert.equal(submission.response.status, 202);
    assert.equal(submission.body.status, 'in_review');
    assert.equal(submission.body.visibility, 'private');

    const moderationQueue = await apiRequest(base, '/api/v2/moderation/queue', { token: moderatorToken });
    assert.equal(moderationQueue.body.items.length, 1);
    const moderationId = moderationQueue.body.items[0].id;
    const approval = await apiRequest(base, `/api/v2/moderation/${moderationId}/decision`, {
      method: 'POST',
      token: moderatorToken,
      body: { decision: 'approve', reason: 'Synthetic closed-loop acceptance fixture.' },
    });
    assert.equal(approval.response.status, 200);
    assert.equal(approval.body.status, 'approved');

    const catalog = await apiRequest(base, '/api/v2/catalog');
    assert.equal(catalog.body.total, 1);
    assert.equal(catalog.body.items[0].id, intent.body.trackId);
    const published = await pool.query(`
      SELECT t.status, t.visibility, m.lifecycle_state
      FROM tracks t JOIN media_objects m ON m.track_id = t.id AND m.object_kind = 'original'
      WHERE t.id = $1
    `, [intent.body.trackId]);
    assert.deepEqual(published.rows[0], { status: 'published', visibility: 'public', lifecycle_state: 'ready' });

    const playback = await apiRequest(base, `/api/v2/tracks/${intent.body.trackId}/media`);
    assert.equal(playback.response.status, 200);
    assert.match(playback.body.url, /^https:\/\/media\.storage\.test\//);
    assert.equal(playback.body.cacheControl, 'private, no-store');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rateLimiter.close?.();
    await database.close();
  }
});
