// @ts-check
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { PlatformAuthError, requirePlatformAuthSecret } from './auth-crypto.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const KINDS = new Set(['start', 'play_30s', 'finish', 'skip_early', 'repeat', 'segment_skip']);
const SOURCES = new Set(['wave', 'library', 'playlist', 'share', 'promo']);
const DEVICES = new Set(['web', 'mobile', 'desktop', 'unknown']);
const MAX_BATCH = 100;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_DURATION_TOLERANCE_MS = 2_000;
const EVENT_POSITION_TOLERANCE_MS = 2_000;
const PLAYBACK_TOKEN_VERSION = 'p1';
const PLAYBACK_SESSION_TTL_SECONDS = 60 * 60;

function invalid(message) { return new PlatformAuthError('invalid_input', 400, message); }
function invalidPlaybackSession() {
  return new PlatformAuthError('invalid_playback_session', 401, 'Playback session is invalid or expired.');
}

/**
 * Issue a short-lived, user- and track-bound capability only for a currently playable track.
 * @param {{secret?: string|Buffer, nowMs?: number}} [options]
 */
export async function createPlaybackSession(pool, userId, trackId, options = {}) {
  const { secret, nowMs = Date.now() } = options;
  const signingKey = requirePlatformAuthSecret(secret);
  if (typeof trackId !== 'string' || !UUID.test(trackId)) {
    throw new PlatformAuthError('not_found', 404, 'Track not found.');
  }

  const eligible = await pool.query(`
    SELECT t.id FROM tracks t
    WHERE t.id = $1
      AND t.status = 'published' AND t.visibility = 'public'
      AND t.rights_confirmed_at IS NOT NULL AND t.rights_offer_version IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM (
          SELECT m.status, m.decided_at FROM moderation_queue m WHERE m.track_id = t.id
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1
        ) latest WHERE latest.status = 'approved' AND latest.decided_at IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM rights_claims c WHERE c.track_id = t.id
          AND c.status IN ('open', 'counter_notice', 'accepted')
      )
  `, [trackId]);
  const track = eligible.rows[0];
  if (!track) throw new PlatformAuthError('not_found', 404, 'Track not found.');

  const sessionId = randomUUID();
  const trackIdLower = String(track.id).toLowerCase();
  const userIdLower = String(userId).toLowerCase();
  const issuedAt = Math.floor(nowMs / 1_000);
  const expiresAtSeconds = issuedAt + PLAYBACK_SESSION_TTL_SECONDS;
  const claims = {
    iss: 'vision-platform-playback',
    aud: 'vision-platform-api',
    sid: sessionId,
    sub: userIdLower,
    tid: trackIdLower,
    iat: issuedAt,
    exp: expiresAtSeconds,
    nonce: randomBytes(16).toString('base64url'),
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signed = `${PLAYBACK_TOKEN_VERSION}.${payload}`;
  const signature = createHmac('sha256', signingKey).update(signed).digest('base64url');
  const issuedAtDate = new Date(issuedAt * 1_000);
  const expiresAtDate = new Date(expiresAtSeconds * 1_000);
  await pool.query(`
    INSERT INTO playback_sessions (id, user_id, track_id, issued_at, expires_at)
    VALUES ($1, $2, $3, $4, $5)
  `, [sessionId, userIdLower, trackIdLower, issuedAtDate, expiresAtDate]);
  return {
    sessionId,
    trackId: trackIdLower,
    playbackToken: `${signed}.${signature}`,
    expiresAt: expiresAtDate.toISOString(),
    expiresInSeconds: PLAYBACK_SESSION_TTL_SECONDS,
  };
}

/** Revoke an owned playback session; repeat revocation is idempotent. */
export async function revokePlaybackSession(pool, userId, sessionId, { nowMs = Date.now() } = {}) {
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return false;
  const result = await pool.query(`
    UPDATE playback_sessions SET revoked_at = COALESCE(revoked_at, $3)
    WHERE id = $1 AND user_id = $2
    RETURNING id
  `, [sessionId.toLowerCase(), userId, new Date(nowMs)]);
  return result.rowCount === 1;
}

/** Verify a playback capability without persisting or logging the raw token. */
function verifyPlaybackToken(token, signingKey, nowMs) {
  if (typeof token !== 'string' || token.length > 2_048) return null;
  const [version, payload, signature, extra] = token.split('.');
  if (version !== PLAYBACK_TOKEN_VERSION || !payload || !signature || extra !== undefined
    || !BASE64URL.test(payload) || !BASE64URL.test(signature)) return null;

  const expectedSignature = createHmac('sha256', signingKey).update(`${version}.${payload}`).digest();
  const actualSignature = Buffer.from(signature, 'base64url');
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (!claims
    || claims.iss !== 'vision-platform-playback'
    || claims.aud !== 'vision-platform-api'
    || typeof claims.sid !== 'string' || !UUID.test(claims.sid)
    || typeof claims.sub !== 'string' || !UUID.test(claims.sub)
    || typeof claims.tid !== 'string' || !UUID.test(claims.tid)
    || typeof claims.nonce !== 'string' || !BASE64URL.test(claims.nonce)
    || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)
    || claims.iat > nowSeconds + 60
    || claims.exp <= nowSeconds
    || claims.exp <= claims.iat
    || claims.exp - claims.iat > PLAYBACK_SESSION_TTL_SECONDS) return null;
  return {
    sessionId: claims.sid.toLowerCase(),
    userId: claims.sub.toLowerCase(),
    trackId: claims.tid.toLowerCase(),
    issuedAtMs: claims.iat * 1_000,
    expiresAtMs: claims.exp * 1_000,
  };
}

