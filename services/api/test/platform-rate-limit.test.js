import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createPlatformServer } from '../src/platform/server.js';
import {
  createInMemoryRateLimiter,
  createPlatformRateLimiter,
  PlatformRateLimitUnavailableError,
} from '../src/platform/rate-limit.js';

const AUTH_SECRET = 'platform-rate-limit-tests-have-a-long-secret';
const REDIS_URL = process.env.PLATFORM_REDIS_URL;

describe('platform API rate limiting', () => {
  test('in-memory test limiter uses an atomic fixed window and resets after expiry', async () => {
    let now = 1_000;
    const limiter = createInMemoryRateLimiter({ secret: AUTH_SECRET, now: () => now });
    const request = { scope: 'test-login', subject: 'opaque-subject', limit: 2, windowMs: 5_000 };
    try {
      const first = await limiter.consume(request);
      const second = await limiter.consume(request);
      const third = await limiter.consume(request);
      assert.equal(first.allowed, true);
      assert.equal(first.remaining, 1);
      assert.equal(second.allowed, true);
      assert.equal(second.remaining, 0);
      assert.equal(third.allowed, false);
      assert.equal(third.retryAfterMs, 5_000);

      now += 5_000;
      const afterReset = await limiter.consume(request);
      assert.equal(afterReset.allowed, true);
      assert.equal(afterReset.remaining, 1);
    } finally {
      await limiter.close();
    }
  });

  test('Redis readiness opens a lazy connection before sending PING', async () => {
    let status = 'wait';
    let connected = false;
    const client = {
      get status() { return status; },
      async connect() { connected = true; status = 'ready'; },
      async ping() { assert.equal(connected, true); return 'PONG'; },
      async eval() { return [1, 1_000]; },
    };
    const limiter = createPlatformRateLimiter({ client, secret: AUTH_SECRET });
    assert.equal(await limiter.ready(), true);
  });

  test('Redis adapter uses HMAC-only keys and fails closed when Redis commands fail', async () => {
    const calls = [];
    const client = {
      async ping() { return 'PONG'; },
      async eval(script, keyCount, redisKey, windowMs) {
        calls.push({ script, keyCount, redisKey, windowMs });
        return [3, 30_000];
      },
    };
    const limiter = createPlatformRateLimiter({ client, secret: AUTH_SECRET });
    assert.equal(await limiter.ready(), true);
    const decision = await limiter.consume({
      scope: 'auth-login-identity',
      subject: 'artist@example.test',
      limit: 2,
      windowMs: 60_000,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.remaining, 0);
    assert.equal(decision.retryAfterMs, 30_000);
    assert.equal(calls[0].keyCount, 1);
    assert.match(calls[0].redisKey, /^vision-platform:rate-limit:v1:[a-f0-9]{64}$/);
    assert.equal(calls[0].redisKey.includes('artist@example.test'), false);
    assert.match(calls[0].script, /redis\.call\('INCR'/);
    assert.match(calls[0].script, /redis\.call\('PEXPIRE'/);

    const failingClient = {
      async ping() { throw new Error('synthetic Redis outage'); },
      async eval() { throw new Error('synthetic Redis outage'); },
    };
    const failingLimiter = createPlatformRateLimiter({ client: failingClient, secret: AUTH_SECRET });
    await assert.rejects(
      failingLimiter.ready(),
      (error) => error instanceof PlatformRateLimitUnavailableError && error.code === 'rate_limit_unavailable',
    );
    await assert.rejects(
      failingLimiter.consume({ scope: 'test-fail-closed', subject: 'client', limit: 1, windowMs: 1_000 }),
      (error) => error instanceof PlatformRateLimitUnavailableError && error.code === 'rate_limit_unavailable',
    );
  });

  test('shared Redis fixed window is enforced across limiter instances', {
    skip: !REDIS_URL && 'Set PLATFORM_REDIS_URL to run the Redis rate-limit integration test.',
  }, async () => {
    const subject = `rate-limit-integration-${randomUUID()}`;
    const options = { redisUrl: REDIS_URL, secret: AUTH_SECRET };
    const firstLimiter = createPlatformRateLimiter(options);
    const secondLimiter = createPlatformRateLimiter(options);
    try {
      await Promise.all([firstLimiter.ready(), secondLimiter.ready()]);
      const request = { scope: 'integration-shared-window', subject, limit: 2, windowMs: 60_000 };
      assert.equal((await firstLimiter.consume(request)).allowed, true);
      assert.equal((await secondLimiter.consume(request)).allowed, true);
      assert.equal((await firstLimiter.consume(request)).allowed, false);
    } finally {
      await Promise.all([firstLimiter.close(), secondLimiter.close()]);
    }
  });

  test('HTTP throttling is shared across API instances through Redis', {
    skip: !REDIS_URL && 'Set PLATFORM_REDIS_URL to run the Redis rate-limit integration test.',
  }, async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const options = { redisUrl: REDIS_URL, secret: AUTH_SECRET };
    const firstLimiter = createPlatformRateLimiter(options);
    const secondLimiter = createPlatformRateLimiter(options);
    const sharedScope = (limiter) => ({
      async ready() { return limiter.ready(); },
      consume(policy) { return limiter.consume({ ...policy, scope: `${policy.scope}-it-${suffix}` }); },
    });
    const servers = [
      createPlatformServer({ pool: {}, secret: AUTH_SECRET, rateLimiter: sharedScope(firstLimiter) }),
      createPlatformServer({ pool: {}, secret: AUTH_SECRET, rateLimiter: sharedScope(secondLimiter) }),
    ];

    async function listen(server) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      return `http://127.0.0.1:${address.port}`;
    }
    async function close(server) {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    async function uploadStatus(base) {
      const response = await fetch(`${base}/api/v2/uploads`, { method: 'POST' });
      return { response, body: await response.json() };
    }

    try {
      await Promise.all([firstLimiter.ready(), secondLimiter.ready()]);
      const [firstBase, secondBase] = await Promise.all(servers.map(listen));
      for (let attempt = 0; attempt < 6; attempt += 1) {
        assert.equal((await uploadStatus(firstBase)).response.status, 403);
      }
      for (let attempt = 0; attempt < 4; attempt += 1) {
        assert.equal((await uploadStatus(secondBase)).response.status, 403);
      }
      const blocked = await uploadStatus(firstBase);
      assert.equal(blocked.response.status, 429);
      assert.equal(blocked.body.error.code, 'rate_limited');
      assert.equal(blocked.response.headers.get('ratelimit-limit'), '10');
    } finally {
      await Promise.all(servers.map(close));
      await Promise.all([firstLimiter.close(), secondLimiter.close()]);
    }
  });
});
