import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { runPlatformMigrations } from '../services/api/src/platform/migrations.js';
import { runSqliteImport } from './platform-sqlite-import.mjs';

const MIGRATIONS_DIR = fileURLToPath(new URL('../services/api/src/platform/migrations/', import.meta.url));

function makeStorage() {
  const objects = new Map();
  return {
    bucket: 'vision-private-media',
    async createUploadUrl({ key, contentType, expiresInSeconds }) {
      return { url: `https://upload.storage.test/${encodeURIComponent(key)}?ttl=${expiresInSeconds}`, method: 'PUT', headers: { 'Content-Type': contentType }, expiresInSeconds };
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
      return { sha256: createHash('sha256').update(object.body).digest('hex'), sizeBytes: object.body.length, prefix: object.body.subarray(0, 64) };
    },
    async copyObject({ sourceKey, destinationKey }) {
      const source = objects.get(sourceKey);
      if (!source) throw new Error('synthetic upload source is missing');
      objects.set(destinationKey, { body: Buffer.from(source.body), contentType: source.contentType });
    },
    async deleteObject(key) { objects.delete(key); },
    async putPrivateObject({ key, body, contentType }) {
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, { body: Buffer.concat(chunks), contentType });
    },
    objects,
  };
}

async function makePool() {
  const database = new PGlite({ extensions: { vector } });
  await database.waitReady;
  const query = async (sql, values) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [], rowCount: 0 };
    if (values?.length) return database.query(sql, values);
    const results = await database.exec(sql);
    return results.at(-1) ?? { rows: [] };
  };
  const client = { query, release() {} };
  const pool = { connect: async () => client, query, end: async () => {} };
  await runPlatformMigrations(pool, { directory: MIGRATIONS_DIR });
  return pool;
}

function makeSource(tracks) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vision-sqlite-import-'));
  const mediaDir = path.join(dir, 'media');
  mkdirSync(mediaDir);
  const database = new DatabaseSync(path.join(dir, 'vision.db'));
  database.exec(`CREATE TABLE tracks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL DEFAULT 'Unknown',
    album TEXT, genre TEXT, mime TEXT NOT NULL, ext TEXT NOT NULL,
    size INTEGER NOT NULL, checksum TEXT, created_at TEXT NOT NULL)`);
  const insert = database.prepare(
    'INSERT INTO tracks (id, title, artist, album, genre, mime, ext, size, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const track of tracks) {
    const body = Buffer.from(track.body);
    const checksum = track.checksum ?? createHash('sha256').update(body).digest('hex');
    const fileName = track.fileName ?? `${track.id}.${track.ext}`;
    if (track.writeFile !== false) writeFileSync(path.join(mediaDir, fileName), body);
    insert.run(track.id, track.title, track.artist, track.album ?? null, track.genre ?? null,
      track.mime, track.ext, track.size ?? body.length, checksum, track.createdAt ?? '2026-01-01T00:00:00.000Z');
  }
  database.close();
  return dir;
}

async function makeOwner(pool, role = 'artist') {
  const result = await pool.query(
    'INSERT INTO users (email, display_name, primary_role) VALUES ($1, $2, $3) RETURNING id',
    [`owner-${randomUUID()}@example.test`, 'Import owner', role]);
  const ownerId = result.rows[0].id;
  await pool.query(
    'INSERT INTO user_quotas (user_id, storage_limit_bytes, monthly_upload_limit) VALUES ($1, 1048576, 100)',
    [ownerId]);
  return ownerId;
}

