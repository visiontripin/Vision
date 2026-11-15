// @ts-check
import { PlatformAuthError } from './auth-crypto.js';
import { requireOwnerOrAdmin } from './identity.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATCH_FIELDS = new Set(['title', 'artistDisplay', 'album', 'genre', 'mood']);

function invalidInput(message) {
  return new PlatformAuthError('invalid_input', 400, message);
}

function publicTrack(row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist_display,
    album: row.album,
    genre: row.genre,
    mood: row.mood,
    durationMs: row.duration_ms,
    plays: Number(row.plays),
    publishedAt: row.published_at,
  };
}

function queryString(params, name, { maxLength = 120 } = {}) {
  const raw = params.get(name);
  if (raw === null) return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.length > maxLength) throw invalidInput(`${name} is too long.`);
  return value;
}

function integerParam(params, name, fallback, max) {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw invalidInput(`${name} must be a non-negative integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) throw invalidInput(`${name} is outside the allowed range.`);
  return value;
}

function parseCatalogQuery(params) {
  const q = queryString(params, 'q');
  const genre = queryString(params, 'genre', { maxLength: 100 });
  const mood = queryString(params, 'mood', { maxLength: 50 });
  const sort = params.get('sort') || 'recent';
  if (!['recent', 'relevance', 'popular', 'title'].includes(sort)) {
    throw invalidInput('Unsupported catalog sort.');
  }
  const limit = integerParam(params, 'limit', 20, 100);
  if (limit < 1) throw invalidInput('limit must be between 1 and 100.');
  const offset = integerParam(params, 'offset', 0, 100_000);
  return { q, genre, mood, sort: sort === 'relevance' && !q ? 'recent' : sort, limit, offset };
}

const PUBLIC_WHERE = `
  t.status = 'published'
  AND t.visibility = 'public'
  AND t.rights_confirmed_at IS NOT NULL
  AND ($1::text IS NULL OR to_tsvector('simple', coalesce(t.title, '') || ' ' || coalesce(t.artist_display, ''))
       @@ plainto_tsquery('simple', $1))
  AND ($2::text IS NULL OR t.genre = $2)
  AND ($3::text IS NULL OR $3 = ANY(t.mood))
`;

/** Public catalog filters always require published visibility and rights confirmation. */
export async function listPublicCatalog(pool, searchParams) {
  const query = parseCatalogQuery(searchParams);
  const common = [query.q, query.genre, query.mood];
  const total = await pool.query(`SELECT COUNT(*)::int AS total FROM tracks t WHERE ${PUBLIC_WHERE}`, common);
  const order = query.sort === 'popular'
    ? 't.plays DESC, t.published_at DESC, t.id'
    : query.sort === 'title'
      ? 'lower(t.title) ASC, t.id'
      : query.sort === 'relevance' && query.q
        ? `ts_rank(to_tsvector('simple', coalesce(t.title, '') || ' ' || coalesce(t.artist_display, '')),
            plainto_tsquery('simple', $1)) DESC, t.published_at DESC, t.id`
        : 't.published_at DESC, t.id';
  const result = await pool.query(`
    SELECT t.id, t.title, t.artist_display, t.album, t.genre, t.mood, t.duration_ms, t.plays, t.published_at
    FROM tracks t
    WHERE ${PUBLIC_WHERE}
    ORDER BY ${order}
    LIMIT $4 OFFSET $5
  `, [...common, query.limit, query.offset]);
  return {
    items: result.rows.map(publicTrack),
    total: total.rows[0].total,
    limit: query.limit,
    offset: query.offset,
  };
}

/**
 * A private or quarantined record is only visible to its owner or an administrator;
 * non-owners receive the same 404 as an unknown id to avoid object enumeration.
 * @param {import('pg').Pool} pool
 * @param {unknown} trackId
 * @param {{id: string, role: string}|null} actor
 */
export async function getTrackForActor(pool, trackId, actor) {
  if (typeof trackId !== 'string' || !UUID.test(trackId)) {
    throw new PlatformAuthError('not_found', 404, 'Track not found.');
  }
  const result = await pool.query(`
    SELECT id, owner_id, title, artist_display, album, genre, mood, duration_ms, plays,
      published_at, rights_confirmed_at, status, visibility
    FROM tracks WHERE id = $1
  `, [trackId]);
  const row = result.rows[0];
  if (!row) throw new PlatformAuthError('not_found', 404, 'Track not found.');

  const isPublic = row.status === 'published' && row.visibility === 'public' && row.rights_confirmed_at;
  if (isPublic) return publicTrack(row);
  if (!actor) throw new PlatformAuthError('not_found', 404, 'Track not found.');
  try {
    requireOwnerOrAdmin(actor, row.owner_id);
  } catch {
    throw new PlatformAuthError('not_found', 404, 'Track not found.');
  }
  return {
    ...publicTrack(row),
    ownerId: row.owner_id,
    status: row.status,
    visibility: row.visibility,
  };
}

function normalizeStringField(value, field, max, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw invalidInput(`${field} must be a string${nullable ? ' or null' : ''}.`);
  const result = value.trim();
  if (!result && nullable) return null;
  if (result.length < 1 || result.length > max) throw invalidInput(`${field} has an invalid length.`);
  return result;
}

function normalizePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalidInput('A metadata object is required.');
  const unknown = Object.keys(patch).find((key) => !PATCH_FIELDS.has(key));
  if (unknown) throw invalidInput(`Unknown metadata field: ${unknown}.`);
  const fields = [];
  const values = [];
  for (const key of ['title', 'artistDisplay', 'album', 'genre', 'mood']) {
    if (!(key in patch)) continue;
    if (key === 'mood') {
      if (!Array.isArray(patch.mood) || patch.mood.length > 10
        || !patch.mood.every((item) => typeof item === 'string' && item.trim().length > 0 && item.trim().length <= 50)) {
        throw invalidInput('mood must contain at most 10 non-empty strings of at most 50 characters.');
      }
      fields.push('mood =');
      values.push(patch.mood.map((item) => item.trim()));
      continue;
    }
    const column = key === 'artistDisplay' ? 'artist_display' : key;
    const max = key === 'title' || key === 'artistDisplay' ? 300 : 100;
    const nullable = key === 'album' || key === 'genre';
    fields.push(`${column} =`);
    values.push(normalizeStringField(patch[key], key, max, { nullable }));
  }
  if (!fields.length) throw invalidInput('No editable metadata fields were provided.');
  return { fields, values };
}

/**
 * Metadata edits are ownership checked under a row lock. Editing a published/in-review
 * item makes it private and creates a fresh pending decision so an old approval cannot
 * authorize changed content.
 * @param {import('pg').Pool} pool
 * @param {unknown} trackId
 * @param {{id: string, role: string}} actor
 * @param {unknown} patch
 */
export async function updateTrackMetadata(pool, trackId, actor, patch, { requestId = null } = {}) {
  if (typeof trackId !== 'string' || !UUID.test(trackId)) {
    throw new PlatformAuthError('not_found', 404, 'Track not found.');
  }
  const normalized = normalizePatch(patch);
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    const currentResult = await client.query(`
      SELECT id, owner_id, status, visibility FROM tracks WHERE id = $1 FOR UPDATE
    `, [trackId]);
    const current = currentResult.rows[0];
    if (!current) throw new PlatformAuthError('not_found', 404, 'Track not found.');
    requireOwnerOrAdmin(actor, current.owner_id);
    if (current.status === 'taken_down') {
      throw new PlatformAuthError('track_takedown', 409, 'Taken-down tracks cannot be edited through this endpoint.');
    }

    const sets = normalized.fields.map((field, index) => `${field} $${index + 2}`);
    const nextState = current.status === 'published' || current.status === 'in_review';
    if (current.status === 'published') sets.push("status = 'in_review'", "visibility = 'private'", 'published_at = NULL');
    if (nextState) {
      await client.query(`
        UPDATE moderation_queue SET status = 'superseded', assignee_id = NULL, decision = NULL
        WHERE track_id = $1 AND status IN ('pending', 'assigned', 'escalated')
      `, [trackId]);
    }
    const update = await client.query(`
      UPDATE tracks SET ${sets.join(', ')} WHERE id = $1
      RETURNING id, owner_id, title, artist_display, album, genre, mood, duration_ms, plays,
        published_at, rights_confirmed_at, status, visibility
    `, [trackId, ...normalized.values]);
    if (nextState) {
      await client.query(`
        INSERT INTO moderation_queue (track_id, reason, status)
        VALUES ($1, 'metadata_changed', 'pending')
      `, [trackId]);
    }
    await client.query(`
      INSERT INTO platform_audit_events (actor_id, action, target_type, target_id, reason, details, request_id)
      VALUES ($1, 'track.metadata_updated', 'track', $2, 'owner_metadata_edit', $3::jsonb, $4)
    `, [actor.id, trackId, JSON.stringify({ fields: normalized.fields.map((field) => field.split(' ')[0]) }), requestId]);
    await client.query('COMMIT');
    inTransaction = false;
    return {
      ...publicTrack(update.rows[0]),
      ownerId: update.rows[0].owner_id,
      status: update.rows[0].status,
      visibility: update.rows[0].visibility,
    };
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
