// @ts-check
import { createHash, randomUUID } from 'node:crypto';
import { PlatformAuthError } from './auth-crypto.js';
import { requireOwnerOrAdmin, requireRole } from './identity.js';

const AUDIO_TYPES = new Set([
  'audio/aac', 'audio/flac', 'audio/mp4', 'audio/mpeg', 'audio/ogg',
  'audio/opus', 'audio/wav', 'audio/webm', 'audio/x-wav',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function inputError(message) { return new PlatformAuthError('invalid_input', 400, message); }
function conflict(code, message) { return new PlatformAuthError(code, 409, message); }

async function withTransaction(pool, work) {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    const result = await work(client);
    await client.query('COMMIT');
    inTransaction = false;
    return result;
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function normalizeUpload(input, maxUploadBytes) {
  if (typeof input?.title !== 'string' || input.title.trim().length < 1 || input.title.trim().length > 300) {
    throw inputError('title must be between 1 and 300 characters.');
  }
  if (typeof input?.artistDisplay !== 'string' || input.artistDisplay.trim().length < 1 || input.artistDisplay.trim().length > 300) {
    throw inputError('artistDisplay must be between 1 and 300 characters.');
  }
  if (typeof input?.contentType !== 'string' || !AUDIO_TYPES.has(input.contentType.toLowerCase())) {
    throw inputError('contentType is not an accepted audio media type.');
  }
  const sizeBytes = input?.sizeBytes;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > maxUploadBytes) {
    throw inputError(`sizeBytes must be between 1 and ${maxUploadBytes}.`);
  }
  return {
    title: input.title.trim(),
    artistDisplay: input.artistDisplay.trim(),
    contentType: input.contentType.toLowerCase(),
    sizeBytes,
  };
}

function normalizeIdempotencyKey(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 200 || !/^[\x21-\x7e]+$/.test(value)) {
    throw inputError('Idempotency-Key must be 1 to 200 printable ASCII characters.');
  }
  return value;
}

function requestHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function uploadResponse({ intent, uploadUrl }) {
  return {
    uploadId: intent.id,
    trackId: intent.track_id,
    status: intent.status,
    expiresAt: new Date(intent.expires_at).toISOString(),
    upload: uploadUrl,
  };
}

/**
 * Create an owner-scoped private upload intent. Quotas must be configured by an
 * operator; the service intentionally does not invent user limits.
 * @param {import('pg').Pool} pool
 * @param {{id: string, role: string}} actor
 * @param {Record<string, unknown>} input
 * @param {{storage?: ReturnType<typeof import('./storage.js').createS3Storage>, maxUploadBytes?: number,
 *   idempotencyKey?: string|string[], nowMs?: number}} [options]
 */
export async function createUploadIntent(pool, actor, input, {
  storage,
  maxUploadBytes = Number(process.env.PLATFORM_UPLOAD_MAX_BYTES || 200 * 1024 * 1024),
  idempotencyKey,
  nowMs = Date.now(),
} = {}) {
  requireRole(actor, ['artist', 'admin']);
  if (!storage) throw new PlatformAuthError('storage_unavailable', 503, 'Private media storage is not configured.');
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) throw new Error('PLATFORM_UPLOAD_MAX_BYTES must be a positive safe integer.');
  const normalized = normalizeUpload(input, maxUploadBytes);
  const key = normalizeIdempotencyKey(idempotencyKey);
  const hash = requestHash(normalized);
  const uploadId = randomUUID();
  const trackId = randomUUID();
  const objectKey = storage.makeQuarantineKey({ ownerId: actor.id, trackId, intentId: uploadId });
  const createdAt = new Date(nowMs);
  const expiresAt = new Date(nowMs + 5 * 60_000);

  const result = await withTransaction(pool, async (client) => {
    if (key) {
      const prior = await client.query(`
        SELECT id, track_id, status, expires_at, request_hash
        FROM upload_intents WHERE owner_id = $1 AND idempotency_key = $2 FOR UPDATE
      `, [actor.id, key]);
      if (prior.rows[0]) {
        const existing = prior.rows[0];
        if (existing.request_hash !== hash) throw conflict('idempotency_conflict', 'Idempotency-Key was already used with different upload metadata.');
        if (existing.status !== 'pending' || new Date(existing.expires_at).getTime() <= nowMs) {
          throw conflict('upload_intent_expired', 'The idempotent upload intent is no longer active. Create a new intent.');
        }
        const signed = await storage.createUploadUrl({
          key: objectKeyForIntent(existing, actor.id, storage),
          contentType: normalized.contentType,
          expiresInSeconds: Math.min(300, Math.max(1, Math.floor((new Date(existing.expires_at).getTime() - nowMs) / 1000))),
        });
        return { existing, signed };
      }
    }

    const quotaResult = await client.query(`
      SELECT storage_limit_bytes, storage_used_bytes, storage_reserved_bytes,
        monthly_upload_limit, uploads_this_month, quota_month
      FROM user_quotas WHERE user_id = $1 FOR UPDATE
    `, [actor.id]);
    const quota = quotaResult.rows[0];
    if (!quota) throw new PlatformAuthError('upload_quota_unconfigured', 403, 'An upload quota has not been configured for this account.');
    const currentMonth = new Date(Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), 1));
    let uploadCount = Number(quota.uploads_this_month);
    if (new Date(quota.quota_month).getTime() < currentMonth.getTime()) uploadCount = 0;
    if (uploadCount >= Number(quota.monthly_upload_limit)) {
      throw new PlatformAuthError('upload_quota_exceeded', 429, 'The monthly upload limit has been reached.');
    }
    const committed = BigInt(quota.storage_used_bytes) + BigInt(quota.storage_reserved_bytes);
    if (committed + BigInt(normalized.sizeBytes) > BigInt(quota.storage_limit_bytes)) {
      throw new PlatformAuthError('storage_quota_exceeded', 413, 'The account storage quota would be exceeded.');
    }

    await client.query(`
      UPDATE user_quotas SET quota_month = $2, uploads_this_month = $3,
        storage_reserved_bytes = storage_reserved_bytes + $4, updated_at = $5
      WHERE user_id = $1
    `, [actor.id, currentMonth, uploadCount + 1, normalized.sizeBytes, createdAt]);
    await client.query(`
      INSERT INTO tracks (id, owner_id, title, artist_display, size_bytes, status, visibility)
      VALUES ($1, $2, $3, $4, $5, 'quarantine', 'private')
    `, [trackId, actor.id, normalized.title, normalized.artistDisplay, normalized.sizeBytes]);
    const inserted = await client.query(`
      INSERT INTO upload_intents (
        id, owner_id, track_id, bucket_name, object_key, expected_content_type,
        expected_size_bytes, idempotency_key, request_hash, created_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, track_id, status, expires_at, object_key, expected_content_type
    `, [uploadId, actor.id, trackId, storage.bucket, objectKey, normalized.contentType,
      normalized.sizeBytes, key, hash, createdAt, expiresAt]);
    const signed = await storage.createUploadUrl({ key: objectKey, contentType: normalized.contentType, expiresInSeconds: 300 });
    return { existing: inserted.rows[0], signed };
  });

  return uploadResponse({ intent: result.existing, uploadUrl: result.signed });
}

