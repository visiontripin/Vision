// @ts-check
import { PlatformAuthError, normalizeEmail } from './auth-crypto.js';
import { requireModerator, requireOwnerOrAdmin, requireRole } from './identity.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_QUEUE_STATUSES = ['pending', 'assigned', 'escalated'];

function invalidInput(message) {
  return new PlatformAuthError('invalid_input', 400, message);
}

function validateUuid(value, message = 'A valid id is required.') {
  if (typeof value !== 'string' || !UUID.test(value)) throw new PlatformAuthError('not_found', 404, message);
  return value;
}

function normalizeReason(value, { min = 1, max = 2000, label = 'reason' } = {}) {
  if (typeof value !== 'string') throw invalidInput(`${label} is required.`);
  const reason = value.trim();
  if (reason.length < min || reason.length > max) throw invalidInput(`${label} must be between ${min} and ${max} characters.`);
  return reason;
}

function validateHttpsUrl(value, label) {
  if (typeof value !== 'string' || value.length > 2048) throw invalidInput(`${label} must be an HTTPS URL.`);
  try {
    if (new URL(value).protocol === 'https:') return value;
  } catch {
    // Fall through to the same validation error without exposing URL parser details.
  }
  throw invalidInput(`${label} must be an HTTPS URL.`);
}

async function writeAudit(client, { actorId = null, action, targetType, targetId, reason, details = {}, requestId = null }) {
  await client.query(`
    INSERT INTO platform_audit_events (actor_id, action, target_type, target_id, reason, details, request_id)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
  `, [actorId, action, targetType, targetId, reason, JSON.stringify(details), requestId]);
}

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    const value = await callback(client);
    await client.query('COMMIT');
    inTransaction = false;
    return value;
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Owner submits a private/quarantined track into the closed prepublication queue. */
export async function requestTrackPublication(pool, trackId, actor, input, { nowMs = Date.now(), requestId = null } = {}) {
  validateUuid(trackId, 'Track not found.');
  if (input?.rightsConfirmed !== true) {
    throw new PlatformAuthError('rights_confirmation_required', 400, 'Confirm that you have the rights to publish this track.');
  }
  const offerVersion = normalizeReason(input?.offerVersion, { max: 100, label: 'offerVersion' });
  const now = new Date(nowMs);

  return withTransaction(pool, async (client) => {
    const result = await client.query(`
      SELECT id, owner_id, status, visibility, fingerprint FROM tracks WHERE id = $1 FOR UPDATE
    `, [trackId]);
    const track = result.rows[0];
    if (!track) throw new PlatformAuthError('not_found', 404, 'Track not found.');
    requireOwnerOrAdmin(actor, track.owner_id);
    if (!['quarantine', 'rejected'].includes(track.status)) {
      throw new PlatformAuthError('track_not_submittable', 409, 'Track is not ready for moderation submission.');
    }
    const upload = await client.query(`
      SELECT status, media_object_id FROM upload_intents WHERE track_id = $1 ORDER BY created_at DESC LIMIT 1
    `, [trackId]);
    if (upload.rows[0] && (upload.rows[0].status !== 'completed' || !upload.rows[0].media_object_id
      || track.fingerprint?.ingestComplete !== true)) {
      throw new PlatformAuthError('ingest_not_complete', 409, 'Upload integrity and private ingest must finish before moderation submission.');
    }
    const openClaim = await client.query(`
      SELECT 1 FROM rights_claims WHERE track_id = $1 AND status IN ('open', 'counter_notice', 'accepted') LIMIT 1
    `, [trackId]);
    if (openClaim.rows.length) {
      throw new PlatformAuthError('rights_claim_open', 409, 'An unresolved rights claim blocks publication.');
    }

    await client.query(`
      UPDATE tracks SET status = 'in_review', visibility = 'private', rights_confirmed_at = $2,
        rights_offer_version = $3, published_at = NULL
      WHERE id = $1
    `, [trackId, now, offerVersion]);
    const queue = await client.query(`
      INSERT INTO moderation_queue (track_id, reason, status)
      VALUES ($1, 'owner_submission', 'pending')
      RETURNING id, status, created_at AS "createdAt"
    `, [trackId]);
    await writeAudit(client, {
      actorId: actor.id,
      action: 'track.submitted_for_moderation',
      targetType: 'track',
      targetId: trackId,
      reason: 'rights_confirmed',
      details: { moderationId: queue.rows[0].id, offerVersion },
      requestId,
    });
    return { id: trackId, status: 'in_review', visibility: 'private', moderation: queue.rows[0] };
  });
}

