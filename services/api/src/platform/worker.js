// @ts-check
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UnrecoverableError } from 'bullmq';
import { UnconfiguredFingerprintAdapter, requireFingerprintAdapter } from './fingerprint.js';
import { transcodeAudioFile } from './transcode.js';

const MAGIC = [
  { name: 'mp3', mime: 'audio/mpeg', check: (b) => (b.subarray(0, 3).toString('ascii') === 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { name: 'wav', mime: 'audio/wav', check: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WAVE' },
  { name: 'ogg', mime: 'audio/ogg', check: (b) => b.subarray(0, 4).toString('ascii') === 'OggS' },
  { name: 'flac', mime: 'audio/flac', check: (b) => b.subarray(0, 4).toString('ascii') === 'fLaC' },
  { name: 'mp4', mime: 'audio/mp4', check: (b) => b.length >= 8 && b.subarray(4, 8).toString('ascii') === 'ftyp' },
  { name: 'webm', mime: 'audio/webm', check: (b) => b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  { name: 'aac', mime: 'audio/aac', check: (b) => b.length >= 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0 },
];

/** Inspect media bytes, never trust the client-declared extension or Content-Type. */
export function identifyAudioFormat(prefix) {
  const bytes = Buffer.from(prefix || []);
  return MAGIC.find((entry) => entry.check(bytes))?.mime ?? null;
}

function contentTypeMatches(declared, actual) {
  if (actual === 'audio/ogg') return ['audio/ogg', 'audio/opus'].includes(declared);
  if (actual === 'audio/wav') return ['audio/wav', 'audio/x-wav'].includes(declared);
  return actual === declared;
}

function deterministicUuid(value) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.from(chunk);
    sizeBytes += bytes.length;
    hash.update(bytes);
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

async function transaction(pool, work) {
  const client = await pool.connect();
  let started = false;
  try {
    await client.query('BEGIN');
    started = true;
    const result = await work(client);
    await client.query('COMMIT');
    started = false;
    return result;
  } catch (error) {
    if (started) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function permanent(message, code) {
  return Object.assign(new UnrecoverableError(message), { code });
}

async function rejectInvalidMedia(pool, row, reason) {
  await transaction(pool, async (client) => {
    const locked = await client.query('SELECT status FROM tracks WHERE id = $1 FOR UPDATE', [row.track_id]);
    if (!locked.rows[0] || locked.rows[0].status !== 'quarantine') return;
    await client.query(`UPDATE tracks SET status = 'rejected', visibility = 'private', published_at = NULL WHERE id = $1`, [row.track_id]);
    await client.query(`UPDATE media_objects SET lifecycle_state = 'pending_delete' WHERE id = $1 AND lifecycle_state = 'quarantine'`, [row.media_object_id]);
    await client.query(`
      INSERT INTO platform_audit_events (action, target_type, target_id, reason, details)
      VALUES ('ingest.rejected', 'track', $1, $2, $3::jsonb)
    `, [row.track_id, reason, JSON.stringify({ mediaObjectId: row.media_object_id })]);
    await client.query(`
      INSERT INTO platform_outbox (topic, aggregate_id, payload, idempotency_key)
      VALUES ('media.delete.requested', $1, $2::jsonb, $3)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [row.track_id, JSON.stringify({ trackId: row.track_id }), `media-delete-${row.track_id}`]);
  });
}

/**
 * @param {any} pool
 * @param {any} storage
 * @param {any} job
 * @param {{transcoder?: (inputPath: string, options?: any) => Promise<any>,
 *   fingerprintAdapter?: {name?: string, inspect(input: any): Promise<any>}, maxUploadBytes?: number}} [options]
 */
async function processIngest(pool, storage, job, {
  transcoder = transcodeAudioFile,
  fingerprintAdapter = new UnconfiguredFingerprintAdapter(),
  maxUploadBytes = Number(process.env.PLATFORM_UPLOAD_MAX_BYTES || 200 * 1024 * 1024),
} = {}) {
  const { trackId, mediaObjectId } = job.data || {};
  if (typeof trackId !== 'string' || typeof mediaObjectId !== 'string') {
    throw permanent('Malformed ingest job payload.', 'invalid_job_payload');
  }
  const result = await pool.query(`
    SELECT t.id AS track_id, t.owner_id, t.status, t.sha256 AS track_sha256, t.size_bytes AS track_size_bytes,
      t.fingerprint, m.id AS media_object_id, m.bucket_name, m.object_key,
      m.sha256 AS media_sha256, m.size_bytes AS media_size_bytes, m.content_type, m.lifecycle_state
    FROM tracks t JOIN media_objects m ON m.track_id = t.id AND m.id = $2
    WHERE t.id = $1 AND m.object_kind = 'original'
  `, [trackId, mediaObjectId]);
  const row = result.rows[0];
  if (!row) throw permanent('Ingest source record was not found.', 'ingest_source_missing');
  if (row.status !== 'quarantine' || row.lifecycle_state !== 'quarantine') {
    return { status: 'not_quarantined', trackId };
  }
  if (row.fingerprint?.ingestComplete === true) return { status: 'already_processed', trackId };

  const expectedBytes = Number(row.media_size_bytes);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maxUploadBytes) {
    throw permanent('Stored upload size is outside the configured processing limit.', 'invalid_upload_size');
  }
  const source = await storage.hashObject(row.object_key, { maxBytes: maxUploadBytes });
  const storedHash = String(row.media_sha256 || '').trim();
  if (!source || source.sizeBytes !== expectedBytes || source.sha256 !== storedHash
    || String(row.track_sha256 || '').trim() !== storedHash) {
    throw permanent('Quarantined media integrity verification failed.', 'media_integrity_mismatch');
  }
  const sniffedType = identifyAudioFormat(source.prefix);
  if (!sniffedType || !contentTypeMatches(String(row.content_type).toLowerCase(), sniffedType)) {
    await rejectInvalidMedia(pool, row, 'unsupported_or_mismatched_audio_format');
    return { status: 'rejected_format', trackId };
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'vision-ingest-'));
  let converted;
  const uploadedVariants = [];
  try {
    const inputPath = path.join(workDir, 'source.audio');
    await storage.downloadObjectToFile(row.object_key, inputPath, { maxBytes: maxUploadBytes });
    converted = await transcoder(inputPath, { outputDirectory: workDir });
    if (!Array.isArray(converted?.variants) || converted.variants.length !== 2) {
      throw new Error('The configured transcoder must return the Opus and AAC variants.');
    }

    for (const variant of converted.variants) {
      if (!['opus', 'aac'].includes(variant.codec) || !Number.isSafeInteger(variant.sizeBytes) || variant.sizeBytes < 1) {
        throw permanent('Transcoder returned an invalid variant descriptor.', 'invalid_transcode_output');
      }
      const objectId = deterministicUuid(`${trackId}\0${storedHash}\0${variant.codec}`);
      const objectKey = storage.makeMediaKey({ ownerId: row.owner_id, trackId, objectId });
      const fileHash = await hashFile(variant.path);
      if (fileHash.sizeBytes !== variant.sizeBytes) throw new Error('Transcoded output changed before storage.');
      await storage.putPrivateObject({
        key: objectKey,
        body: createReadStream(variant.path),
        contentType: variant.contentType,
        contentLength: fileHash.sizeBytes,
      });
      uploadedVariants.push({ ...variant, objectKey, objectId, sha256: fileHash.sha256, sizeBytes: fileHash.sizeBytes });
    }

    const fingerprint = await fingerprintAdapter.inspect({
      trackId,
      sha256: storedHash,
      contentType: sniffedType,
      sizeBytes: expectedBytes,
    });
    const safeFingerprint = {
      provider: typeof fingerprintAdapter.name === 'string' ? fingerprintAdapter.name.slice(0, 80) : 'unknown',
      status: ['clear', 'match', 'not_configured', 'unavailable', 'error'].includes(fingerprint?.status)
        ? fingerprint.status : 'unavailable',
      matchCount: Number.isSafeInteger(fingerprint?.matchCount) && fingerprint.matchCount >= 0
        ? fingerprint.matchCount : null,
      ingestComplete: true,
    };

    await transaction(pool, async (client) => {
      const current = await client.query('SELECT status, fingerprint FROM tracks WHERE id = $1 FOR UPDATE', [trackId]);
      if (!current.rows[0] || current.rows[0].status !== 'quarantine') return;
      if (current.rows[0].fingerprint?.ingestComplete === true) return;
      for (const variant of uploadedVariants) {
        const media = await client.query(`
          INSERT INTO media_objects (
            track_id, object_kind, bucket_name, object_key, sha256, size_bytes, lifecycle_state, content_type
          ) VALUES ($1, $2, $3, $4, $5, $6, 'quarantine', $7)
          ON CONFLICT (bucket_name, object_key) DO UPDATE SET
            sha256 = EXCLUDED.sha256, size_bytes = EXCLUDED.size_bytes, content_type = EXCLUDED.content_type
          RETURNING id
        `, [trackId, variant.codec, row.bucket_name, variant.objectKey, variant.sha256,
          variant.sizeBytes, variant.contentType]);
        await client.query(`
          INSERT INTO track_variants (track_id, media_object_id, codec, bitrate_kbps)
          VALUES ($1, $2, $3, $4) ON CONFLICT (track_id, codec, media_object_id) DO NOTHING
        `, [trackId, media.rows[0].id, variant.codec, variant.bitrateKbps]);
      }
      await client.query('UPDATE tracks SET fingerprint = $2::jsonb WHERE id = $1', [trackId, JSON.stringify(safeFingerprint)]);
      await client.query(`
        INSERT INTO platform_audit_events (action, target_type, target_id, reason, details)
        VALUES ('ingest.completed', 'track', $1, 'validated_quarantine_media', $2::jsonb)
      `, [trackId, JSON.stringify({ mediaObjectId, detectedContentType: sniffedType,
        fingerprintStatus: safeFingerprint.status, variants: uploadedVariants.map(({ codec }) => codec) })]);
    });
    return { status: 'quarantine_ready', trackId, variants: uploadedVariants.map(({ codec }) => codec), fingerprint: safeFingerprint.status };
  } finally {
    if (typeof converted?.cleanup === 'function') await converted.cleanup();
    await rm(workDir, { recursive: true, force: true });
  }
}

async function processMediaDeletion(pool, storage, job) {
  const { trackId } = job.data || {};
  if (typeof trackId !== 'string') throw permanent('Malformed media deletion job payload.', 'invalid_job_payload');
  const result = await pool.query(`
    SELECT m.id, m.object_key, m.size_bytes, m.object_kind, t.owner_id
    FROM media_objects m JOIN tracks t ON t.id = m.track_id
    WHERE m.track_id = $1 AND m.lifecycle_state = 'pending_delete'
  `, [trackId]);
  for (const object of result.rows) await storage.deleteObject(object.object_key);
  await transaction(pool, async (client) => {
    await client.query(`
      UPDATE media_objects SET lifecycle_state = 'deleted', deleted_at = now()
      WHERE track_id = $1 AND lifecycle_state = 'pending_delete'
    `, [trackId]);
    const originalBytes = result.rows
      .filter(({ object_kind }) => object_kind === 'original')
      .reduce((total, { size_bytes }) => total + BigInt(size_bytes), 0n);
    if (originalBytes > 0n) {
      await client.query(`
        UPDATE user_quotas SET storage_used_bytes = GREATEST(0, storage_used_bytes - $2), updated_at = now()
        WHERE user_id = (SELECT owner_id FROM tracks WHERE id = $1)
      `, [trackId, originalBytes.toString()]);
    }
  });
  return { status: 'deleted', trackId, objects: result.rows.length };
}

/** Create the BullMQ processor with replaceable transcode and fingerprint adapters. */
export function createPlatformJobProcessor({
  pool,
  storage,
  transcoder = transcodeAudioFile,
  fingerprintAdapter = new UnconfiguredFingerprintAdapter(),
  maxUploadBytes = Number(process.env.PLATFORM_UPLOAD_MAX_BYTES || 200 * 1024 * 1024),
}) {
  if (!pool || !storage) throw new Error('The platform worker requires PostgreSQL and private object storage.');
  requireFingerprintAdapter(fingerprintAdapter);
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) throw new Error('maxUploadBytes must be positive.');
  return async (job) => {
    if (job.name === 'ingest.requested') {
      return processIngest(pool, storage, job, { transcoder, fingerprintAdapter, maxUploadBytes });
    }
    if (job.name === 'media.delete.requested') return processMediaDeletion(pool, storage, job);
    throw permanent('Unknown platform job type.', 'unknown_job_type');
  };
}