function normalizeEvent(input, nowMs) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Each event must be an object.');
  const allowed = ['eventId', 'trackId', 'sessionId', 'playbackToken', 'kind', 'positionMs', 'durationMs', 'source', 'device', 'occurredAt'];
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown) throw invalid(`Unknown event field: ${unknown}.`);
  if (typeof input.eventId !== 'string' || !UUID.test(input.eventId)
    || typeof input.trackId !== 'string' || !UUID.test(input.trackId)
    || typeof input.sessionId !== 'string' || !UUID.test(input.sessionId)) {
    throw invalid('eventId, trackId and sessionId must be UUIDs.');
  }
  if (typeof input.playbackToken !== 'string' || input.playbackToken.length < 1 || input.playbackToken.length > 2_048) {
    throw invalid('playbackToken is required.');
  }
  if (!KINDS.has(input.kind)) throw invalid('Unsupported event kind.');
  if (!SOURCES.has(input.source)) throw invalid('Unsupported event source.');
  if (input.device !== undefined && !DEVICES.has(input.device)) throw invalid('Unsupported device category.');
  const position = input.positionMs ?? null;
  const duration = input.durationMs ?? null;
  if (position !== null && (!Number.isInteger(position) || position < 0 || position > 86_400_000)) {
    throw invalid('positionMs must be a non-negative integer no greater than 24 hours.');
  }
  if (duration !== null && (!Number.isInteger(duration) || duration < 0 || duration > 86_400_000)) {
    throw invalid('durationMs must be a non-negative integer no greater than 24 hours.');
  }
  if (position !== null && duration !== null && position > duration + 60_000) {
    throw invalid('positionMs is outside the allowed event duration.');
  }
  if (input.kind === 'play_30s' && (position === null || position < 30_000)) {
    throw invalid('play_30s events require positionMs of at least 30000.');
  }
  if (typeof input.occurredAt !== 'string' || input.occurredAt.length > 40) {
    throw invalid('occurredAt must be an ISO timestamp.');
  }
  const occurredAtMs = Date.parse(input.occurredAt);
  if (!Number.isFinite(occurredAtMs) || occurredAtMs > nowMs + 5 * 60_000 || occurredAtMs < nowMs - MAX_EVENT_AGE_MS) {
    throw invalid('occurredAt must be within the previous 7 days and no more than 5 minutes in the future.');
  }
  return {
    eventId: input.eventId.toLowerCase(),
    trackId: input.trackId.toLowerCase(),
    sessionId: input.sessionId.toLowerCase(),
    playbackToken: input.playbackToken,
    kind: input.kind,
    positionMs: position,
    durationMs: duration,
    source: input.source,
    device: input.device ?? 'unknown',
    occurredAt: new Date(occurredAtMs),
  };
}

/**
 * Store a deduplicated batch only when each event has a valid server-issued playback capability.
 * @param {{secret?: string|Buffer, nowMs?: number}} [options]
 */
