// @ts-check
import { PlatformAuthError } from './auth-crypto.js';
import { requireOwnerOrAdmin } from './identity.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODECS = new Set(['auto', 'opus', 'aac', 'original']);

/**
 * Issue a short-lived object URL only after rechecking current visibility, latest
 * moderation, rights claims and owner permissions. The bucket itself stays private.
 * @param {import('pg').Pool} pool
 * @param {string} trackId
 * @param {{id: string, role: string}|null} actor
 * @param {{storage?: import('./storage.js').PlatformStorage, codec?: string,
 *   expiresInSeconds?: number}} [options]
 */
export async function createTrackMediaUrl(pool, trackId, actor, {
  storage,
  codec = 'auto',
  expiresInSeconds = 60,
} = {}) {
  if (typeof trackId !== 'string' || !UUID.test(trackId)) throw new PlatformAuthError('not_found', 404, 'Track not found.');
  if (!CODECS.has(codec)) throw new PlatformAuthError('invalid_input', 400, 'codec must be auto, opus, aac or original.');
  if (!storage) throw new PlatformAuthError('storage_unavailable', 503, 'Private media storage is not configured.');
  const result = await pool.query(`
    SELECT t.id, t.owner_id, t.status, t.visibility, t.rights_confirmed_at, t.rights_offer_version,
      EXISTS (
        SELECT 1 FROM (
          SELECT m.status, m.decided_at
          FROM moderation_queue m WHERE m.track_id = t.id
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1
        ) latest WHERE latest.status = 'approved' AND latest.decided_at IS NOT NULL
      ) AS latest_approved,
      EXISTS (
        SELECT 1 FROM rights_claims c WHERE c.track_id = t.id
          AND c.status IN ('open', 'counter_notice', 'accepted')
      ) AS has_open_claim
    FROM tracks t WHERE t.id = $1
  `, [trackId]);
  const track = result.rows[0];
  if (!track || track.status === 'taken_down' || track.has_open_claim) {
    throw new PlatformAuthError('not_found', 404, 'Track not found.');
  }

  const isPublic = track.status === 'published'
    && track.visibility === 'public'
    && Boolean(track.rights_confirmed_at)
    && Boolean(track.rights_offer_version)
    && track.latest_approved;
  const isOwner = Boolean(actor && (actor.id === track.owner_id || actor.role === 'admin'));
  if (!isPublic && !isOwner) throw new PlatformAuthError('not_found', 404, 'Track not found.');
  if (isOwner) requireOwnerOrAdmin(actor, track.owner_id);

  const object = await pool.query(`
    SELECT m.object_key, m.content_type, m.object_kind, m.lifecycle_state,
      COALESCE(tv.codec, m.object_kind) AS codec
    FROM media_objects m
    LEFT JOIN track_variants tv ON tv.media_object_id = m.id
    WHERE m.track_id = $1
      AND (($2 = 'auto') OR COALESCE(tv.codec, m.object_kind) = $2)
      AND (
        ($3::boolean AND m.lifecycle_state = 'ready')
        OR ($4::boolean AND m.lifecycle_state IN ('quarantine', 'ready'))
      )
    ORDER BY CASE COALESCE(tv.codec, m.object_kind)
      WHEN 'opus' THEN 0 WHEN 'aac' THEN 1 WHEN 'original' THEN 2 ELSE 3 END,
      m.created_at DESC
    LIMIT 1
  `, [trackId, codec, isPublic, Boolean(isOwner)]);
  const media = object.rows[0];
  if (!media || media.lifecycle_state === 'pending_delete' || media.lifecycle_state === 'deleted') {
    throw new PlatformAuthError('not_found', 404, 'Track media is not available.');
  }
  const url = await storage.createDownloadUrl({
    key: media.object_key,
    contentType: media.content_type,
    expiresInSeconds,
  });
  return {
    trackId,
    codec: media.codec,
    contentType: media.content_type,
    url,
    expiresInSeconds,
    cacheControl: 'private, no-store',
  };
}
