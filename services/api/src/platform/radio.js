// @ts-check
import { randomUUID } from 'node:crypto';
import { PlatformAuthError } from './auth-crypto.js';
import { getRecommendations } from './recsys.js';
import { createTrackMediaUrl } from './media.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REACTIONS = new Set(['like', 'dislike', 'skip', 'report']);
const MAX_WINDOW_MS = 15 * 60_000;
const URL_TTL_SECONDS = 60;

function invalid(message) { return new PlatformAuthError('invalid_input', 400, message); }

function normalizeLabel(value, label, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > maxLength) {
    throw invalid(`${label} must be between 1 and ${maxLength} characters.`);
  }
  return value.trim();
}

function contextParams(context) {
  const params = new URLSearchParams();
  if (context.genre) params.set('genre', context.genre);
  if (context.mood) params.set('mood', context.mood);
  params.set('limit', '50');
  return params;
}

async function getEligibleMedia(pool, trackIds) {
  if (!trackIds.length) return new Map();
  const slots = trackIds.map((_, index) => `$${index + 1}`).join(', ');
  const result = await pool.query(`
    SELECT t.id AS "trackId", t.duration_ms AS "durationMs", m.id AS "mediaObjectId",
      m.object_key AS "objectKey", m.content_type AS "contentType", m.object_kind,
      COALESCE(tv.codec, m.object_kind) AS codec
    FROM tracks t
    JOIN media_objects m ON m.track_id = t.id AND m.lifecycle_state = 'ready'
    LEFT JOIN track_variants tv ON tv.media_object_id = m.id
    WHERE t.id IN (${slots}) AND t.status = 'published' AND t.visibility = 'public'
    ORDER BY t.id, CASE COALESCE(tv.codec, m.object_kind)
      WHEN 'opus' THEN 0 WHEN 'aac' THEN 1 WHEN 'original' THEN 2 ELSE 3 END
  `, trackIds);
  const resultByTrack = new Map();
  for (const row of result.rows) {
    if (!resultByTrack.has(row.trackId)) resultByTrack.set(row.trackId, row);
  }
  return resultByTrack;
}

async function appendSchedule(pool, session, excludeIds, targetDurationMs, { nowMs }) {
  const params = contextParams(session.context || {});
  const candidates = await getRecommendations(pool, session.user_id, params, { nowMs });
  const remaining = candidates.items.filter(({ id }) => !excludeIds.has(id));
  const mediaByTrack = await getEligibleMedia(pool, remaining.map(({ id }) => id));
  const eligible = remaining.filter((track) => {
    const media = mediaByTrack.get(track.id);
    return media && Number.isSafeInteger(Number(media.durationMs)) && Number(media.durationMs) > 0;
  });
  if (!eligible.length) return 0;

  const nextPosition = await pool.query(`
    SELECT COALESCE(MAX(position) + 1, 0) AS next_position FROM radio_schedule WHERE session_id = $1
  `, [session.id]);
  let position = Number(nextPosition.rows[0].next_position);
  let scheduledDuration = 0;
  let inserted = 0;
  const expiresAt = new Date(nowMs + 60 * 60_000);
  for (const track of eligible) {
    const media = mediaByTrack.get(track.id);
    const durationMs = Number(media.durationMs);
    if (durationMs > MAX_WINDOW_MS || scheduledDuration + durationMs > MAX_WINDOW_MS) continue;
    const saved = await pool.query(`
      INSERT INTO radio_schedule (
        session_id, position, segment_type, ref_id, media_object_id, duration_ms, mix, expires_at
      ) VALUES ($1, $2, 'music', $3, $4, $5, '{}'::jsonb, $6)
      ON CONFLICT (session_id, position) DO NOTHING
      RETURNING id
    `, [session.id, position, track.id, media.mediaObjectId, durationMs, expiresAt]);
    position += 1;
    if (!saved.rows.length) continue;
    excludeIds.add(track.id);
    scheduledDuration += durationMs;
    inserted += 1;
    if (scheduledDuration >= targetDurationMs) break;
  }
  return inserted;
}