/**
 * Moderator/admin reads only pending, assigned and escalated items.
 * @param {import('pg').Pool} pool
 * @param {{id: string, role: string}} actor
 * @param {{status?: string, limit?: number|string, offset?: number|string}} [options]
 */
export async function listModerationQueue(pool, actor, { status, limit = 50, offset = 0 } = {}) {
  requireModerator(actor);
  if (status !== undefined && !ACTIVE_QUEUE_STATUSES.includes(status)) {
    throw invalidInput('status must be pending, assigned or escalated.');
  }
  const safeLimit = Number(limit);
  const safeOffset = Number(offset);
  if (!Number.isInteger(safeLimit) || safeLimit < 1 || safeLimit > 100) throw invalidInput('limit must be between 1 and 100.');
  if (!Number.isInteger(safeOffset) || safeOffset < 0 || safeOffset > 100_000) throw invalidInput('offset is outside the allowed range.');

  const result = await pool.query(`
    SELECT m.id, m.track_id AS "trackId", m.reason, m.auto_score::double precision AS "autoScore", m.status,
      m.assignee_id AS "assigneeId", m.created_at AS "createdAt",
      t.owner_id AS "ownerId", t.title, t.artist_display AS artist, t.genre, t.mood,
      t.duration_ms AS "durationMs", t.rights_confirmed_at AS "rightsConfirmedAt",
      t.rights_offer_version AS "rightsOfferVersion"
    FROM moderation_queue m
    JOIN tracks t ON t.id = m.track_id
    WHERE m.status IN ('pending', 'assigned', 'escalated')
      AND ($1::text IS NULL OR m.status = $1)
    ORDER BY CASE m.status WHEN 'escalated' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
      m.created_at ASC, m.id ASC
    LIMIT $2 OFFSET $3
  `, [status ?? null, safeLimit, safeOffset]);
  return result.rows;
}

/** Decision changes queue and track state atomically; published trigger verifies latest approval. */
export async function decideModeration(pool, moderationId, actor, input, { nowMs = Date.now(), requestId = null } = {}) {
  validateUuid(moderationId, 'Moderation item not found.');
  requireModerator(actor);
  const decision = input?.decision;
  if (!['approve', 'reject', 'escalate'].includes(decision)) {
    throw invalidInput('decision must be approve, reject or escalate.');
  }
  const reason = normalizeReason(input?.reason);
  const now = new Date(nowMs);

  return withTransaction(pool, async (client) => {
    // Mutations lock the track before its queue rows; keep this lock order consistent
    // with metadata edits and rights claims to avoid track/queue deadlocks.
    const lookup = await client.query('SELECT track_id FROM moderation_queue WHERE id = $1', [moderationId]);
    if (!lookup.rows[0]) throw new PlatformAuthError('not_found', 404, 'Moderation item not found.');
    const lockedTrack = await client.query(`
      SELECT id FROM tracks WHERE id = $1 FOR UPDATE
    `, [lookup.rows[0].track_id]);
    if (!lockedTrack.rows[0]) throw new PlatformAuthError('not_found', 404, 'Track not found.');

    const result = await client.query(`
      SELECT m.id, m.track_id, m.status AS moderation_status,
        t.owner_id, t.status AS track_status, t.rights_confirmed_at, t.rights_offer_version
      FROM moderation_queue m
      JOIN tracks t ON t.id = m.track_id
      WHERE m.id = $1
      FOR UPDATE OF m
    `, [moderationId]);
    const item = result.rows[0];
    if (!item) throw new PlatformAuthError('not_found', 404, 'Moderation item not found.');
    if (!ACTIVE_QUEUE_STATUSES.includes(item.moderation_status)) {
      throw new PlatformAuthError('moderation_already_decided', 409, 'Moderation item is no longer active.');
    }
    const latest = await client.query(`
      SELECT id FROM moderation_queue WHERE track_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1
    `, [item.track_id]);
    if (latest.rows[0]?.id !== item.id) {
      throw new PlatformAuthError('stale_moderation_item', 409, 'A newer moderation item exists for this track.');
    }

    if (decision === 'escalate') {
      await client.query(`
        UPDATE moderation_queue SET status = 'escalated', assignee_id = $2, decision = $3, decided_at = NULL
        WHERE id = $1
      `, [moderationId, actor.id, reason]);
      await writeAudit(client, {
        actorId: actor.id, action: 'moderation.escalated', targetType: 'moderation', targetId: moderationId,
        reason, details: { trackId: item.track_id }, requestId,
      });
      return { id: moderationId, trackId: item.track_id, status: 'escalated' };
    }

    if (item.track_status !== 'in_review') {
      throw new PlatformAuthError('track_not_in_review', 409, 'Track is not in the moderation review state.');
    }
    if (decision === 'approve') {
      if (!item.rights_confirmed_at || !item.rights_offer_version) {
        throw new PlatformAuthError('rights_confirmation_required', 409, 'Track has no recorded rights confirmation.');
      }
      const openClaim = await client.query(`
        SELECT 1 FROM rights_claims WHERE track_id = $1 AND status IN ('open', 'counter_notice', 'accepted') LIMIT 1
      `, [item.track_id]);
      if (openClaim.rows.length) {
        throw new PlatformAuthError('rights_claim_open', 409, 'An unresolved rights claim blocks publication.');
      }
    }

    const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
    await client.query(`
      UPDATE moderation_queue SET status = $2, assignee_id = $3, decision = $4, decided_at = $5
      WHERE id = $1
    `, [moderationId, nextStatus, actor.id, reason, now]);
    if (decision === 'approve') {
      await client.query(`
        UPDATE tracks SET status = 'published', visibility = 'public', published_at = $2 WHERE id = $1
      `, [item.track_id, now]);
      await client.query(`
        UPDATE media_objects SET lifecycle_state = 'ready'
        WHERE track_id = $1 AND lifecycle_state = 'quarantine'
      `, [item.track_id]);
    } else {
      await client.query(`
        UPDATE tracks SET status = 'rejected', visibility = 'private', published_at = NULL WHERE id = $1
      `, [item.track_id]);
    }
    await writeAudit(client, {
      actorId: actor.id,
      action: decision === 'approve' ? 'moderation.approved' : 'moderation.rejected',
      targetType: 'moderation', targetId: moderationId, reason,
      details: { trackId: item.track_id }, requestId,
    });
    return { id: moderationId, trackId: item.track_id, status: nextStatus };
  });
}

