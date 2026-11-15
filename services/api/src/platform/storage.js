// @ts-check
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_KEY = /^(quarantine|media)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PRESIGN_SECONDS = 15 * 60;

function notFound(error) {
  return error?.name === 'NotFound'
    || error?.name === 'NoSuchKey'
    || error?.$metadata?.httpStatusCode === 404;
}

function validateObjectKey(key) {
  if (typeof key !== 'string' || !OBJECT_KEY.test(key)) {
    throw new Error('Object key is outside the platform-managed private prefixes.');
  }
  return key;
}

function makeS3Client({ endpoint, region, accessKeyId, secretAccessKey }) {
  return new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 3,
  });
}

/**
 * Build a provider-neutral S3-compatible storage adapter. It never sets a public
 * ACL; quarantine objects are private and can only be accessed with short-lived
 * presigned URLs. `publicEndpoint` exists only for local reverse/port mappings:
 * it must route to the same bucket and credentials as the internal endpoint.
 *
 * @param {{bucket: string, endpoint: string, publicEndpoint?: string, region?: string,
 *   accessKeyId: string, secretAccessKey: string, client?: import('@aws-sdk/client-s3').S3Client,
 *   presignClient?: import('@aws-sdk/client-s3').S3Client, signer?: (...args: any[]) => Promise<string>}} options
 */
