// @ts-check
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_MS,
  PlatformAuthError,
  burnPasswordVerificationWork,
  createRefreshToken,
  hashPassword,
  hashRefreshToken,
  issueAccessToken,
  normalizeEmail,
  requirePlatformAuthSecret,
  verifyAccessToken,
  verifyPassword,
} from './auth-crypto.js';

const ROLES = new Set(['listener', 'artist', 'moderator', 'admin']);
const INVALID_CREDENTIALS = () => new PlatformAuthError('invalid_credentials', 401, 'Invalid email or password.');

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.primary_role,
    locale: row.locale,
    country: row.country,
    city: row.city,
    createdAt: row.created_at,
  };
}

function requireActiveUser(row) {
  if (!row || row.status !== 'active') throw INVALID_CREDENTIALS();
}

async function authBundle(client, user, { secret, nowMs = Date.now() }) {
  const refreshToken = createRefreshToken();
  const refreshExpiresAt = new Date(nowMs + REFRESH_TOKEN_TTL_MS);
  const access = issueAccessToken(user.id, secret, nowMs);
  const session = await client.query(`
    INSERT INTO refresh_sessions (user_id, token_hash, created_at, expires_at)
    VALUES ($1, $2, $3, $4)
    RETURNING id
  `, [user.id, hashRefreshToken(refreshToken), new Date(nowMs), refreshExpiresAt]);
  return {
    sessionId: session.rows[0].id,
    tokens: {
      user: publicUser(user),
      tokenType: 'Bearer',
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      accessExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      refreshExpiresAt: refreshExpiresAt.toISOString(),
    },
  };
}

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

function mapUniqueViolation(error, code, message) {
  if (error?.code === '23505') throw new PlatformAuthError(code, 409, message, { cause: error });
}

/**
 * @param {import('pg').Pool} pool
 * @param {{email: unknown, password: unknown, displayName: unknown}} input
 * @param {{secret?: string|Buffer, nowMs?: number}} [options]
 */
export async function registerWithPassword(pool, input, { secret, nowMs = Date.now() } = {}) {
  const key = requirePlatformAuthSecret(secret);
  const email = normalizeEmail(input?.email);
  if (typeof input?.displayName !== 'string') {
    throw new PlatformAuthError('invalid_input', 400, 'A display name is required.');
  }
  const displayName = input.displayName.trim();
  if (displayName.length < 1 || displayName.length > 120) {
    throw new PlatformAuthError('invalid_input', 400, 'Display name must be between 1 and 120 characters.');
  }
  const passwordHash = await hashPassword(input.password);

  try {
    return await withTransaction(pool, async (client) => {
      const result = await client.query(`
        INSERT INTO users (email, password_hash, display_name)
        VALUES ($1, $2, $3)
        RETURNING id, email, display_name, primary_role, status, locale, country, city, created_at
      `, [email, passwordHash, displayName]);
      const user = result.rows[0];
      return (await authBundle(client, user, { secret: key, nowMs })).tokens;
    });
  } catch (error) {
    mapUniqueViolation(error, 'email_in_use', 'An account with this email already exists.');
    throw error;
  }
}

/**
 * @param {import('pg').Pool} pool
 * @param {{email: unknown, password: unknown}} input
 * @param {{secret?: string|Buffer, nowMs?: number}} [options]
 */