/** Resolve a repeated idempotent request's managed key without exposing object storage to input. */
function objectKeyForIntent(intent, ownerId, storage) {
  if (!UUID.test(intent.track_id) || !UUID.test(intent.id)) throw new Error('Stored upload intent has an invalid id.');
  return storage.makeQuarantineKey({ ownerId, trackId: intent.track_id, intentId: intent.id });
}

/**
 * Verify uploaded bytes, move them to an immutable platform-managed key, and
 * atomically record an ingest request in the PostgreSQL outbox.
 * @param {import('pg').Pool} pool
 * @param {string} uploadId
 * @param {{id: string, role: string}} actor
 * @param {{storage?: import('./storage.js').PlatformStorage, nowMs?: number}} [options]
 */
export async function completeUploadIntent(pool, uploadId, actor, { storage, nowMs = Date.now() } = {}) {
  if (typeof uploadId !== 'string' || !UUID.test(uploadId)) throw new PlatformAuthError('not_found', 404, 'Upload intent not found.');
  if (!storage) throw new PlatformAuthError('storage_unavailable', 503, 'Private media storage is not configured.');

  return withTransaction(pool, async (client) => {
    const result = await client.query(`
      SELECT i.id, i.owner_id, i.track_id, i.bucket_name, i.object_key, i.expected_content_type,
        i.expected_size_bytes, i.status, i.expires_at, i.media_object_id,
        t.title, t.artist_display
      FROM upload_intents i JOIN tracks t ON t.id = i.track_id
      WHERE i.id = $1 FOR UPDATE OF i, t
    `, [uploadId]);
    const intent = result.rows[0];
    if (!intent) throw new PlatformAuthError('not_found', 404, 'Upload intent not found.');
    requireOwnerOrAdmin(actor, intent.owner_id);
    if (intent.status === 'completed') {
      return { uploadId: intent.id, trackId: intent.track_id, mediaObjectId: intent.media_object_id, status: 'queued' };
    }
    if (intent.status !== 'pending' || new Date(intent.expires_at).getTime() <= nowMs) {
      throw conflict('upload_intent_expired', 'Upload intent is no longer active.');
    }

    const immutableKey = storage.makeMediaKey({ ownerId: intent.owner_id, trackId: intent.track_id, objectId: intent.id });
    const immutableHead = await storage.headObject(immutableKey);
    let integrity = null;
    if (immutableHead) {
      if (Number(immutableHead.sizeBytes) !== Number(intent.expected_size_bytes)) {
        await storage.deleteObject(immutableKey);
        throw conflict('upload_mismatch', 'Previously staged object failed integrity validation.');
      }
      integrity = await storage.hashObject(immutableKey, { maxBytes: Number(intent.expected_size_bytes) });
    }
    if (!integrity) {
      const uploaded = await storage.headObject(intent.object_key);
      if (!uploaded) throw conflict('upload_missing', 'The uploaded object was not found.');
      if (Number(uploaded.sizeBytes) !== Number(intent.expected_size_bytes)
        || uploaded.contentType?.toLowerCase() !== intent.expected_content_type) {
        await storage.deleteObject(intent.object_key);
        throw conflict('upload_mismatch', 'Uploaded size or content type does not match the declared upload.');
      }
      const sourceIntegrity = await storage.hashObject(intent.object_key, { maxBytes: Number(intent.expected_size_bytes) });
      if (!sourceIntegrity || sourceIntegrity.sizeBytes !== Number(intent.expected_size_bytes)) {
        await storage.deleteObject(intent.object_key);
        throw conflict('upload_mismatch', 'Uploaded object failed integrity validation.');
      }
      await storage.copyObject({ sourceKey: intent.object_key, destinationKey: immutableKey });
      integrity = sourceIntegrity;
    }
    if (integrity.sizeBytes !== Number(intent.expected_size_bytes)) {
      await storage.deleteObject(immutableKey);
      throw conflict('upload_mismatch', 'Uploaded object failed integrity validation.');
    }
    await storage.deleteObject(intent.object_key);

    const media = await client.query(`
      INSERT INTO media_objects (track_id, object_kind, bucket_name, object_key, sha256, size_bytes, lifecycle_state, content_type)
      VALUES ($1, 'original', $2, $3, $4, $5, 'quarantine', $6)
      ON CONFLICT (bucket_name, object_key) DO UPDATE SET sha256 = EXCLUDED.sha256
      RETURNING id
    `, [intent.track_id, intent.bucket_name, immutableKey, integrity.sha256, integrity.sizeBytes, intent.expected_content_type]);
    const mediaObjectId = media.rows[0].id;
    await client.query('UPDATE tracks SET sha256 = $2, size_bytes = $3 WHERE id = $1', [intent.track_id, integrity.sha256, integrity.sizeBytes]);
    await client.query(`
      UPDATE user_quotas SET storage_reserved_bytes = GREATEST(0, storage_reserved_bytes - $2),
        storage_used_bytes = storage_used_bytes + $2, updated_at = $3
      WHERE user_id = $1
    `, [intent.owner_id, intent.expected_size_bytes, new Date(nowMs)]);
    await client.query(`
      UPDATE upload_intents SET status = 'completed', completed_at = $2, media_object_id = $3
      WHERE id = $1
    `, [uploadId, new Date(nowMs), mediaObjectId]);
    await client.query(`
      INSERT INTO platform_outbox (topic, aggregate_id, payload, idempotency_key)
      VALUES ('ingest.requested', $1, $2::jsonb, $3)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [intent.track_id, JSON.stringify({ trackId: intent.track_id, mediaObjectId }), `ingest-${uploadId}`]);
    return { uploadId, trackId: intent.track_id, mediaObjectId, status: 'queued' };
  });
}

/** Delete abandoned signed-upload objects and refund quota reservations. */
export async function expirePendingUploadIntents(pool, storage, { nowMs = Date.now(), limit = 50 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Upload expiry batch limit must be between 1 and 500.');
  const now = new Date(nowMs);
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    const pending = await client.query(`
      SELECT id, owner_id, track_id, object_key, expected_size_bytes, created_at
      FROM upload_intents
      WHERE status = 'pending' AND expires_at <= $1
      ORDER BY expires_at, id
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    `, [now, limit]);
    for (const intent of pending.rows) {
      await storage.deleteObject(intent.object_key);
      await client.query(`
        UPDATE upload_intents SET status = 'expired' WHERE id = $1 AND status = 'pending'
      `, [intent.id]);
      await client.query(`
        UPDATE user_quotas SET
          storage_reserved_bytes = GREATEST(0, storage_reserved_bytes - $2),
          uploads_this_month = CASE
            WHEN quota_month = date_trunc('month', $3::timestamptz)::date
              THEN GREATEST(0, uploads_this_month - 1)
            ELSE uploads_this_month
          END,
          updated_at = $3
        WHERE user_id = $1
      `, [intent.owner_id, intent.expected_size_bytes, now]);
      await client.query(`
        UPDATE tracks SET status = 'rejected', visibility = 'private', published_at = NULL
        WHERE id = $1 AND status = 'quarantine'
      `, [intent.track_id]);
      await client.query(`
        INSERT INTO platform_audit_events (action, target_type, target_id, reason, details)
        VALUES ('upload.expired', 'track', $1, 'signed_upload_intent_expired', $2::jsonb)
      `, [intent.track_id, JSON.stringify({ uploadId: intent.id })]);
    }
    await client.query('COMMIT');
    inTransaction = false;
    return { expired: pending.rows.length };
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
