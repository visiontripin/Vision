import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPlatformStorage } from '../src/platform/storage.js';

const STORAGE_CONFIGURED = Boolean(
  process.env.PLATFORM_S3_ENDPOINT
  && process.env.PLATFORM_S3_BUCKET
  && process.env.PLATFORM_S3_ACCESS_KEY_ID
  && process.env.PLATFORM_S3_SECRET_ACCESS_KEY,
);

test('real S3-compatible storage keeps objects private and signs bounded upload/download URLs', {
  skip: !STORAGE_CONFIGURED && 'Set PLATFORM_S3_* variables to run against MinIO or another S3-compatible test backend.',
}, async () => {
  const storage = createPlatformStorage();
  const ownerId = randomUUID();
  const trackId = randomUUID();
  const intentId = randomUUID();
  const uploadKey = storage.makeQuarantineKey({ ownerId, trackId, intentId });
  const mediaKey = storage.makeMediaKey({ ownerId, trackId, objectId: intentId });
  const payload = Buffer.from('ID3 private MinIO integration object');
  try {
    await storage.ensureBucket();
    const signedUpload = await storage.createUploadUrl({
      key: uploadKey, contentType: 'audio/mpeg', expiresInSeconds: 300,
    });
    const upload = await fetch(signedUpload.url, {
      method: signedUpload.method,
      headers: signedUpload.headers,
      body: payload,
    });
    assert.equal(upload.status, 200);

    const head = await storage.headObject(uploadKey);
    assert.equal(head.sizeBytes, payload.length);
    assert.equal(head.contentType, 'audio/mpeg');
    const integrity = await storage.hashObject(uploadKey, { maxBytes: payload.length });
    assert.ok(integrity);
    assert.equal(integrity.sizeBytes, payload.length);
    assert.equal(integrity.prefix.toString(), payload.subarray(0, 64).toString());

    const unsigned = await fetch(`${process.env.PLATFORM_S3_ENDPOINT}/${storage.bucket}/${uploadKey}`);
    assert.equal(unsigned.ok, false, 'bucket objects must not be anonymously readable');
    const signedDownloadUrl = await storage.createDownloadUrl({ key: uploadKey, contentType: 'audio/mpeg', expiresInSeconds: 30 });
    const downloaded = await fetch(signedDownloadUrl);
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get('cache-control') || '', /private, no-store/i);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), payload);

    await storage.copyObject({ sourceKey: uploadKey, destinationKey: mediaKey });
    assert.equal((await storage.headObject(mediaKey)).sizeBytes, payload.length);
    await storage.deleteObject(uploadKey);
    assert.equal(await storage.headObject(uploadKey), null);
    await storage.deleteObject(mediaKey);
    assert.equal(await storage.headObject(mediaKey), null);
  } finally {
    await storage.deleteObject(uploadKey).catch(() => {});
    await storage.deleteObject(mediaKey).catch(() => {});
    await storage.close();
  }
});
