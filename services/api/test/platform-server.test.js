import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import openapiTS from 'openapi-typescript';
import { createPlatformServer } from '../src/platform/server.js';
import { createInMemoryRateLimiter } from '../src/platform/rate-limit.js';
import { runPlatformMigrations } from '../src/platform/migrations.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/platform/migrations/', import.meta.url));
const AUTH_SECRET = 'platform-http-test-secret-at-least-32-bytes';
let database;
let pool;

async function applyPlatformMigrations() {
  database = new PGlite({ extensions: { vector } });
  await database.waitReady;
  const query = async (sql, values) => {
    if (values?.length) return database.query(sql, values);
    const results = await database.exec(sql);
    return results.at(-1) ?? { rows: [] };
  };
  const client = { query, release() {} };
  pool = { connect: async () => client, query };
  await runPlatformMigrations(pool, { directory: MIGRATIONS_DIR });
}

async function withServer(options, callback) {
  const rateLimiter = options.rateLimiter || createInMemoryRateLimiter({ secret: AUTH_SECRET });
  const server = createPlatformServer({ pool, secret: AUTH_SECRET, ...options, rateLimiter });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await callback(base);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rateLimiter.close?.();
  }
}

async function request(base, pathname, { method = 'GET', body, token, headers: extraHeaders = {} } = {}) {
  const headers = { ...extraHeaders };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

before(applyPlatformMigrations);
after(async () => {
  if (database) await database.close();
});

describe('isolated v2 platform HTTP API', () => {
  test('health and OpenAPI are served from the isolated platform process', async () => {
    await withServer({ registrationEnabled: false }, async (base) => {
      const health = await request(base, '/api/v2/health');
      assert.equal(health.response.status, 200);
      assert.equal(health.body.schemaReady, true);
      assert.equal(health.body.rateLimitReady, true);
      assert.equal(health.body.migration, '008_playback_sessions.sql');
      assert.equal(health.body.requiredMigration, '008_playback_sessions.sql');
      assert.ok(health.response.headers.get('x-request-id'));
      assert.equal(health.response.headers.get('cache-control'), 'no-store');

      const openapi = await request(base, '/api/v2/openapi.json');
      assert.equal(openapi.response.status, 200);
      assert.equal(openapi.body.openapi, '3.1.0');
      assert.equal(openapi.body.paths['/api/v2/health'].get.responses['200'].content['application/json'].schema.$ref,
        '#/components/schemas/PlatformHealthResponse');
      assert.ok(openapi.body.paths['/api/v2/auth/register']);
      assert.ok(openapi.body.paths['/api/v2/me'].patch);
      assert.ok(openapi.body.paths['/api/v2/catalog'].get);
      assert.ok(openapi.body.paths['/api/v2/tracks/{id}'].patch);
      assert.ok(openapi.body.paths['/api/v2/tracks/{id}/publish'].post);
      assert.ok(openapi.body.paths['/api/v2/moderation/queue'].get);
      assert.ok(openapi.body.paths['/api/v2/moderation/{id}/decision'].post);
      assert.ok(openapi.body.paths['/api/v2/claims'].post);
      assert.ok(openapi.body.paths['/api/v2/claims/{id}/counter'].post);
      assert.ok(openapi.body.paths['/api/v2/admin/claims'].get);
      assert.ok(openapi.body.paths['/api/v2/uploads'].post);
      assert.ok(openapi.body.paths['/api/v2/uploads/{id}/complete'].post);
      assert.ok(openapi.body.paths['/api/v2/playback/sessions'].post);
      assert.ok(openapi.body.paths['/api/v2/playback/sessions/{sessionId}/revoke'].post);
      assert.ok(openapi.body.paths['/api/v2/events'].post);
      assert.ok(openapi.body.paths['/api/v2/recommendations'].get);
      assert.ok(openapi.body.paths['/api/v2/radio/session'].post);
      assert.ok(openapi.body.paths['/api/v2/radio/{sessionId}/next'].get);
      assert.ok(openapi.body.paths['/api/v2/radio/{sessionId}/skip'].post);
      assert.ok(openapi.body.paths['/api/v2/radio/{sessionId}/feedback'].post);
      assert.ok(openapi.body.paths['/api/v2/voice/render'].post);
      const throttleResponse = openapi.body.paths['/api/v2/auth/login'].post.responses['429'];
      assert.match(throttleResponse.description, /retry/i);
      assert.equal(throttleResponse.headers['Retry-After'].schema.type, 'integer');
      assert.equal(throttleResponse.content['application/json'].schema.$ref, '#/components/schemas/Error');
      const unavailableResponse = openapi.body.paths['/api/v2/catalog'].get.responses['503'];
      assert.match(unavailableResponse.description, /unavailable/i);
      assert.equal(unavailableResponse.content['application/json'].schema.$ref, '#/components/schemas/Error');
      for (const [path, pathItem] of Object.entries(openapi.body.paths)) {
        if (path === '/api/v2/health' || path === '/api/v2/openapi.json') continue;
        for (const operation of Object.values(pathItem)) {
          if (!operation || typeof operation !== 'object' || !('operationId' in operation)) continue;
          assert.ok(operation.responses['429'], `${path} must document rate limiting`);
          assert.ok(operation.responses['503'], `${path} must document fail-closed rate-limit storage errors`);
        }
      }
      const generatedContract = await openapiTS(openapi.body);
      assert.ok(generatedContract.length > 0, 'platform OpenAPI compiles into client types');
    });
  });

  test('health fails closed when the database is behind the API migration requirement', async () => {
    const stalePool = {
      async query(sql) {
        if (String(sql).includes('to_regclass')) {
          return { rows: [{ has_migrations: true, has_users: true }] };
        }
        return { rows: [{ version: '007_tts_cost_ledger.sql' }] };
      },
    };
    await withServer({ pool: stalePool, registrationEnabled: false }, async (base) => {
      const health = await request(base, '/api/v2/health');
      assert.equal(health.response.status, 503);
      assert.equal(health.body.schemaReady, false);
      assert.equal(health.body.migration, '007_tts_cost_ledger.sql');
      assert.equal(health.body.requiredMigration, '008_playback_sessions.sql');
    });
  });

  test('registration is closed by default; login and private routes return safe errors', async () => {
    await withServer({ registrationEnabled: false }, async (base) => {
      const denied = await request(base, '/api/v2/auth/register', {
        method: 'POST',
        body: { email: 'closed@example.test', password: 'long enough password', displayName: 'Closed' },
      });
      assert.equal(denied.response.status, 403);
      assert.equal(denied.body.error.code, 'registration_disabled');

      const uploadsClosed = await request(base, '/api/v2/uploads', { method: 'POST', body: {} });
      assert.equal(uploadsClosed.response.status, 403);
      assert.equal(uploadsClosed.body.error.code, 'uploads_disabled');

      const missingToken = await request(base, '/api/v2/me');
      assert.equal(missingToken.response.status, 401);
      assert.equal(missingToken.body.error.code, 'invalid_access_token');

      const wrongMethod = await request(base, '/api/v2/auth/login');
      assert.equal(wrongMethod.response.status, 405);
      assert.equal(wrongMethod.response.headers.get('allow'), 'POST');

      const missingRoute = await request(base, '/api/v2/no-such-route');
      assert.equal(missingRoute.response.status, 404);
    });
  });

  test('register/login/me/profile/artist and refresh/logout routes enforce contracts', async () => {
    await withServer({ registrationEnabled: true }, async (base) => {
      const roleInjection = await request(base, '/api/v2/auth/register', {
        method: 'POST',
        body: {
          email: 'http-api@example.test',
          password: 'api route sufficiently long password',
          displayName: 'HTTP user',
          role: 'admin',
        },
      });
      assert.equal(roleInjection.response.status, 400);
      assert.equal(roleInjection.body.error.code, 'invalid_input');

      const created = await request(base, '/api/v2/auth/register', {
        method: 'POST',
        body: {
          email: 'http-api@example.test',
          password: 'api route sufficiently long password',
          displayName: 'HTTP user',
        },
      });
      assert.equal(created.response.status, 201);
      assert.equal(created.body.user.role, 'listener');

      const me = await request(base, '/api/v2/me', { token: created.body.accessToken });
      assert.equal(me.response.status, 200);
      assert.equal(me.body.id, created.body.user.id);

      const forbiddenPatch = await request(base, '/api/v2/me', {
        method: 'PATCH', token: created.body.accessToken, body: { role: 'admin' },
      });
      assert.equal(forbiddenPatch.response.status, 400);

      const missingAcknowledgement = await request(base, '/api/v2/me/artist', {
        method: 'POST', token: created.body.accessToken,
        body: { stageName: 'HTTP Artist', offerVersion: 'test-v1', rightsConfirmed: false },
      });
      assert.equal(missingAcknowledgement.response.status, 400);

      const artist = await request(base, '/api/v2/me/artist', {
        method: 'POST', token: created.body.accessToken,
        body: { stageName: 'HTTP Artist', offerVersion: 'test-v1', rightsConfirmed: true },
      });
      assert.equal(artist.response.status, 201);
      const updatedMe = await request(base, '/api/v2/me', { token: created.body.accessToken });
      assert.equal(updatedMe.body.role, 'artist');

      const login = await request(base, '/api/v2/auth/login', {
        method: 'POST',
        body: { email: 'HTTP-API@example.test', password: 'api route sufficiently long password' },
      });
      assert.equal(login.response.status, 200);
      const rotated = await request(base, '/api/v2/auth/refresh', {
        method: 'POST', body: { refreshToken: login.body.refreshToken },
      });
      assert.equal(rotated.response.status, 200);
      assert.notEqual(rotated.body.refreshToken, login.body.refreshToken);

      const logout = await request(base, '/api/v2/auth/logout', {
        method: 'POST', body: { refreshToken: rotated.body.refreshToken },
      });
      assert.equal(logout.response.status, 200);
      const afterLogout = await request(base, '/api/v2/auth/refresh', {
        method: 'POST', body: { refreshToken: rotated.body.refreshToken },
      });
      assert.equal(afterLogout.response.status, 401);
    });
  });

  test('registration and login are limited by source address and normalized identity', async () => {
    const rateLimiter = createInMemoryRateLimiter({ secret: AUTH_SECRET });
    await withServer({ registrationEnabled: true, rateLimiter }, async (base) => {
      const registrationStatuses = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await request(base, '/api/v2/auth/register', {
          method: 'POST',
          body: {
            email: '  Throttled@Example.test ',
            password: 'rate limit registration password',
            displayName: `Rate limit ${attempt}`,
          },
        });
        registrationStatuses.push(result.response.status);
      }
      assert.deepEqual(registrationStatuses, [201, 409, 409]);
      const blockedRegistration = await request(base, '/api/v2/auth/register', {
        method: 'POST',
        body: {
          email: 'throttled@example.test',
          password: 'rate limit registration password',
          displayName: 'Blocked registration',
        },
      });
      assert.equal(blockedRegistration.response.status, 429);
      assert.equal(blockedRegistration.body.error.code, 'rate_limited');
      assert.ok(Number(blockedRegistration.response.headers.get('retry-after')) > 0);

      const loginAccount = await request(base, '/api/v2/auth/register', {
        method: 'POST',
        body: {
          email: 'login-limit@example.test',
          password: 'valid login limiter password',
          displayName: 'Login limiter',
        },
      });
      assert.equal(loginAccount.response.status, 201);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const failedLogin = await request(base, '/api/v2/auth/login', {
          method: 'POST', body: { email: 'LOGIN-LIMIT@example.test', password: 'wrong password long enough' },
        });
        assert.equal(failedLogin.response.status, 401);
      }
      const blockedLogin = await request(base, '/api/v2/auth/login', {
        method: 'POST', body: { email: 'login-limit@example.test', password: 'valid login limiter password' },
      });
      assert.equal(blockedLogin.response.status, 429);
      assert.equal(blockedLogin.body.error.code, 'rate_limited');
      assert.equal(blockedLogin.response.headers.get('ratelimit-limit'), '10');
      assert.equal(blockedLogin.response.headers.get('ratelimit-remaining'), '0');
      assert.ok(Number(blockedLogin.response.headers.get('ratelimit-reset')) > 0);
    });
  });

  test('per-source throttling cannot be bypassed with X-Forwarded-For', async () => {
    const rateLimiter = createInMemoryRateLimiter({ secret: AUTH_SECRET });
    await withServer({ rateLimiter }, async (base) => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const disabledUpload = await request(base, '/api/v2/uploads', {
          method: 'POST',
          headers: { 'x-forwarded-for': `198.51.100.${attempt + 1}` },
        });
        assert.equal(disabledUpload.response.status, 403);
      }
      const blockedUpload = await request(base, '/api/v2/uploads', {
        method: 'POST', headers: { 'x-forwarded-for': '203.0.113.250' },
      });
      assert.equal(blockedUpload.response.status, 429);
      assert.equal(blockedUpload.body.error.code, 'rate_limited');
      assert.equal(blockedUpload.response.headers.get('ratelimit-limit'), '10');
      assert.equal(blockedUpload.response.headers.get('ratelimit-remaining'), '0');
      assert.ok(Number(blockedUpload.response.headers.get('retry-after')) > 0);
    });
  });

  test('rate-limit storage failure fails closed and readiness reports 503', async () => {
    const brokenLimiter = {
      async ready() { throw new Error('synthetic Redis outage'); },
      async consume() { throw new Error('synthetic Redis outage'); },
    };
    await withServer({ rateLimiter: brokenLimiter }, async (base) => {
      const health = await request(base, '/api/v2/health');
      assert.equal(health.response.status, 503);
      assert.equal(health.body.rateLimitReady, false);

      const { response, body } = await request(base, '/api/v2/catalog');
      assert.equal(response.status, 503);
      assert.equal(body.error.code, 'rate_limit_unavailable');
      assert.ok(response.headers.get('x-request-id'));
    });
  });

  test('public catalog filters only approved tracks and private track routes enforce ownership', async () => {
    await withServer({ registrationEnabled: true }, async (base) => {
      const owner = await request(base, '/api/v2/auth/register', {
        method: 'POST',
        body: { email: 'catalog-owner@example.test', password: 'catalog owner password long', displayName: 'Catalog owner' },
      });
      const stranger = await request(base, '/api/v2/auth/register', {
        method: 'POST',
        body: { email: 'catalog-stranger@example.test', password: 'catalog stranger password', displayName: 'Catalog stranger' },
      });
      assert.equal(owner.response.status, 201);
      assert.equal(stranger.response.status, 201);

      const privateTrack = await pool.query(`
        INSERT INTO tracks (owner_id, title, artist_display)
        VALUES ($1, 'Private draft', 'Catalog owner') RETURNING id
      `, [owner.body.user.id]);
      const publicTrack = await pool.query(`
        INSERT INTO tracks (owner_id, title, artist_display, genre, mood, duration_ms, rights_confirmed_at)
        VALUES ($1, 'Moon Over Amsterdam', 'Catalog owner', 'ambient', ARRAY['calm', 'night'], 210000, now())
        RETURNING id
      `, [owner.body.user.id]);
      await pool.query(`
        INSERT INTO moderation_queue (track_id, reason, status, decision, decided_at)
        VALUES ($1, 'initial review', 'approved', 'approved', now())
      `, [publicTrack.rows[0].id]);
      await pool.query(`
        UPDATE tracks SET status = 'published', visibility = 'public',
          rights_offer_version = 'test-v1', published_at = now()
        WHERE id = $1
      `, [publicTrack.rows[0].id]);

      const catalog = await request(base, '/api/v2/catalog?q=Moon&genre=ambient&mood=night&sort=relevance');
      assert.equal(catalog.response.status, 200);
      assert.equal(catalog.body.total, 1);
      assert.equal(catalog.body.items[0].id, publicTrack.rows[0].id);
      assert.equal(catalog.body.items[0].artist, 'Catalog owner');

      const privateAnonymous = await request(base, `/api/v2/tracks/${privateTrack.rows[0].id}`);
      assert.equal(privateAnonymous.response.status, 404);
      const privateOwner = await request(base, `/api/v2/tracks/${privateTrack.rows[0].id}`, { token: owner.body.accessToken });
      assert.equal(privateOwner.response.status, 200);
      assert.equal(privateOwner.body.status, 'quarantine');
      const privateStranger = await request(base, `/api/v2/tracks/${privateTrack.rows[0].id}`, { token: stranger.body.accessToken });
      assert.equal(privateStranger.response.status, 404);

      const idor = await request(base, `/api/v2/tracks/${privateTrack.rows[0].id}`, {
        method: 'PATCH', token: stranger.body.accessToken, body: { title: 'Stolen edit' },
      });
      assert.equal(idor.response.status, 403);
      const edited = await request(base, `/api/v2/tracks/${publicTrack.rows[0].id}`, {
        method: 'PATCH', token: owner.body.accessToken, body: { title: 'Moon Revisited' },
      });
      assert.equal(edited.response.status, 200);
      assert.equal(edited.body.status, 'in_review');
      assert.equal(edited.body.visibility, 'private');

      const noLongerPublic = await request(base, '/api/v2/catalog?q=Moon');
      assert.equal(noLongerPublic.body.total, 0);
      await assert.rejects(
        pool.query(`UPDATE tracks SET status = 'published', visibility = 'public', published_at = now() WHERE id = $1`, [publicTrack.rows[0].id]),
        /without an approved moderation decision/i,
      );
      const badLimit = await request(base, '/api/v2/catalog?limit=0');
      assert.equal(badLimit.response.status, 400);
    });
  });

  test('submission and moderator decisions enforce roles, rights acknowledgement and audit state changes', async () => {
    await withServer({ registrationEnabled: true }, async (base) => {
      const owner = await request(base, '/api/v2/auth/register', {
        method: 'POST', body: { email: 'review-owner@example.test', password: 'review owner test password', displayName: 'Review owner' },
      });
      const moderator = await request(base, '/api/v2/auth/register', {
        method: 'POST', body: { email: 'review-mod@example.test', password: 'review moderator password', displayName: 'Review moderator' },
      });
      await pool.query("UPDATE users SET primary_role = 'moderator' WHERE id = $1", [moderator.body.user.id]);
      const track = await pool.query(`
        INSERT INTO tracks (owner_id, title, artist_display)
        VALUES ($1, 'Needs review', 'Review owner') RETURNING id
      `, [owner.body.user.id]);

      const missingRights = await request(base, `/api/v2/tracks/${track.rows[0].id}/publish`, {
        method: 'POST', token: owner.body.accessToken,
        body: { rightsConfirmed: false, offerVersion: 'test-terms-v1' },
      });
      assert.equal(missingRights.response.status, 400);
      const submitted = await request(base, `/api/v2/tracks/${track.rows[0].id}/publish`, {
        method: 'POST', token: owner.body.accessToken,
        body: { rightsConfirmed: true, offerVersion: 'test-terms-v1' },
      });
      assert.equal(submitted.response.status, 202);
      assert.equal(submitted.body.status, 'in_review');
      assert.equal(submitted.body.visibility, 'private');
      assert.equal(submitted.body.moderation.status, 'pending');
      assert.ok(submitted.body.moderation.createdAt);
      const undocumentedSubmitPath = await request(base, `/api/v2/tracks/${track.rows[0].id}`, {
        method: 'POST', token: owner.body.accessToken,
        body: { rightsConfirmed: true, offerVersion: 'test-terms-v1' },
      });
      assert.equal(undocumentedSubmitPath.response.status, 405);

      const deniedQueue = await request(base, '/api/v2/moderation/queue', { token: owner.body.accessToken });
      assert.equal(deniedQueue.response.status, 403);
      const queue = await request(base, '/api/v2/moderation/queue?status=pending', { token: moderator.body.accessToken });
      assert.equal(queue.response.status, 200);
      assert.ok(queue.body.items.some((item) => item.id === submitted.body.moderation.id));

      const decision = await request(base, `/api/v2/moderation/${submitted.body.moderation.id}/decision`, {
        method: 'POST', token: moderator.body.accessToken,
        body: { decision: 'approve', reason: 'Rights and content reviewed.' },
      });
      assert.equal(decision.response.status, 200);
      assert.equal(decision.body.status, 'approved');
      const visible = await request(base, `/api/v2/tracks/${track.rows[0].id}`);
      assert.equal(visible.response.status, 200);
      const audit = await pool.query(`SELECT action FROM platform_audit_events WHERE target_id = $1 ORDER BY id`, [track.rows[0].id]);
      assert.ok(audit.rows.some((entry) => entry.action === 'track.submitted_for_moderation'));

      const metadata = await request(base, `/api/v2/tracks/${track.rows[0].id}`, {
        method: 'PATCH', token: owner.body.accessToken, body: { title: 'Updated after review' },
      });
      assert.equal(metadata.body.status, 'in_review');
      assert.equal(metadata.body.visibility, 'private');
      const secondQueue = await request(base, '/api/v2/moderation/queue', { token: moderator.body.accessToken });
      const pending = secondQueue.body.items.find((item) => item.trackId === track.rows[0].id);
      assert.ok(pending);
      assert.notEqual(pending.id, submitted.body.moderation.id);
      const rejected = await request(base, `/api/v2/moderation/${pending.id}/decision`, {
        method: 'POST', token: moderator.body.accessToken,
        body: { decision: 'reject', reason: 'Metadata needs correction.' },
      });
      assert.equal(rejected.body.status, 'rejected');

      const escalationTrack = await pool.query(`
        INSERT INTO tracks (owner_id, title, artist_display)
        VALUES ($1, 'Escalated review', 'Review owner') RETURNING id
      `, [owner.body.user.id]);
      const escalationSubmission = await request(base, `/api/v2/tracks/${escalationTrack.rows[0].id}/publish`, {
        method: 'POST', token: owner.body.accessToken,
        body: { rightsConfirmed: true, offerVersion: 'test-terms-v1' },
      });
      const escalation = await request(base, `/api/v2/moderation/${escalationSubmission.body.moderation.id}/decision`, {
        method: 'POST', token: moderator.body.accessToken,
        body: { decision: 'escalate', reason: 'Possible ownership conflict.' },
      });
      assert.equal(escalation.body.status, 'escalated');
      const finalDecision = await request(base, `/api/v2/moderation/${escalationSubmission.body.moderation.id}/decision`, {
        method: 'POST', token: moderator.body.accessToken,
        body: { decision: 'approve', reason: 'Escalation reviewed; no conflict found.' },
      });
      assert.equal(finalDecision.body.status, 'approved');
      assert.equal((await request(base, `/api/v2/tracks/${escalationTrack.rows[0].id}`)).response.status, 200);
    });
  });

  test('rights claim immediately hides public content; owner counter-notice stays private and admin-only registry', async () => {
    await withServer({ registrationEnabled: true }, async (base) => {
      const owner = await request(base, '/api/v2/auth/register', {
        method: 'POST', body: { email: 'claim-owner@example.test', password: 'rights owner long password', displayName: 'Rights owner' },
      });
      const moderator = await request(base, '/api/v2/auth/register', {
        method: 'POST', body: { email: 'claim-mod@example.test', password: 'rights moderator password', displayName: 'Rights moderator' },
      });
      const admin = await request(base, '/api/v2/auth/register', {
        method: 'POST', body: { email: 'claim-admin@example.test', password: 'rights administrator password', displayName: 'Rights admin' },
      });
      await pool.query("UPDATE users SET primary_role = 'moderator' WHERE id = $1", [moderator.body.user.id]);
      await pool.query("UPDATE users SET primary_role = 'admin' WHERE id = $1", [admin.body.user.id]);

      const track = await pool.query(`
        INSERT INTO tracks (owner_id, title, artist_display)
        VALUES ($1, 'Claimed song', 'Rights owner') RETURNING id
      `, [owner.body.user.id]);
      const submitted = await request(base, `/api/v2/tracks/${track.rows[0].id}/publish`, {
        method: 'POST', token: owner.body.accessToken,
        body: { rightsConfirmed: true, offerVersion: 'test-terms-v1' },
      });
      const approved = await request(base, `/api/v2/moderation/${submitted.body.moderation.id}/decision`, {
        method: 'POST', token: moderator.body.accessToken,
        body: { decision: 'approve', reason: 'Initial review complete.' },
      });
      assert.equal(approved.body.status, 'approved');

      const notice = await request(base, '/api/v2/claims', {
        method: 'POST',
        body: {
          trackId: track.rows[0].id,
          claimantEmail: 'rightsholder@example.test',
          claimantName: 'Rights holder',
          evidenceUrl: 'https://evidence.example.test/claim/1',
          claimText: 'I own the rights to this recording and request review.',
        },
      });
      assert.equal(notice.response.status, 201);
      assert.equal(notice.body.status, 'open');
      const hidden = await request(base, `/api/v2/tracks/${track.rows[0].id}`);
      assert.equal(hidden.response.status, 404);

      const stranger = await request(base, '/api/v2/auth/register', {
        method: 'POST', body: { email: 'claim-stranger@example.test', password: 'counter stranger password', displayName: 'Stranger' },
      });
      const deniedCounter = await request(base, `/api/v2/claims/${notice.body.id}/counter`, {
        method: 'POST', token: stranger.body.accessToken,
        body: { counterNoticeText: 'I am not the owner of this track.' },
      });
      assert.equal(deniedCounter.response.status, 403);
      const counter = await request(base, `/api/v2/claims/${notice.body.id}/counter`, {
        method: 'POST', token: owner.body.accessToken,
        body: { counterNoticeText: 'I created and own the recording and can provide source files.' },
      });
      assert.equal(counter.response.status, 200);
      assert.equal(counter.body.status, 'counter_notice');
      const stillHidden = await request(base, `/api/v2/tracks/${track.rows[0].id}`, { token: owner.body.accessToken });
      assert.equal(stillHidden.response.status, 200);
      assert.equal(stillHidden.body.status, 'taken_down');

      const moderatorRegistry = await request(base, '/api/v2/admin/claims', { token: moderator.body.accessToken });
      assert.equal(moderatorRegistry.response.status, 403);
      const adminRegistry = await request(base, '/api/v2/admin/claims?status=counter_notice', { token: admin.body.accessToken });
      assert.equal(adminRegistry.response.status, 200);
      assert.equal(adminRegistry.body.items[0].id, notice.body.id);
      assert.equal(adminRegistry.body.items[0].claimantEmail, 'rightsholder@example.test');

      const inReviewTrack = await pool.query(`
        INSERT INTO tracks (owner_id, title, artist_display)
        VALUES ($1, 'Claimed before publication', 'Rights owner') RETURNING id
      `, [owner.body.user.id]);
      const inReviewSubmission = await request(base, `/api/v2/tracks/${inReviewTrack.rows[0].id}/publish`, {
        method: 'POST', token: owner.body.accessToken,
        body: { rightsConfirmed: true, offerVersion: 'test-terms-v1' },
      });
      const inReviewNotice = await request(base, '/api/v2/claims', {
        method: 'POST',
        body: {
          trackId: inReviewTrack.rows[0].id,
          claimantEmail: 'second-rightsholder@example.test',
          claimantName: 'Second rights holder',
          evidenceUrl: 'https://evidence.example.test/claim/2',
          claimText: 'I control the publishing rights and request a review before release.',
        },
      });
      assert.equal(inReviewNotice.response.status, 201);
      assert.equal(inReviewNotice.body.claimantEmail, undefined, 'public response does not expose claimant PII');
      const hiddenInReview = await request(base, `/api/v2/tracks/${inReviewTrack.rows[0].id}`, {
        token: owner.body.accessToken,
      });
      assert.equal(hiddenInReview.body.status, 'taken_down');
      const staleDecision = await request(base, `/api/v2/moderation/${inReviewSubmission.body.moderation.id}/decision`, {
        method: 'POST', token: moderator.body.accessToken,
        body: { decision: 'approve', reason: 'Attempt to approve after rights claim.' },
      });
      assert.equal(staleDecision.response.status, 409);
    });
  });

  test('rejects non-JSON and malformed bodies without leaking internals', async () => {
    await withServer({ registrationEnabled: true }, async (base) => {
      const wrongType = await fetch(`${base}/api/v2/auth/login`, { method: 'POST', body: 'email=a' });
      assert.equal(wrongType.status, 415);
      const wrongTypeBody = await wrongType.json();
      assert.equal(wrongTypeBody.error.code, 'unsupported_media_type');

      const malformed = await fetch(`${base}/api/v2/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
      });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).error.code, 'invalid_json');
    });
  });
});