export function createS3Storage({
  bucket,
  endpoint,
  publicEndpoint,
  region = 'us-east-1',
  accessKeyId,
  secretAccessKey,
  client,
  presignClient,
  signer = getSignedUrl,
}) {
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error('PLATFORM_S3_BUCKET must be a valid DNS-style bucket name.');
  }
  for (const [name, value] of [['endpoint', endpoint], ['publicEndpoint', publicEndpoint]]) {
    if (value === undefined) continue;
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error(`${name} must be an absolute HTTP(S) URL.`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`${name} must be an absolute HTTP(S) URL without credentials, query, or fragment.`);
    }
  }
  if (!endpoint) throw new Error('PLATFORM_S3_ENDPOINT is required.');
  if (!accessKeyId || !secretAccessKey) throw new Error('Platform S3 credentials are required.');

  const internalClient = client || makeS3Client({ endpoint, region, accessKeyId, secretAccessKey });
  const signedClient = presignClient || (publicEndpoint && publicEndpoint !== endpoint
    ? makeS3Client({ endpoint: publicEndpoint, region, accessKeyId, secretAccessKey })
    : internalClient);

  async function sign(command, expiresIn) {
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_PRESIGN_SECONDS) {
      throw new Error(`Presigned URL lifetime must be between 1 and ${MAX_PRESIGN_SECONDS} seconds.`);
    }
    return signer(signedClient, command, { expiresIn });
  }

  return Object.freeze({
    bucket,
    async ensureBucket() {
      try {
        await internalClient.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== 'NotFound' && error?.name !== 'NoSuchBucket') throw error;
        try {
          await internalClient.send(new CreateBucketCommand({ Bucket: bucket }));
        } catch (createError) {
          if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(createError?.name)) throw createError;
        }
      }
    },
    makeQuarantineKey({ ownerId, trackId, intentId = randomUUID() }) {
      if (![ownerId, trackId, intentId].every((id) => typeof id === 'string' && UUID.test(id))) {
        throw new Error('A valid owner, track, and upload intent id are required.');
      }
      return validateObjectKey(`quarantine/${ownerId}/${trackId}/${intentId}`);
    },
    makeMediaKey({ ownerId, trackId, objectId = randomUUID() }) {
      if (![ownerId, trackId, objectId].every((id) => typeof id === 'string' && UUID.test(id))) {
        throw new Error('A valid owner, track, and media object id are required.');
      }
      return validateObjectKey(`media/${ownerId}/${trackId}/${objectId}`);
    },
    async createUploadUrl({ key, contentType, expiresInSeconds = 300 }) {
      validateObjectKey(key);
      if (typeof contentType !== 'string' || !/^audio\/[a-z0-9.+-]{1,64}$/i.test(contentType)) {
        throw new Error('Only an audio content type can be signed for upload.');
      }
      const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
      return {
        url: await sign(command, expiresInSeconds),
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        expiresInSeconds,
      };
    },
    async createDownloadUrl({ key, contentType = 'application/octet-stream', expiresInSeconds = 60 }) {
      validateObjectKey(key);
      if (typeof contentType !== 'string' || contentType.length > 128) throw new Error('Invalid response content type.');
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseCacheControl: 'private, no-store',
        ResponseContentType: contentType,
        ResponseContentDisposition: 'inline',
      });
      return sign(command, expiresInSeconds);
    },
    async headObject(key) {
      validateObjectKey(key);
      try {
        const result = await internalClient.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          sizeBytes: result.ContentLength ?? 0,
          contentType: result.ContentType ?? null,
          etag: result.ETag ?? null,
          lastModified: result.LastModified ?? null,
        };
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async readPrefix(key, bytes = 64) {
      validateObjectKey(key);
      if (!Number.isInteger(bytes) || bytes < 1 || bytes > 4096) throw new Error('Prefix size must be between 1 and 4096 bytes.');
      const result = await internalClient.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=0-${bytes - 1}`,
      }));
      if (!result.Body) return Buffer.alloc(0);
      const source = /** @type {AsyncIterable<Uint8Array> & {destroy?: () => void}} */ (/** @type {unknown} */ (result.Body));
      const chunks = [];
      let size = 0;
      for await (const chunk of source) {
        const part = Buffer.from(chunk).subarray(0, bytes - size);
        if (part.length) chunks.push(part);
        size += part.length;
        if (size >= bytes) {
          source.destroy?.();
          break;
        }
      }
      return Buffer.concat(chunks, size);
    },
    async downloadObjectToFile(key, filePath, { maxBytes = 200 * 1024 * 1024 } = {}) {
      validateObjectKey(key);
      const head = await internalClient.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (!Number.isSafeInteger(Number(head.ContentLength)) || Number(head.ContentLength) > maxBytes) {
        throw new Error('Stored object exceeds the configured upload size limit.');
      }
      const result = await internalClient.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!result.Body) throw new Error('Stored object has no body.');
      const source = /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (result.Body));
      await pipeline(source, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
      return { sizeBytes: Number(head.ContentLength), contentType: head.ContentType ?? null };
    },
    async putPrivateObject({ key, body, contentType, contentLength }) {
      validateObjectKey(key);
      if (!/^audio\/[a-z0-9.+-]{1,64}$/i.test(contentType) || !Number.isSafeInteger(contentLength) || contentLength < 1) {
        throw new Error('Private audio object requires a valid content type and length.');
      }
      await internalClient.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: contentLength,
      }));
    },
    async hashObject(key, { maxBytes = 200 * 1024 * 1024 } = {}) {
      validateObjectKey(key);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive safe integer.');
      let result;
      try {
        result = await internalClient.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
      if (!result.Body) return null;
      const hash = createHash('sha256');
      const prefixChunks = [];
      let prefixLength = 0;
      let sizeBytes = 0;
      const source = /** @type {AsyncIterable<Uint8Array> & {destroy?: () => void}} */ (/** @type {unknown} */ (result.Body));
      for await (const chunk of source) {
        const bytes = Buffer.from(chunk);
        sizeBytes += bytes.length;
        if (sizeBytes > maxBytes) {
          source.destroy?.();
          throw new Error('Stored object exceeds the configured upload size limit.');
        }
        if (prefixLength < 64) {
          const prefixPart = bytes.subarray(0, 64 - prefixLength);
          prefixChunks.push(prefixPart);
          prefixLength += prefixPart.length;
        }
        hash.update(bytes);
      }
      return { sha256: hash.digest('hex'), sizeBytes, prefix: Buffer.concat(prefixChunks) };
    },
    async copyObject({ sourceKey, destinationKey }) {
      validateObjectKey(sourceKey);
      validateObjectKey(destinationKey);
      const source = `${encodeURIComponent(bucket)}/${sourceKey.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
      await internalClient.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: destinationKey,
        CopySource: source,
        MetadataDirective: 'COPY',
      }));
    },
    async deleteObject(key) {
      validateObjectKey(key);
      await internalClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async close() {
      const clients = new Set([internalClient, signedClient]);
      for (const instance of clients) instance.destroy();
    },
  });
}

/** @typedef {ReturnType<typeof createS3Storage>} PlatformStorage */

/** Resolve configuration explicitly; never fall back to ambient AWS provider chains. */
export function createPlatformStorage(env = process.env) {
  if (!env.PLATFORM_S3_ENDPOINT || !env.PLATFORM_S3_BUCKET) {
    throw new Error('PLATFORM_S3_ENDPOINT and PLATFORM_S3_BUCKET are required when storage is enabled.');
  }
  return createS3Storage({
    bucket: env.PLATFORM_S3_BUCKET,
    endpoint: env.PLATFORM_S3_ENDPOINT,
    publicEndpoint: env.PLATFORM_S3_PUBLIC_ENDPOINT || undefined,
    region: env.PLATFORM_S3_REGION || 'us-east-1',
    accessKeyId: env.PLATFORM_S3_ACCESS_KEY_ID || '',
    secretAccessKey: env.PLATFORM_S3_SECRET_ACCESS_KEY || '',
  });
}
