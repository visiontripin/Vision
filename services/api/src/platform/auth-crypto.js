// @ts-check
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 1024;

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_BYTES = 64;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Typed error safe for returning to API callers. */
export class PlatformAuthError extends Error {
  /** @param {string} code @param {number} status @param {string} message @param {ErrorOptions} [options] */
  constructor(code, status, message, options) {
    super(message, options);
    this.name = 'PlatformAuthError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Resolve the signing key without falling back to the legacy VISION_SECRET.
 * @param {string|Buffer|undefined} [secret]
 * @returns {Buffer}
 */
export function requirePlatformAuthSecret(secret = process.env.PLATFORM_AUTH_SECRET) {
  const key = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret || ''), 'utf8');
  if (key.length < 32) {
    throw new Error('PLATFORM_AUTH_SECRET must contain at least 32 bytes.');
  }
  return key;
}

/** @param {unknown} email */
export function normalizeEmail(email) {
  if (typeof email !== 'string') {
    throw new PlatformAuthError('invalid_input', 400, 'A valid email address is required.');
  }
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new PlatformAuthError('invalid_input', 400, 'A valid email address is required.');
  }
  return normalized;
}

/** @param {string|Buffer} password @param {Buffer} salt */
function derivePasswordKey(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAX_MEMORY,
    }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Scrypt hash string versioned for future parameter upgrades. */
export async function hashPassword(password) {
  if (
    typeof password !== 'string'
    || password.length < PASSWORD_MIN_LENGTH
    || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES
  ) {
    throw new PlatformAuthError(
      'invalid_input',
      400,
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters and at most ${PASSWORD_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await derivePasswordKey(Buffer.from(password, 'utf8'), salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

/**
 * Invalid or unsupported hashes return false. Scrypt parameters are deliberately
 * pinned so a corrupt database value cannot request unbounded CPU or memory.
 * @param {unknown} password
 * @param {unknown} encodedHash
 */
export async function verifyPassword(password, encodedHash) {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return false;
  if (typeof encodedHash !== 'string') return false;
  const parts = encodedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  if (parts[1] !== String(SCRYPT_N) || parts[2] !== String(SCRYPT_R) || parts[3] !== String(SCRYPT_P)) return false;
  if (!BASE64URL.test(parts[4]) || !BASE64URL.test(parts[5])) return false;

  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (salt.length !== SCRYPT_SALT_BYTES || expected.length !== SCRYPT_KEY_BYTES) return false;
  const actual = Buffer.from(await derivePasswordKey(Buffer.from(password, 'utf8'), salt));
  return timingSafeEqual(actual, expected);
}

/** Consume comparable password-hash work when an email has no account. */
export async function burnPasswordVerificationWork(password) {
  const candidate = typeof password === 'string' ? Buffer.from(password, 'utf8').subarray(0, PASSWORD_MAX_BYTES) : Buffer.alloc(0);
  await derivePasswordKey(candidate, Buffer.alloc(SCRYPT_SALT_BYTES));
}

/** A refresh token is opaque, random and stored only as a SHA-256 digest. */
export function createRefreshToken() {
  return randomBytes(32).toString('base64url');
}

/** @param {unknown} token */
export function hashRefreshToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== 32) return null;
  return createHash('sha256').update(bytes).digest();
}

/** @param {string} userId @param {string|Buffer|undefined} secret @param {number} [nowMs] */
export function issueAccessToken(userId, secret, nowMs = Date.now()) {
  const key = requirePlatformAuthSecret(secret);
  const issuedAt = Math.floor(nowMs / 1000);
  const claims = {
    iss: 'vision-platform',
    aud: 'vision-platform-api',
    sub: userId,
    iat: issuedAt,
    exp: issuedAt + ACCESS_TOKEN_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signed = `v1.${payload}`;
  const signature = createHmac('sha256', key).update(signed).digest('base64url');
  return {
    token: `${signed}.${signature}`,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  };
}

/** @param {unknown} token @param {string|Buffer|undefined} secret @param {number} [nowMs] */
export function verifyAccessToken(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string') return null;
  const [version, payload, signature, extra] = token.split('.');
  if (version !== 'v1' || !payload || !signature || extra !== undefined) return null;
  if (!BASE64URL.test(payload) || !BASE64URL.test(signature)) return null;

  let key;
  try {
    key = requirePlatformAuthSecret(secret);
  } catch {
    return null;
  }
  const signed = `${version}.${payload}`;
  const expectedSignature = createHmac('sha256', key).update(signed).digest();
  const actualSignature = Buffer.from(signature, 'base64url');
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  if (
    !claims
    || claims.iss !== 'vision-platform'
    || claims.aud !== 'vision-platform-api'
    || typeof claims.sub !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claims.sub)
    || !Number.isInteger(claims.iat)
    || !Number.isInteger(claims.exp)
    || claims.iat > nowSeconds + 60
    || claims.exp <= nowSeconds
    || claims.exp <= claims.iat
    || claims.exp - claims.iat > ACCESS_TOKEN_TTL_SECONDS
  ) return null;
  return claims;
}
