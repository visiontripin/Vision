import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { fileURLToPath } from 'node:url';
import { runPlatformMigrations } from '../src/platform/migrations.js';
import { createPlatformJobProcessor, identifyAudioFormat } from '../src/platform/worker.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/platform/migrations/', import.meta.url));
let database;
let pool;
let ownerId;
let mediaObjects = new Map();
let serial = 0;

const storage = {
  bucket: 'vision-private-media',
  makeMediaKey({ ownerId: owner, trackId, objectId }) { return `media/${owner}/${trackId}/${objectId}`; },
  async hashObject(key, { maxBytes }) {
    const body = mediaObjects.get(key);
    if (!body) return null;
    if (body.length > maxBytes) throw new Error('too large');
    return { sha256: createHash('sha256').update(body).digest('hex'), sizeBytes: body.length, prefix: body.subarray(0, 64) };
  },
  async downloadObjectToFile(key, filePath) { await writeFile(filePath, mediaObjects.get(key)); },
  async putPrivateObject({ key, body }) {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    mediaObjects.set(key, Buffer.concat(chunks));
  },
  async deleteObject(key) { mediaObjects.delete(key); },
};

async function seedTrack(bytes, contentType = 'audio/mpeg') {
  serial += 1;
  const user = await pool.query(`
    INSERT INTO users (email, display_name, primary_role)
    VALUES ($1, $2, 'artist') RETURNING id
  `, [`worker-${serial}@example.test`, `Worker ${serial}`]);
  const owner = user.rows[0].id;
  const track = await pool.query(`
    INSERT INTO tracks (owner_id, title, artist_display, sha256, size_bytes)
    VALUES ($1, $2, 'Worker artist', $3, $4) RETURNING id
  `, [owner, `Worker track ${serial}`, createHash('sha256').update(bytes).digest('hex'), bytes.length]);
  const trackId = track.rows[0].id;
  const media = await pool.query(`
    INSERT INTO media_objects (track_id, object_kind, bucket_name, object_key, sha256, size_bytes, lifecycle_state, content_type)
    VALUES ($1, 'original', $2, $3, $4, $5, 'quarantine', $6) RETURNING id
  `, [trackId, storage.bucket, `media/${owner}/${trackId}/00000000-0000-4000-8000-000000000001`,
    createHash('sha256').update(bytes).digest('hex'), bytes.length, contentType]);
  mediaObjects.set(`media/${owner}/${trackId}/00000000-0000-4000-8000-000000000001`, bytes);
  return { ownerId: owner, trackId, mediaObjectId: media.rows[0].id };
}

const fakeTranscoder = async (_inputPath, { outputDirectory }) => {
  const opusPath = path.join(outputDirectory, 'fake.ogg');
  const aacPath = path.join(outputDirectory, 'fake.m4a');
  const opus = Buffer.from('private opus variant');
  const aac = Buffer.from('private aac variant');
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

before(async () => {
  database = new PGlite({ extensions: { vector } });
  await database.waitReady;
  const query = async (sql, values) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [], rowCount: 0 };
    if (values?.length) return database.query(sql, values);
    const results = await database.exec(sql);
    return results.at(-1) ?? { rows: [] };
  };
  const client = { query, release() {} };
  pool = { connect: async () => client, query };
  await runPlatformMigrations(pool, { directory: MIGRATIONS_DIR });
  const user = await pool.query("INSERT INTO users (email, display_name) VALUES ('worker-owner@example.test', 'Worker owner') RETURNING id");
  ownerId = user.rows[0].id;
});

after(async () => { if (database) await database.close(); });

describe('ingest worker fail-closed lifecycle', () => {
  test('sniffs common audio signatures, not file extensions', () => {
    assert.equal(identifyAudioFormat(Buffer.from('ID3fixture')), 'audio/mpeg');
    assert.equal(identifyAudioFormat(Buffer.from('RIFF0000WAVEfmt ')), 'audio/wav');
    assert.equal(identifyAudioFormat(Buffer.from('OggSfixture')), 'audio/ogg');
    assert.equal(identifyAudioFormat(Buffer.from('fLaCfixture')), 'audio/flac');
    assert.equal(identifyAudioFormat(Buffer.from('0000ftypM4A ')), 'audio/mp4');
    assert.equal(identifyAudioFormat(Buffer.from('not an audio file')), null);
  });

  test('transcodes privately, records an unconfigured fingerprint status, and never publishes automatically', async () => {
    const input = Buffer.from('ID3fixture; valid-shaped test bytes');
    const track = await seedTrack(input);
    const processor = createPlatformJobProcessor({ pool, storage, transcoder: fakeTranscoder });
    const job = { name: 'ingest.requested', data: { trackId: track.trackId, mediaObjectId: track.mediaObjectId } };
    const result = await processor(job);
    assert.equal(result.status, 'quarantine_ready');
    assert.equal(result.fingerprint, 'not_configured');

    const row = await pool.query('SELECT status, visibility, fingerprint FROM tracks WHERE id = $1', [track.trackId]);
    assert.equal(row.rows[0].status, 'quarantine');
    assert.equal(row.rows[0].visibility, 'private');
    assert.equal(row.rows[0].fingerprint.ingestComplete, true);
    assert.equal(row.rows[0].fingerprint.status, 'not_configured');
    const variants = await pool.query(`
      SELECT tv.codec, m.lifecycle_state, m.content_type
      FROM track_variants tv JOIN media_objects m ON m.id = tv.media_object_id
      WHERE tv.track_id = $1 ORDER BY tv.codec
    `, [track.trackId]);
    assert.deepEqual(variants.rows, [
      { codec: 'aac', lifecycle_state: 'quarantine', content_type: 'audio/mp4' },
      { codec: 'opus', lifecycle_state: 'quarantine', content_type: 'audio/ogg' },
    ]);
    const moderation = await pool.query('SELECT id FROM moderation_queue WHERE track_id = $1', [track.trackId]);
    assert.equal(moderation.rows.length, 0, 'explicit owner rights submission is required before moderation');
    const replay = await processor(job);
    assert.equal(replay.status, 'already_processed');
    const variantsAfterReplay = await pool.query('SELECT id FROM track_variants WHERE track_id = $1', [track.trackId]);
    assert.equal(variantsAfterReplay.rows.length, 2);
  });

  test('invalid media is rejected privately and queued for deletion, never moderation or publication', async () => {
    const track = await seedTrack(Buffer.from('this is not an audio file'));
    const processor = createPlatformJobProcessor({ pool, storage, transcoder: fakeTranscoder });
    const result = await processor({
      name: 'ingest.requested', data: { trackId: track.trackId, mediaObjectId: track.mediaObjectId },
    });
    assert.equal(result.status, 'rejected_format');
    const row = await pool.query('SELECT status, visibility FROM tracks WHERE id = $1', [track.trackId]);
    assert.deepEqual(row.rows[0], { status: 'rejected', visibility: 'private' });
    const outbox = await pool.query("SELECT topic FROM platform_outbox WHERE aggregate_id = $1", [track.trackId]);
    assert.deepEqual(outbox.rows, [{ topic: 'media.delete.requested' }]);
    const publicTracks = await pool.query("SELECT id FROM tracks WHERE id = $1 AND visibility = 'public'", [track.trackId]);
    assert.equal(publicTracks.rows.length, 0);
  });
});
