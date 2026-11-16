// @ts-check
import { createHmac } from 'node:crypto';
import { Redis } from 'ioredis';
import { requirePlatformAuthSecret } from './auth-crypto.js';

const REDIS_PREFIX = 'vision-platform:rate-limit:v1:';
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_SUBJECT_LENGTH = 1_024;
const MAX_MEMORY_KEYS = 10_000;

const FIXED_WINDOW_SCRIPT = `
  local count = redis.call('INCR', KEYS[1])
  local ttl = redis.call('PTTL', KEYS[1])
  if count == 1 or ttl < 0 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
    ttl = tonumber(ARGV[1])
  end
  return { count, ttl }
`;

/** Safe starter policies for the closed alpha; limits are shared across API replicas through Redis. */
export const PLATFORM_RATE_LIMIT_POLICIES = Object.freeze({
  registerIp: Object.freeze({ scope: 'auth-register-ip', limit: 10, windowMs: 60 * 60 * 1_000 }),
  registerIdentity: Object.freeze({ scope: 'auth-register-identity', limit: 3, windowMs: 60 * 60 * 1_000 }),
  loginIp: Object.freeze({ scope: 'auth-login-ip', limit: 30, windowMs: 15 * 60 * 1_000 }),
  loginIdentity: Object.freeze({ scope: 'auth-login-identity', limit: 10, windowMs: 15 * 60 * 1_000 }),
  refreshIp: Object.freeze({ scope: 'auth-refresh-ip', limit: 60, windowMs: 15 * 60 * 1_000 }),
  publicReadIp: Object.freeze({ scope: 'public-read-ip', limit: 120, windowMs: 60 * 1_000 }),
  uploadIp: Object.freeze({ scope: 'upload-ip', limit: 10, windowMs: 60 * 1_000 }),
  eventIp: Object.freeze({ scope: 'events-ip', limit: 120, windowMs: 60 * 1_000 }),
  rightsClaimIp: Object.freeze({ scope: 'rights-claim-ip', limit: 5, windowMs: 60 * 60 * 1_000 }),
  radioSessionIp: Object.freeze({ scope: 'radio-session-ip', limit: 10, windowMs: 60 * 1_000 }),
  voiceRenderIp: Object.freeze({ scope: 'voice-render-ip', limit: 10, windowMs: 60 * 1_000 }),
  apiReadIp: Object.freeze({ scope: 'api-read-ip', limit: 120, windowMs: 60 * 1_000 }),
  apiWriteIp: Object.freeze({ scope: 'api-write-ip', limit: 60, windowMs: 60 * 1_000 }),
});

/** @typedef {{scope: string, subject: string, limit: number, windowMs: number}} RateLimitRequest */
/** @typedef {{allowed: boolean, limit: number, remaining: number, retryAfterMs: number, resetAtMs: number}} RateLimitDecision */

export class PlatformRateLimitUnavailableError extends Error {
  /** @param {unknown} [cause] */
  constructor(cause) {
    super('Platform rate-limit storage is unavailable.', cause === undefined ? undefined : { cause });
    this.name = 'PlatformRateLimitUnavailableError';
    this.code = 'rate_limit_unavailable';
  }
}

/** Validate a counter request before it can produce a Redis key or command. @param {RateLimitRequest} input */
function validateRequest(input) {
  if (!input || typeof input !== 'object') throw new Error('Rate-limit input is required.');
  if (typeof input.scope !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.scope)) {
    throw new Error('Rate-limit scope is invalid.');
  }
  if (typeof input.subject !== 'string' || input.subject.length < 1 || input.subject.length > MAX_SUBJECT_LENGTH) {
    throw new Error('Rate-limit subject is invalid.');
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000_000) {
    throw new Error('Rate-limit limit must be an integer between 1 and 1000000.');
  }
  if (!Number.isInteger(input.windowMs) || input.windowMs < 1_000 || input.windowMs > MAX_WINDOW_MS) {
    throw new Error('Rate-limit window must be between 1000 ms and 30 days.');
  }
  return input;
}

/** HMAC subjects so raw addresses, emails, or account IDs are never stored as Redis keys. */
function makeStorageKey(secret, { scope, subject }) {
  return `${REDIS_PREFIX}${createHmac('sha256', secret).update(`${scope}\0${subject}`, 'utf8').digest('hex')}`;
}