/** Public rights-holder notice; public tracks are immediately hidden pending review. */
export async function createRightsClaim(pool, input, { nowMs = Date.now(), requestId = null } = {}) {
  const trackId = validateUuid(input?.trackId, 'Track not found.');
  const claimantEmail = normalizeEmail(input?.claimantEmail);
  if (typeof input?.claimantName !== 'string' || input.claimantName.trim().length < 1 || input.claimantName.trim().length > 120) {
    throw invalidInput('claimantName must be between 1 and 120 characters.');
  }
  const claimantName = input.claimantName.trim();
  const evidenceUrl = validateHttpsUrl(input?.evidenceUrl, 'evidenceUrl');
  const claimText = normalizeReason(input?.claimText, { min: 20, max: 5000, label: 'claimText' });
  const now = new Date(nowMs);

  return withTransaction(pool, async (client) => {
    const trackResult = await client.query(`
      SELECT id, status, visibility FROM tracks WHERE id = $1 FOR UPDATE
    `, [trackId]);
    const track = trackResult.rows[0];
    if (!track) throw new PlatformAuthError('not_found', 404, 'Track not found.');
    const claimResult = await client.query(`
      INSERT INTO rights_claims (track_id, claimant_email, claimant_name, evidence_url, claim_text, created_at, sla_due_at)
      VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + interval '24 hours')
      RETURNING id, track_id AS "trackId", status, created_at AS "createdAt", sla_due_at AS "slaDueAt"
    `, [trackId, claimantEmail, claimantName, evidenceUrl, claimText, now]);
    const claim = claimResult.rows[0];
    await writeAudit(client, {
      action: 'rights_claim.created', targetType: 'rights_claim', targetId: claim.id,
      reason: 'rights_holder_notice', details: { trackId }, requestId,
    });

    if (track.status === 'published' || track.status === 'in_review') {
      await client.query(`
        UPDATE tracks SET status = 'taken_down', visibility = 'private', published_at = NULL WHERE id = $1
      `, [trackId]);
      await client.query(`
        UPDATE moderation_queue SET status = 'superseded', assignee_id = NULL, decision = NULL
        WHERE track_id = $1 AND status IN ('pending', 'assigned', 'escalated')
      `, [trackId]);
      await client.query(`
        UPDATE media_objects SET lifecycle_state = 'pending_delete'
        WHERE track_id = $1 AND lifecycle_state IN ('quarantine', 'ready')
      `, [trackId]);
      await client.query(`
        INSERT INTO platform_outbox (topic, aggregate_id, payload, idempotency_key)
        VALUES ('media.delete.requested', $1, $2::jsonb, $3)
        ON CONFLICT (idempotency_key) DO NOTHING
      `, [trackId, JSON.stringify({ trackId }), `media-delete-claim-${claim.id}`]);
      await writeAudit(client, {
        action: 'track.taken_down', targetType: 'track', targetId: trackId,
        reason: 'open_rights_claim', details: { claimId: claim.id }, requestId,
      });
    }
    return claim;
  });
}