async function loadSession(pool, sessionId, userId, { forUpdate = false } = {}) {
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw new PlatformAuthError('not_found', 404, 'Radio session not found.');
  const lockClause = forUpdate ? 'FOR UPDATE' : '';
  const result = await pool.query(`
    SELECT id, user_id, status, started_at, ended_at, mood, context, prefs
    FROM radio_sessions WHERE id = $1 AND user_id = $2 ${lockClause}
  `, [sessionId, userId]);
  if (!result.rows[0]) throw new PlatformAuthError('not_found', 404, 'Radio session not found.');
  if (result.rows[0].status !== 'active') throw new PlatformAuthError('radio_session_inactive', 409, 'Radio session is not active.');
  return result.rows[0];
}

/**
 * Start a private, music-only schedule. No ad/news/editorial segment policy is assumed.
 * @param {import('pg').Pool} pool
 * @param {string} userId
 * @param {{mood?: string, genre?: string}} input
 * @param {{storage?: import('./storage.js').PlatformStorage, nowMs?: number}} [options]
 */
export async function startRadioSession(pool, userId, input, { storage, nowMs = Date.now() } = {}) {
  if (!storage) throw new PlatformAuthError('storage_unavailable', 503, 'Private media storage is not configured.');
  const mood = normalizeLabel(input?.mood, 'mood', 50);
  const genre = normalizeLabel(input?.genre, 'genre', 100);
  const context = { ...(mood ? { mood } : {}), ...(genre ? { genre } : {}) };
  const sessionId = randomUUID();
  const created = await pool.query(`
    INSERT INTO radio_sessions (id, user_id, mood, context, prefs)
    VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb)
    RETURNING id, status, started_at AS "startedAt", mood, context
  `, [sessionId, userId, mood, JSON.stringify(context)]);
  const schedule = await getRadioSchedule(pool, sessionId, userId, { storage, nowMs, aheadSeconds: 900 });
  return { ...created.rows[0], schedule, schedulerPolicy: 'music-only-v1' };
}

/**
 * Return the next private schedule window and top it up from eligible recommendations.
 * @param {import('pg').Pool} pool
 * @param {string} sessionId
 * @param {string} userId
 * @param {{storage?: import('./storage.js').PlatformStorage, nowMs?: number, aheadSeconds?: number}} [options]
 */
