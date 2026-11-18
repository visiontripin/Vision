import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restorePlatformBackup, verifyPlatformBackup } from './platform-local-data.mjs';

const BUCKET = 'vision-media';
const OBJECT_KEY = 'media/12345678-1234-4234-8234-123456789012/22345678-1234-4234-8234-123456789012/32345678-1234-4234-8234-123456789012';

function digest(bytes) {
  return { sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function makeBundle() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vision-platform-backup-test-'));
  const objects = path.join(root, 'objects', ...OBJECT_KEY.split('/').slice(0, -1));
  mkdirSync(objects, { recursive: true });
  const database = Buffer.from('fake-pg-custom-archive');
  const redis = Buffer.from('fake-redis-rdb');
  const media = Buffer.from('synthetic audio bytes');
  writeFileSync(path.join(root, 'database.dump'), database);
  writeFileSync(path.join(root, 'redis.rdb'), redis);
  writeFileSync(path.join(objects, OBJECT_KEY.split('/').at(-1)), media);
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    platform: 'vision-platform-local',
    createdAt: new Date().toISOString(),
    bucket: BUCKET,
    database: { file: 'database.dump', format: 'pg_dump-custom', databaseName: 'vision_platform', ...digest(database) },
    redis: { file: 'redis.rdb', format: 'redis-rdb', ...digest(redis) },
    objects: {
      directory: 'objects',
      count: 1,
      totalBytes: media.length,
      files: [{ key: OBJECT_KEY, ...digest(media) }],
    },
  }));
  return root;
}

test('backup verifier accepts a complete, hash-matching PostgreSQL/Redis/S3 bundle', async () => {
  const root = makeBundle();
  try {
    const manifest = await verifyPlatformBackup(root, BUCKET);
    await assert.rejects(verifyPlatformBackup(root, BUCKET, 'other_database'), /database manifest entry is invalid/);
    assert.equal(manifest.objects.count, 1);
    assert.equal(manifest.database.format, 'pg_dump-custom');
    assert.equal(manifest.redis.format, 'redis-rdb');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore command requires the explicit destructive confirmation before inspection', async () => {
  await assert.rejects(restorePlatformBackup('not-a-real-backup'), /--confirm/);
});

test('backup verifier rejects a changed dump, wrong bucket and unsafe object path before restore', async () => {
  const root = makeBundle();
  try {
    await assert.rejects(verifyPlatformBackup(root, 'other-bucket'), /does not match/);
    writeFileSync(path.join(root, 'database.dump'), 'tampered');
    await assert.rejects(verifyPlatformBackup(root, BUCKET), /integrity verification/);

    const manifestPath = path.join(root, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.database = { file: 'database.dump', format: 'pg_dump-custom', databaseName: 'vision_platform', ...digest(Buffer.from('tampered')) };
    manifest.objects.files[0].key = '../../outside';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await assert.rejects(verifyPlatformBackup(root, BUCKET), /invalid or duplicate object/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