/** The track owner may file one counter-notice; the track remains unavailable while it is reviewed. */
export async function fileCounterNotice(pool, claimId, actor, input, { nowMs = Date.now(), requestId = null } = {}) {
  validateUuid(claimId, 'Rights claim not found.');
  const counterNoticeText = normalizeReason(input?.counterNoticeText, { min: 20, max: 5000, label: 'counterNoticeText' });
  const now = new Date(nowMs);
  return withTransaction(pool, async (client) => {
    const result = await client.query(`
      SELECT c.id, c.track_id, c.status, t.owner_id
      FROM rights_claims c JOIN tracks t ON t.id = c.track_id
      WHERE c.id = $1 FOR UPDATE OF c, t
    `, [claimId]);
    const claim = result.rows[0];
    if (!claim) throw new PlatformAuthError('not_found', 404, 'Rights claim not found.');
    requireOwnerOrAdmin(actor, claim.owner_id);
    if (claim.status !== 'open') {
      throw new PlatformAuthError('claim_not_open', 409, 'Only an open rights claim can receive a counter-notice.');
    }
    await client.query(`
      UPDATE rights_claims SET status = 'counter_notice', counter_notice_text = $2,
        counter_notice_at = $3, counter_notice_by = $4
      WHERE id = $1
    `, [claimId, counterNoticeText, now, actor.id]);
    await writeAudit(client, {
      actorId: actor.id, action: 'rights_claim.counter_notice', targetType: 'rights_claim', targetId: claimId,
      reason: 'owner_counter_notice', details: { trackId: claim.track_id }, requestId,
    });
    return { id: claimId, trackId: claim.track_id, status: 'counter_notice', counterNoticeAt: now };
  });
}

/**
 * Claims registry is restricted to platform administrators; claimant PII is never in public responses.
 * @param {import('pg').Pool} pool
 * @param {{id: string, role: string}} actor
 * @param {{status?: string, limit?: number|string, offset?: number|string}} [options]
 */
export async function listRightsClaims(pool, actor, { status, limit = 50, offset = 0 } = {}) {
  requireRole(actor, ['admin']);
  if (status !== undefined && !['open', 'accepted', 'rejected', 'counter_notice'].includes(status)) {
    throw invalidInput('Unsupported rights-claim status.');
  }
  const safeLimit = Number(limit);
  const safeOffset = Number(offset);
  if (!Number.isInteger(safeLimit) || safeLimit < 1 || safeLimit > 100) throw invalidInput('limit must be between 1 and 100.');
  if (!Number.isInteger(safeOffset) || safeOffset < 0 || safeOffset > 100_000) throw invalidInput('offset is outside the allowed range.');
  const result = await pool.query(`
    SELECT c.id, c.track_id AS "trackId", c.claimant_email AS "claimantEmail",
      c.claimant_name AS "claimantName", c.evidence_url AS "evidenceUrl", c.claim_text AS "claimText",
      c.status, c.created_at AS "createdAt", c.resolved_at AS "resolvedAt", c.sla_due_at AS "slaDueAt",
      c.counter_notice_text AS "counterNoticeText", c.counter_notice_at AS "counterNoticeAt",
      c.counter_notice_by AS "counterNoticeBy", t.title, t.artist_display AS artist, t.status AS "trackStatus"
    FROM rights_claims c JOIN tracks t ON t.id = c.track_id
    WHERE ($1::text IS NULL OR c.status = $1)
    ORDER BY CASE c.status WHEN 'open' THEN 0 WHEN 'counter_notice' THEN 1 ELSE 2 END,
      c.sla_due_at ASC, c.created_at ASC
    LIMIT $2 OFFSET $3
  `, [status ?? null, safeLimit, safeOffset]);
  return result.rows;
}