test('dry-run reports eligible tracks without writing to the platform', async () => {
  const pool = await makePool();
  const ownerId = await makeOwner(pool);
  const sourceDir = makeSource([
    { id: 'track-a', title: 'Song A', artist: 'Artist A', mime: 'audio/mpeg', ext: 'mp3', body: 'fake-mp3-bytes-a' },
    { id: 'track-b', title: 'Song B', artist: 'Artist B', mime: 'audio/ogg', ext: 'ogg', body: 'fake-ogg-bytes-b' },
  ]);
  try {
    const report = await runSqliteImport({ sourceDir, ownerId, pool, storage: makeStorage(), apply: false });
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.counts.total, 2);
    assert.equal(report.counts.would_import, 2);
    assert.ok(report.tracks.every((entry) => entry.disposition === 'would_import'));
    assert.ok(report.tracks.every((entry) => entry.sha256 && /^[a-f0-9]{64}$/.test(entry.sha256)));
    const stored = await pool.query('SELECT COUNT(*)::int AS count FROM tracks');
    assert.equal(stored.rows[0].count, 0);
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('apply imports through quarantine ingest and re-runs skip existing tracks', async () => {
  const pool = await makePool();
  const ownerId = await makeOwner(pool);
  const storage = makeStorage();
  const sourceDir = makeSource([
    { id: 'track-a', title: 'Song A', artist: 'Artist A', album: 'Album A', genre: 'Rock', mime: 'audio/mpeg', ext: 'mp3', body: 'fake-mp3-bytes-a' },
    { id: 'track-b', title: 'Song B', artist: 'Artist B', mime: 'audio/ogg', ext: 'ogg', body: 'fake-ogg-bytes-b' },
  ]);
  try {
    const first = await runSqliteImport({ sourceDir, ownerId, pool, storage, apply: true });
    assert.equal(first.counts.imported, 2);
    assert.equal(first.counts.failed, 0);
    const tracks = await pool.query(
      'SELECT id, title, artist_display, album, genre, sha256, status, visibility FROM tracks ORDER BY title');
    assert.equal(tracks.rows.length, 2);
    assert.equal(tracks.rows[0].status, 'quarantine');
    assert.equal(tracks.rows[0].visibility, 'private');
    assert.equal(tracks.rows[0].album, 'Album A');
    assert.equal(tracks.rows[0].genre, 'Rock');
    const media = await pool.query('SELECT object_kind, lifecycle_state FROM media_objects');
    assert.equal(media.rows.length, 2);
    assert.ok(media.rows.every((row) => row.object_kind === 'original' && row.lifecycle_state === 'quarantine'));
    const outbox = await pool.query('SELECT COUNT(*)::int AS count FROM platform_outbox');
    assert.equal(outbox.rows[0].count, 2);
    assert.ok(storage.objects.size >= 2, 'original bytes stored in private storage');

    const second = await runSqliteImport({ sourceDir, ownerId, pool, storage, apply: true });
    assert.equal(second.counts.imported, 0);
    assert.equal(second.counts.already_imported, 2);
    const after = await pool.query('SELECT COUNT(*)::int AS count FROM tracks');
    assert.equal(after.rows[0].count, 2, 're-run must not duplicate tracks');
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('ineligible tracks are skipped with explicit dispositions', async () => {
  const pool = await makePool();
  const ownerId = await makeOwner(pool);
  const goodBody = 'good-bytes';
  const sourceDir = makeSource([
    { id: 'missing', title: 'Missing', artist: 'A', mime: 'audio/mpeg', ext: 'mp3', body: 'x', writeFile: false },
    { id: 'mismatch', title: 'Mismatch', artist: 'A', mime: 'audio/mpeg', ext: 'mp3', body: 'real-bytes', checksum: 'a'.repeat(64) },
    { id: 'badtype', title: 'Bad type', artist: 'A', mime: 'video/mp4', ext: 'mp4', body: 'video-bytes' },
    { id: 'badmeta', title: '', artist: 'A', mime: 'audio/mpeg', ext: 'mp3', body: goodBody },
    { id: 'good', title: 'Good', artist: 'A', mime: 'audio/wav', ext: 'wav', body: goodBody },
  ]);
  try {
    const report = await runSqliteImport({ sourceDir, ownerId, pool, storage: makeStorage(), apply: true });
    const byId = Object.fromEntries(report.tracks.map((entry) => [entry.sourceId, entry.disposition]));
    assert.equal(byId.missing, 'missing_media');
    assert.equal(byId.mismatch, 'checksum_mismatch');
    assert.equal(byId.badtype, 'unsupported_type');
    assert.equal(byId.badmeta, 'invalid_metadata');
    assert.equal(byId.good, 'imported');
    assert.equal(report.counts.imported, 1);
    assert.equal(report.counts.skipped, 4);
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('owner must exist and hold an artist or admin role', async () => {
  const pool = await makePool();
  const sourceDir = makeSource([
    { id: 'track-a', title: 'Song A', artist: 'Artist A', mime: 'audio/mpeg', ext: 'mp3', body: 'bytes' },
  ]);
  try {
    await assert.rejects(
      () => runSqliteImport({ sourceDir, ownerId: 'not-a-uuid', pool, storage: makeStorage() }),
      /--owner must be a user UUID/);
    await assert.rejects(
      () => runSqliteImport({ sourceDir, ownerId: randomUUID(), pool, storage: makeStorage() }),
      /not found/);
    const listenerId = await makeOwner(pool, 'listener');
    await assert.rejects(
      () => runSqliteImport({ sourceDir, ownerId: listenerId, pool, storage: makeStorage() }),
      /must have role artist or admin/);
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
  }
});