export async function getRadioSchedule(pool, sessionId, userId, {
  storage,
  nowMs = Date.now(),
  aheadSeconds = 900,
} = {}) {
  if (!storage) throw new PlatformAuthError('storage_unavailable', 503, 'Private media storage is not configured.');
  if (!Number.isInteger(aheadSeconds) || aheadSeconds < 60 || aheadSeconds > 900) throw invalid('ahead must be between 60 and 900 seconds.');
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    const session = await loadSession(client, sessionId, userId, { forUpdate: true });
    const current = await client.query(`
      SELECT s.ref_id AS track_id, s.duration_ms, f.reaction
      FROM radio_schedule s
      JOIN tracks t ON t.id = s.ref_id
      JOIN media_objects m ON m.id = s.media_object_id
      LEFT JOIN radio_feedback f ON f.schedule_id = s.id AND f.user_id = $2
      WHERE s.session_id = $1 AND s.expires_at > $3 AND m.lifecycle_state = 'ready'
        AND t.status = 'published' AND t.visibility = 'public'
        AND t.rights_confirmed_at IS NOT NULL AND t.rights_offer_version IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM (
            SELECT moderation.status, moderation.decided_at FROM moderation_queue moderation
            WHERE moderation.track_id = t.id
            ORDER BY moderation.created_at DESC, moderation.id DESC LIMIT 1
          ) latest WHERE latest.status = 'approved' AND latest.decided_at IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM rights_claims claim WHERE claim.track_id = t.id
            AND claim.status IN ('open', 'counter_notice', 'accepted')
        )
      ORDER BY s.position
    `, [sessionId, userId, new Date(nowMs)]);
    const used = new Set(current.rows.map(({ track_id }) => track_id));
    const remainingMs = current.rows.filter(({ reaction }) => reaction !== 'skip')
      .reduce((sum, row) => sum + Number(row.duration_ms), 0);
    if (remainingMs < aheadSeconds * 1000) {
      await appendSchedule(client, session, used, aheadSeconds * 1000 - remainingMs, { nowMs });
    }
    await client.query('COMMIT');
    inTransaction = false;
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const result = await pool.query(`
    SELECT s.id, s.position, s.segment_type AS "segmentType", s.ref_id AS "trackId",
      s.duration_ms AS "durationMs", s.mix, s.expires_at AS "expiresAt",
      t.title, t.artist_display AS artist, t.album, t.genre, t.mood,
      COALESCE(tv.codec, m.object_kind) AS codec
    FROM radio_schedule s
    JOIN radio_sessions r ON r.id = s.session_id
    JOIN tracks t ON t.id = s.ref_id
    JOIN media_objects m ON m.id = s.media_object_id
    LEFT JOIN track_variants tv ON tv.media_object_id = m.id
    LEFT JOIN radio_feedback f ON f.schedule_id = s.id AND f.user_id = r.user_id
    WHERE s.session_id = $1 AND r.user_id = $2 AND r.status = 'active'
      AND s.expires_at > $3 AND m.lifecycle_state = 'ready'
      AND t.status = 'published' AND t.visibility = 'public'
      AND t.rights_confirmed_at IS NOT NULL AND t.rights_offer_version IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM (
          SELECT moderation.status, moderation.decided_at FROM moderation_queue moderation
          WHERE moderation.track_id = t.id
          ORDER BY moderation.created_at DESC, moderation.id DESC LIMIT 1
        ) latest WHERE latest.status = 'approved' AND latest.decided_at IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM rights_claims claim WHERE claim.track_id = t.id
          AND claim.status IN ('open', 'counter_notice', 'accepted')
      )
      AND (f.reaction IS NULL OR f.reaction <> 'skip')
    ORDER BY s.position ASC
  `, [sessionId, userId, new Date(nowMs)]);
  const items = [];
  let totalDurationMs = 0;
  for (const row of result.rows) {
    if (totalDurationMs >= aheadSeconds * 1000) break;
    let media;
    try {
      media = await createTrackMediaUrl(pool, row.trackId, { id: userId, role: 'listener' }, {
        storage, codec: row.codec, expiresInSeconds: URL_TTL_SECONDS,
      });
    } catch (error) {
      if (error?.status === 404) continue;
      throw error;
    }
    totalDurationMs += Number(row.durationMs);
    items.push({
      ...row,
      codec: media.codec,
      contentType: media.contentType,
      url: media.url,
      urlExpiresInSeconds: media.expiresInSeconds,
      cacheControl: media.cacheControl,
    });
  }
  return { sessionId, items, totalDurationMs, schedulerPolicy: 'music-only-v1' };
}

/** Feedback and skip are owner-scoped to an active radio session and its segments. */
export async function recordRadioFeedback(pool, sessionId, userId, input) {
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)
    || typeof input?.segmentId !== 'string' || !UUID.test(input.segmentId)) {
    throw new PlatformAuthError('not_found', 404, 'Radio segment not found.');
  }
  if (!REACTIONS.has(input.reaction)) throw invalid('reaction must be like, dislike, skip or report.');
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    const session = await loadSession(client, sessionId, userId, { forUpdate: true });
    const segment = await client.query(`
      SELECT id FROM radio_schedule WHERE id = $1 AND session_id = $2 AND expires_at > now() FOR UPDATE
    `, [input.segmentId, session.id]);
    if (!segment.rows[0]) throw new PlatformAuthError('not_found', 404, 'Radio segment not found.');
    await client.query(`
      INSERT INTO radio_feedback (session_id, schedule_id, user_id, reaction)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, schedule_id) DO UPDATE SET reaction = EXCLUDED.reaction, created_at = now()
    `, [session.id, input.segmentId, userId, input.reaction]);
    await client.query('COMMIT');
    inTransaction = false;
    return { sessionId, segmentId: input.segmentId, reaction: input.reaction };
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function skipRadioSegment(pool, sessionId, userId, segmentId) {
  return recordRadioFeedback(pool, sessionId, userId, { segmentId, reaction: 'skip' });
}