export async function ingestPlayEvents(pool, userId, input, options = {}) {
  const { secret, nowMs = Date.now() } = options;
  const signingKey = requirePlatformAuthSecret(secret);
  if (!input || !Array.isArray(input.events) || input.events.length < 1 || input.events.length > MAX_BATCH) {
    throw invalid(`events must contain between 1 and ${MAX_BATCH} items.`);
  }
  const events = input.events.map((item) => normalizeEvent(item, nowMs));
  const ids = new Map();
  for (const event of events) {
    const previous = ids.get(event.eventId);
    const serialized = JSON.stringify(event);
    if (previous && previous !== serialized) throw invalid('An eventId cannot refer to different event payloads in the same batch.');
    ids.set(event.eventId, serialized);
  }
  const trackIds = [...new Set(events.map(({ trackId }) => trackId))];
  const trackParams = trackIds.map((id) => id);
  const trackSlots = trackIds.map((_, index) => `$${index + 1}`).join(', ');
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    const eligible = await client.query(`
      SELECT t.id, t.duration_ms FROM tracks t
      WHERE t.id IN (${trackSlots})
        AND t.status = 'published' AND t.visibility = 'public'
        AND t.rights_confirmed_at IS NOT NULL AND t.rights_offer_version IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM (
            SELECT m.status, m.decided_at FROM moderation_queue m WHERE m.track_id = t.id
            ORDER BY m.created_at DESC, m.id DESC LIMIT 1
          ) latest WHERE latest.status = 'approved' AND latest.decided_at IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM rights_claims c WHERE c.track_id = t.id
            AND c.status IN ('open', 'counter_notice', 'accepted')
        )
      FOR SHARE OF t
    `, trackParams);
    if (eligible.rows.length !== trackIds.length) {
      throw new PlatformAuthError('not_found', 404, 'One or more tracks are not available for events.');
    }
    const trackDurations = new Map(eligible.rows.map(({ id, duration_ms: durationMs }) => [
      String(id).toLowerCase(), durationMs === null ? null : Number(durationMs),
    ]));
    const claimsByToken = new Map();
    for (const event of events) {
      const trackDurationMs = trackDurations.get(event.trackId);
      if (event.durationMs !== null && trackDurationMs !== null && trackDurationMs !== undefined
        && Math.abs(event.durationMs - trackDurationMs) > EVENT_DURATION_TOLERANCE_MS) {
        throw invalid('durationMs does not match the published track duration.');
      }
      if (event.positionMs !== null && trackDurationMs !== null && trackDurationMs !== undefined
        && event.positionMs > trackDurationMs + EVENT_POSITION_TOLERANCE_MS) {
        throw invalid('positionMs exceeds the published track duration.');
      }
      if (event.kind === 'play_30s' && (!Number.isInteger(trackDurationMs) || trackDurationMs < 30_000)) {
        throw invalid('play_30s requires a verified track duration of at least 30000 ms.');
      }

      let claims = claimsByToken.get(event.playbackToken);
      if (claims === undefined) {
        claims = verifyPlaybackToken(event.playbackToken, signingKey, nowMs) || null;
        claimsByToken.set(event.playbackToken, claims);
      }
      if (!claims || claims.userId !== String(userId).toLowerCase()
        || claims.trackId !== event.trackId || claims.sessionId !== event.sessionId
        || event.occurredAt.getTime() < claims.issuedAtMs) {
        throw invalidPlaybackSession();
      }
      if (event.kind === 'play_30s'
        && (nowMs < claims.issuedAtMs + 30_000 || event.occurredAt.getTime() < claims.issuedAtMs + 30_000)) {
        throw invalid('play_30s cannot be accepted before 30 seconds after a playback session is issued.');
      }
    }

    const sessionIds = [...new Set(events.map(({ sessionId }) => sessionId))];
    const sessionSlots = sessionIds.map((_, index) => `$${index + 1}`).join(', ');
    const storedSessions = await client.query(`
      SELECT id, user_id, track_id, issued_at, expires_at, revoked_at
      FROM playback_sessions WHERE id IN (${sessionSlots})
      ORDER BY id FOR SHARE
    `, sessionIds);
    if (storedSessions.rows.length !== sessionIds.length) throw invalidPlaybackSession();
    const sessionsById = new Map(storedSessions.rows.map((session) => [String(session.id).toLowerCase(), session]));
    for (const event of events) {
      const claims = claimsByToken.get(event.playbackToken);
      const session = sessionsById.get(event.sessionId);
      if (!claims || !session
        || String(session.user_id).toLowerCase() !== claims.userId
        || String(session.track_id).toLowerCase() !== claims.trackId
        || new Date(session.issued_at).getTime() !== claims.issuedAtMs
        || new Date(session.expires_at).getTime() !== claims.expiresAtMs
        || session.revoked_at !== null
        || new Date(session.expires_at).getTime() <= nowMs) {
        throw invalidPlaybackSession();
      }
    }

    const values = [userId];
    const tuples = events.map((event) => {
      const start = values.length + 1;
      values.push(event.eventId, event.trackId, event.sessionId, event.kind,
        event.positionMs, event.durationMs, event.source, event.device, event.occurredAt);
      return `($${start}::uuid, $${start + 1}::uuid, $${start + 2}::uuid, $${start + 3}::text,
        $${start + 4}::integer, $${start + 5}::integer, $${start + 6}::text, $${start + 7}::text, $${start + 8}::timestamptz)`;
    });
    const inserted = await client.query(`
      INSERT INTO play_events (
        event_id, user_id, track_id, session_id, kind, position_ms, duration_ms, source, device, occurred_at
      )
      SELECT v.event_id, $1::uuid, v.track_id, v.session_id, v.kind, v.position_ms, v.duration_ms,
        v.source, v.device, v.occurred_at
      FROM (VALUES ${tuples.join(',')}) AS v(
        event_id, track_id, session_id, kind, position_ms, duration_ms, source, device, occurred_at
      )
      ON CONFLICT DO NOTHING
      RETURNING event_id
    `, values);
    await client.query('COMMIT');
    inTransaction = false;
    return {
      accepted: inserted.rows.length,
      duplicates: events.length - inserted.rows.length,
    };
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