export async function loginWithPassword(pool, input, { secret, nowMs = Date.now() } = {}) {
  const key = requirePlatformAuthSecret(secret);
  let email;
  try {
    email = normalizeEmail(input?.email);
  } catch {
    if (typeof input?.password === 'string') await burnPasswordVerificationWork(input.password);
    throw INVALID_CREDENTIALS();
  }
  if (typeof input?.password !== 'string' || Buffer.byteLength(input.password, 'utf8') > 1024) {
    await burnPasswordVerificationWork('invalid login');
    throw INVALID_CREDENTIALS();
  }

  const client = await pool.connect();
  let inTransaction = false;
  try {
    const found = await client.query(`
      SELECT id, email, password_hash, display_name, primary_role, status, locale, country, city, created_at
      FROM users WHERE lower(email) = $1 LIMIT 1
    `, [email]);
    const candidate = found.rows[0];
    const matches = candidate?.password_hash
      ? await verifyPassword(input.password, candidate.password_hash)
      : (await burnPasswordVerificationWork(input.password), false);
    if (!matches || candidate.status !== 'active') throw INVALID_CREDENTIALS();

    await client.query('BEGIN');
    inTransaction = true;
    const locked = await client.query(`
      SELECT id, email, password_hash, display_name, primary_role, status, locale, country, city, created_at
      FROM users WHERE id = $1 FOR UPDATE
    `, [candidate.id]);
    const user = locked.rows[0];
    requireActiveUser(user);
    if (user.password_hash !== candidate.password_hash && !await verifyPassword(input.password, user.password_hash)) {
      throw INVALID_CREDENTIALS();
    }

    const tokens = (await authBundle(client, user, { secret: key, nowMs })).tokens;
    await client.query('UPDATE users SET last_seen_at = $2 WHERE id = $1', [user.id, new Date(nowMs)]);
    await client.query('COMMIT');
    inTransaction = false;
    return tokens;
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * @param {import('pg').Pool} pool
 * @param {unknown} rawRefreshToken
 * @param {{secret?: string|Buffer, nowMs?: number}} [options]
 */
export async function rotateRefreshToken(pool, rawRefreshToken, { secret, nowMs = Date.now() } = {}) {
  const key = requirePlatformAuthSecret(secret);
  const tokenHash = hashRefreshToken(rawRefreshToken);
  if (!tokenHash) throw new PlatformAuthError('invalid_refresh_token', 401, 'Refresh token is invalid or expired.');

  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    const result = await client.query(`
      SELECT s.id AS session_id, s.user_id, s.expires_at, s.rotated_to, s.revoked_at,
        u.id, u.email, u.display_name, u.primary_role, u.status, u.locale, u.country, u.city, u.created_at
      FROM refresh_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
      FOR UPDATE OF s
    `, [tokenHash]);
    const current = result.rows[0];
    if (!current) throw new PlatformAuthError('invalid_refresh_token', 401, 'Refresh token is invalid or expired.');

    if (current.rotated_to) {
      await client.query(`
        UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, $2)
        WHERE user_id = $1
      `, [current.user_id, new Date(nowMs)]);
      await client.query('COMMIT');
      inTransaction = false;
      throw new PlatformAuthError('refresh_reuse', 401, 'Refresh token reuse detected; sign in again.');
    }
    if (current.status !== 'active') {
      await client.query(`
        UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, $2)
        WHERE user_id = $1
      `, [current.user_id, new Date(nowMs)]);
      await client.query('COMMIT');
      inTransaction = false;
      throw new PlatformAuthError('invalid_refresh_token', 401, 'Refresh token is invalid or expired.');
    }
    if (current.revoked_at || new Date(current.expires_at).getTime() <= nowMs) {
      throw new PlatformAuthError('invalid_refresh_token', 401, 'Refresh token is invalid or expired.');
    }

    const issued = await authBundle(client, current, { secret: key, nowMs });
    const updated = await client.query(`
      UPDATE refresh_sessions SET rotated_to = $2, revoked_at = $3
      WHERE id = $1 AND rotated_to IS NULL AND revoked_at IS NULL
    `, [current.session_id, issued.sessionId, new Date(nowMs)]);
    if (updated.rowCount !== 1) {
      throw new PlatformAuthError('invalid_refresh_token', 401, 'Refresh token is invalid or expired.');
    }

    await client.query('UPDATE users SET last_seen_at = $2 WHERE id = $1', [current.user_id, new Date(nowMs)]);
    await client.query('COMMIT');
    inTransaction = false;
    return issued.tokens;
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** @param {unknown} rawRefreshToken */
export async function revokeRefreshToken(pool, rawRefreshToken, { nowMs = Date.now() } = {}) {
  const tokenHash = hashRefreshToken(rawRefreshToken);
  if (!tokenHash) return false;
  const result = await pool.query(`
    UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, $2)
    WHERE token_hash = $1 AND revoked_at IS NULL
  `, [tokenHash, new Date(nowMs)]);
  return result.rowCount === 1;
}

/**
 * Verifies the bearer signature and reloads current status/role from Postgres.
 * @param {import('pg').Pool} pool
 * @param {unknown} accessToken
 * @param {{secret?: string|Buffer, nowMs?: number}} [options]
 */
export async function getCurrentUser(pool, accessToken, { secret, nowMs = Date.now() } = {}) {
  const claims = verifyAccessToken(accessToken, secret, nowMs);
  if (!claims) throw new PlatformAuthError('invalid_access_token', 401, 'Access token is invalid or expired.');
  const result = await pool.query(`
    SELECT id, email, display_name, primary_role, status, locale, country, city, created_at
    FROM users WHERE id = $1 AND status = 'active'
  `, [claims.sub]);
  if (!result.rows[0]) throw new PlatformAuthError('invalid_access_token', 401, 'Access token is invalid or expired.');
  return publicUser(result.rows[0]);
}

/** @param {{id: string, role: string}} actor @param {string[]} allowedRoles */
export function requireRole(actor, allowedRoles) {
  if (!actor || !allowedRoles.includes(actor.role)) {
    throw new PlatformAuthError('forbidden', 403, 'This action is not allowed for your role.');
  }
  return actor;
}

/** Owners can manage their records; only administrators can override ownership. */
export function requireOwnerOrAdmin(actor, ownerId) {
  if (!actor || (actor.id !== ownerId && actor.role !== 'admin')) {
    throw new PlatformAuthError('forbidden', 403, 'You do not own this resource.');
  }
  return actor;
}

export function requireModerator(actor) {
  return requireRole(actor, ['moderator', 'admin']);
}

/** A self-service artist profile requires an explicit rights/offer acknowledgement. */
export async function createArtistProfile(pool, userId, input, { nowMs = Date.now() } = {}) {
  if (input?.rightsConfirmed !== true) {
    throw new PlatformAuthError('rights_confirmation_required', 400, 'Confirm that you have the rights to publish your uploads.');
  }
  if (typeof input?.offerVersion !== 'string' || input.offerVersion.trim().length < 1 || input.offerVersion.length > 100) {
    throw new PlatformAuthError('invalid_input', 400, 'A valid offer version is required.');
  }
  if (typeof input?.stageName !== 'string') {
    throw new PlatformAuthError('invalid_input', 400, 'A stage name is required.');
  }
  const stageName = input.stageName.trim();
  if (stageName.length < 1 || stageName.length > 120) {
    throw new PlatformAuthError('invalid_input', 400, 'Stage name must be between 1 and 120 characters.');
  }
  const bio = typeof input.bio === 'string' ? input.bio.trim() : '';
  if (bio.length > 5000) throw new PlatformAuthError('invalid_input', 400, 'Bio must be no longer than 5000 characters.');
  const links = input.links === undefined ? [] : input.links;
  if (!Array.isArray(links) || links.length > 10 || !links.every((link) => {
    if (typeof link !== 'string' || link.length > 2048) return false;
    try {
      return new URL(link).protocol === 'https:';
    } catch {
      return false;
    }
  })) {
    throw new PlatformAuthError('invalid_input', 400, 'Links must be HTTPS URLs; at most 10 are allowed.');
  }

  try {
    return await withTransaction(pool, async (client) => {
      const userResult = await client.query(`
        SELECT id, status FROM users WHERE id = $1 FOR UPDATE
      `, [userId]);
      if (userResult.rows[0]?.status !== 'active') {
        throw new PlatformAuthError('invalid_access_token', 401, 'Access token is invalid or expired.');
      }
      const now = new Date(nowMs);
      const profile = await client.query(`
        INSERT INTO artist_profiles (user_id, stage_name, bio, links, rights_confirmed_at, offer_version)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
        RETURNING user_id, stage_name, bio, links, verified, rights_confirmed_at, offer_version, created_at, updated_at
      `, [userId, stageName, bio, JSON.stringify(links), now, input.offerVersion.trim()]);
      await client.query(`
        UPDATE users SET primary_role = CASE WHEN primary_role = 'listener' THEN 'artist' ELSE primary_role END
        WHERE id = $1
      `, [userId]);
      return profile.rows[0];
    });
  } catch (error) {
    mapUniqueViolation(error, 'artist_profile_conflict', 'An artist profile or stage name already exists.');
    throw error;
  }
}

const PROFILE_FIELDS = {
  displayName: 'display_name',
  locale: 'locale',
  country: 'country',
  city: 'city',
};

/** Updates only explicitly editable self-profile columns. */
export async function updateCurrentUserProfile(pool, userId, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new PlatformAuthError('invalid_input', 400, 'A profile object is required.');
  }
  const fields = [];
  const values = [];
  for (const [key, column] of Object.entries(PROFILE_FIELDS)) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (typeof value !== 'string') throw new PlatformAuthError('invalid_input', 400, `Invalid ${key}.`);
    const trimmed = value.trim();
    if ((key === 'displayName' && (trimmed.length < 1 || trimmed.length > 120))
      || (key === 'locale' && !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(trimmed))
      || (key === 'country' && trimmed !== '' && !/^[A-Za-z]{2}$/.test(trimmed))
      || (key === 'city' && trimmed.length > 120)) {
      throw new PlatformAuthError('invalid_input', 400, `Invalid ${key}.`);
    }
    fields.push(`${column} = $${values.length + 2}`);
    values.push(key === 'country' && trimmed ? trimmed.toUpperCase() : trimmed || null);
  }
  if (!fields.length) throw new PlatformAuthError('invalid_input', 400, 'No editable profile fields were provided.');
  values.unshift(userId);
  const result = await pool.query(`
    UPDATE users SET ${fields.join(', ')}
    WHERE id = $1 AND status = 'active'
    RETURNING id, email, display_name, primary_role, status, locale, country, city, created_at
  `, values);
  if (!result.rows[0]) throw new PlatformAuthError('invalid_access_token', 401, 'Access token is invalid or expired.');
  return publicUser(result.rows[0]);
}
