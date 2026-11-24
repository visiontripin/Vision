import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createPlatformStorage, createS3Storage } from '../src/platform/storage.js';

const ownerId = '14e5fbed-3547-4c4e-b94c-4249e008fddb';
const trackId = '24e5fbed-3547-4c4e-b94c-4249e008fddb';
const objectId = '34e5fbed-3547-4c4e-b94c-4249e008fddb';
const validOptions = {
  bucket: 'vision-private-media',
  endpoint: 'http://storage.internal:9000',
  publicEndpoint: 'http://127.0.0.1:9001',
  accessKeyId: 'local-access-key',
  secretAccessKey: 'local-secret-key-long-enough',
};

function fakeClient(send) {
  return { send, destroy() {} };
}

describe('S3-compatible private storage adapter', () => {
  test('requires explicit S3 endpoint and credentials; does not use ambient cloud credentials', () => {
    assert.throws(() => createPlatformStorage({}), /PLATFORM_S3_ENDPOINT and PLATFORM_S3_BUCKET/);
    assert.throws(() => createS3Storage({ ...validOptions, accessKeyId: '' }), /credentials are required/);
    assert.throws(() => createS3Storage({ ...validOptions, endpoint: 'file:///tmp/media' }), /HTTP\(S\) URL/);
    assert.throws(() => createS3Storage({ ...validOptions, bucket: 'Bad_Bucket' }), /DNS-style bucket/);
  });

  test('managed keys stay under opaque private prefixes and do not accept path traversal', async () => {
    const storage = createS3Storage({ ...validOptions, client: fakeClient(async () => ({})), signer: async () => 'signed' });
    assert.equal(storage.makeQuarantineKey({ ownerId, trackId, intentId: objectId }), `quarantine/${ownerId}/${trackId}/${objectId}`);
    assert.equal(storage.makeMediaKey({ ownerId, trackId, objectId }), `media/${ownerId}/${trackId}/${objectId}`);
    await assert.rejects(storage.createDownloadUrl({ key: `../${ownerId}/${trackId}/${objectId}` }), /managed private prefixes/);
    await assert.rejects(storage.deleteObject(`quarantine/${ownerId}/${trackId}/../`), /managed private prefixes/);
    await storage.close();
  });

  test('signed uploads are short lived and do not request a public ACL', async () => {
    const calls = [];
    const storage = createS3Storage({
      ...validOptions,
      client: fakeClient(async (command) => { calls.push(command); return {}; }),
      presignClient: fakeClient(async () => ({})),
      signer: async (_client, command, { expiresIn }) => {
        calls.push(command);
        assert.equal(expiresIn, 300);
        return 'http://127.0.0.1:9001/vision-private-media/object?signature=redacted';
      },
    });
    const key = storage.makeQuarantineKey({ ownerId, trackId, intentId: objectId });
    const signed = await storage.createUploadUrl({ key, contentType: 'audio/mpeg', expiresInSeconds: 300 });
    assert.equal(signed.method, 'PUT');
    assert.deepEqual(signed.headers, { 'Content-Type': 'audio/mpeg' });
    assert.match(signed.url, /^http:\/\/127\.0\.0\.1:9001\//);
    const put = calls.find((command) => command instanceof PutObjectCommand);
    assert.ok(put);
    assert.equal(put.input.ACL, undefined);
    await assert.rejects(storage.createUploadUrl({ key, contentType: 'audio/mpeg', expiresInSeconds: 901 }), /lifetime/);
    await storage.close();
  });

  test('bucket creation, object metadata, hash, copy and delete use private S3 commands', async () => {
    const calls = [];
    const object = Buffer.from('small audio test bytes');
    const client = fakeClient(async (command) => {
      calls.push(command);
      if (command instanceof HeadBucketCommand) {
        const error = new Error('missing'); error.name = 'NotFound'; error.$metadata = { httpStatusCode: 404 }; throw error;
      }
      if (command instanceof HeadObjectCommand) return { ContentLength: object.length, ContentType: 'audio/mpeg', ETag: '"etag"' };
      if (command instanceof GetObjectCommand) return { Body: Readable.from([object.subarray(0, 7), object.subarray(7)]) };
      return {};
    });
    const storage = createS3Storage({ ...validOptions, client, signer: async () => 'signed' });
    await storage.ensureBucket();
    const key = storage.makeQuarantineKey({ ownerId, trackId, intentId: objectId });
    const head = await storage.headObject(key);
    assert.equal(head.sizeBytes, object.length);
    assert.equal(head.contentType, 'audio/mpeg');
    const prefix = await storage.readPrefix(key, 7);
    assert.deepEqual(prefix, object.subarray(0, 7));
    const hash = await storage.hashObject(key);
    assert.equal(hash.sizeBytes, object.length);
    assert.equal(hash.sha256, 'd6f2a83c9aa700d18f81398a4ec41b93a734e2ecd8321dcf25d8a1b259c11118');

    const mediaKey = storage.makeMediaKey({ ownerId, trackId, objectId });
    await storage.copyObject({ sourceKey: key, destinationKey: mediaKey });
    await storage.deleteObject(key);
    assert.ok(calls.some((command) => command instanceof CreateBucketCommand));
    const copy = calls.find((command) => command instanceof CopyObjectCommand);
    assert.match(copy.input.CopySource, /^vision-private-media\/quarantine\//);
    assert.equal(copy.input.ACL, undefined);
    assert.ok(calls.some((command) => command instanceof DeleteObjectCommand));
    await storage.close();
  });

  test('bucket readiness probe does not create a missing bucket', async () => {
    let missing = false;
    let createAttempts = 0;
    const client = fakeClient(async (command) => {
      if (command instanceof HeadBucketCommand && missing) {
        const error = new Error('missing'); error.name = 'NotFound'; error.$metadata = { httpStatusCode: 404 }; throw error;
      }
      if (command instanceof CreateBucketCommand) createAttempts += 1;
      return {};
    });
    const storage = createS3Storage({ ...validOptions, client, signer: async () => 'signed' });
    assert.equal(await storage.checkBucket(), true);
    missing = true;
    await assert.rejects(storage.checkBucket(), (error) => error.name === 'NotFound');
    assert.equal(createAttempts, 0);
    await storage.close();
  });
});