/** @param {number} count @param {number} ttlMs @param {number} limit @param {number} nowMs @returns {RateLimitDecision} */
function makeDecision(count, ttlMs, limit, nowMs) {
  const safeTtl = Math.max(1, Math.floor(ttlMs));
  const allowed = count <= limit;
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfterMs: allowed ? 0 : safeTtl,
    resetAtMs: nowMs + safeTtl,
  };
}

/**
 * In-memory implementation for isolated API tests only. Runtime startup injects the Redis implementation.
 * @param {{secret?: string|Buffer, now?: () => number}} [options]
 */
export function createInMemoryRateLimiter({ secret, now = Date.now } = {}) {
  const key = requirePlatformAuthSecret(secret);
  /** @type {Map<string, {count: number, resetAtMs: number}>} */
  const buckets = new Map();

  function prune(nowMs) {
    for (const [storageKey, bucket] of buckets) {
      if (bucket.resetAtMs <= nowMs) buckets.delete(storageKey);
    }
    while (buckets.size > MAX_MEMORY_KEYS) {
      const first = buckets.keys().next();
      if (first.done) break;
      buckets.delete(first.value);
    }
  }

  return Object.freeze({
    async ready() { return true; },
    async consume(rawInput) {
      const input = validateRequest(rawInput);
      const storageKey = makeStorageKey(key, input);
      const nowMs = now();
      let bucket = buckets.get(storageKey);
      if (!bucket || bucket.resetAtMs <= nowMs) {
        bucket = { count: 0, resetAtMs: nowMs + input.windowMs };
      }
      bucket.count += 1;
      buckets.set(storageKey, bucket);
      if (buckets.size > MAX_MEMORY_KEYS) prune(nowMs);
      return makeDecision(bucket.count, bucket.resetAtMs - nowMs, input.limit, nowMs);
    },
    async close() { buckets.clear(); },
  });
}

/**
 * Redis fixed-window limiter for API runtime. `consume` is atomic across API replicas;
 * Redis keys contain only keyed HMAC digests, never raw subjects.
 * @param {{redisUrl?: string, secret?: string|Buffer, client?: import('ioredis').Redis}} [options]
 */
export function createPlatformRateLimiter({ redisUrl = process.env.PLATFORM_REDIS_URL, secret, client } = {}) {
  const key = requirePlatformAuthSecret(secret);
  if (client === undefined && (typeof redisUrl !== 'string' || !/^rediss?:\/\//i.test(redisUrl))) {
    throw new Error('PLATFORM_REDIS_URL must be an explicit redis:// or rediss:// URL for platform rate limits.');
  }

  const ownsClient = client === undefined;
  const redis = client || new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    connectionName: 'vision-platform-api-rate-limit',
  });

  return Object.freeze({
    async ready() {
      try {
        // With offline queuing disabled, explicitly establish the connection before PING.
        if (redis.status === 'wait') await redis.connect();
        if (redis.status !== undefined && redis.status !== 'ready') {
          throw new Error('Redis is not ready for rate-limit commands.');
        }
        await redis.ping();
        return true;
      } catch (error) {
        throw new PlatformRateLimitUnavailableError(error);
      }
    },
    async consume(rawInput) {
      const input = validateRequest(rawInput);
      const storageKey = makeStorageKey(key, input);
      try {
        const result = await redis.eval(FIXED_WINDOW_SCRIPT, 1, storageKey, String(input.windowMs));
        const values = Array.isArray(result) ? result : [];
        const count = Number(values[0]);
        const ttlMs = Number(values[1]);
        if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(ttlMs) || ttlMs < 0) {
          throw new Error('Redis returned an invalid rate-limit counter.');
        }
        return makeDecision(count, ttlMs, input.limit, Date.now());
      } catch (error) {
        if (error instanceof PlatformRateLimitUnavailableError) throw error;
        throw new PlatformRateLimitUnavailableError(error);
      }
    },
    async close() {
      if (!ownsClient) return;
      if (redis.status === 'wait' || redis.status === 'end') return;
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    },
  });
}
