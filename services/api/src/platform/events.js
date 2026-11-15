// @ts-check
import { PlatformAuthError } from './auth-crypto.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS = new Set(['start', 'play_30s', 'finish', 'skip_early', 'repeat', 'segment_skip']);
const SOURCES = new Set(['wave', 'library', 'playlist', 'share', 'promo']);
const DEVICES = new Set(['web', 'mobile', 'desktop', 'unknown']);
const MAX_BATCH = 100;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function invalid(message) { return new PlatformAuthError('invalid_input', 400, message); }

function normalizeEvent(input, nowMs) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Each event must be an object.');
  const allowed = ['eventId', 'trackId', 'sessionId', 'kind', 'positionMs', 'durationMs', 'source', 'device', 'occurredAt'];
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown) throw invalid(`Unknown event field: ${unknown}.`);
  if (typeof input.eventId !== 'string' || !UUID.test(input.eventId)
    || typeof input.trackId !== 'string' || !UUID.test(input.trackId)
    || typeof input.sessionId !== 'string' || !UUID.test(input.sessionId)) {
    throw invalid('eventId, trackId and sessionId must be UUIDs.');
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
    kind: input.kind,
    positionMs: position,
    durationMs: duration,
    source: input.source,
    device: input.device ?? 'unknown',
    occurredAt: new Date(occurredAtMs),
  };
}

/** Store a deduplicated event batch without retaining IP addresses or user-agent strings. */
export async function ingestPlayEvents(pool, userId, input, { nowMs = Date.now() } = {}) {
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
      SELECT t.id FROM tracks t
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
      ON CONFLICT (event_id) DO NOTHING
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
