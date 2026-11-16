// @ts-check
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PlatformAuthError, requirePlatformAuthSecret } from './auth-crypto.js';
import { getTrackForActor, listPublicCatalog, updateTrackMetadata } from './catalog.js';
import {
  createRightsClaim,
  decideModeration,
  fileCounterNotice,
  listModerationQueue,
  listRightsClaims,
  requestTrackPublication,
} from './moderation.js';
import {
  createArtistProfile,
  getCurrentUser,
  loginWithPassword,
  registerWithPassword,
  revokeRefreshToken,
  rotateRefreshToken,
  updateCurrentUserProfile,
} from './identity.js';
import { PLATFORM_OPENAPI } from './openapi.js';
import { getPlatformSchemaStatus, PLATFORM_SCHEMA_VERSION } from './migrations.js';
import { completeUploadIntent, createUploadIntent } from './upload.js';
import { createTrackMediaUrl } from './media.js';
import { createPlaybackSession, ingestPlayEvents, revokePlaybackSession } from './events.js';
import { getRecommendations } from './recsys.js';
import { renderRadioScript, UnconfiguredTtsProvider } from './voice.js';
import { getRadioSchedule, recordRadioFeedback, skipRadioSegment, startRadioSession } from './radio.js';
import {
  PLATFORM_RATE_LIMIT_POLICIES,
  PlatformRateLimitUnavailableError,
} from './rate-limit.js';

const MAX_JSON_BYTES = 16 * 1024;
const MAX_EVENT_JSON_BYTES = 256 * 1024;
const ROUTE_METHODS = new Map([
  ['/api/v2/health', ['GET']],
  ['/api/v2/openapi.json', ['GET']],
  ['/api/v2/auth/register', ['POST']],
  ['/api/v2/auth/login', ['POST']],
  ['/api/v2/auth/refresh', ['POST']],
  ['/api/v2/auth/logout', ['POST']],
  ['/api/v2/me', ['GET', 'PATCH']],
  ['/api/v2/me/artist', ['POST']],
  ['/api/v2/catalog', ['GET']],
  ['/api/v2/moderation/queue', ['GET']],
  ['/api/v2/claims', ['POST']],
  ['/api/v2/admin/claims', ['GET']],
  ['/api/v2/uploads', ['POST']],
  ['/api/v2/playback/sessions', ['POST']],
  ['/api/v2/events', ['POST']],
  ['/api/v2/recommendations', ['GET']],
  ['/api/v2/voice/render', ['POST']],
  ['/api/v2/radio/session', ['POST']],
]);

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function assertAllowedFields(body, allowed) {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) throw new PlatformAuthError('invalid_input', 400, `Unknown field: ${unknown}.`);
}

/** Do not trust X-Forwarded-For until a trusted-proxy allowlist is designed and enforced. */
function requestAddressSubject(req) {
  const address = req.socket?.remoteAddress;
  return typeof address === 'string' && address.length <= 128 ? address : 'unknown';
}

function rateLimitIdentitySubject(value) {
  if (typeof value !== 'string') return `invalid-${typeof value}`;
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  return normalized.slice(0, 1_024) || 'empty';
}

function requestRateLimitPolicies(method, pathname, matches) {
  if (pathname === '/api/v2/health' || pathname === '/api/v2/openapi.json') return [];
  if (pathname === '/api/v2/auth/register') return [PLATFORM_RATE_LIMIT_POLICIES.registerIp];
  if (pathname === '/api/v2/auth/login') return [PLATFORM_RATE_LIMIT_POLICIES.loginIp];
  if (pathname === '/api/v2/auth/refresh' || pathname === '/api/v2/auth/logout') {
    return [PLATFORM_RATE_LIMIT_POLICIES.refreshIp];
  }
  if (pathname === '/api/v2/catalog' || matches.trackMediaMatch || (matches.trackMatch && method === 'GET')) {
    return [PLATFORM_RATE_LIMIT_POLICIES.publicReadIp];
  }
  if (pathname === '/api/v2/uploads' || matches.uploadCompleteMatch) return [PLATFORM_RATE_LIMIT_POLICIES.uploadIp];
  if (pathname === '/api/v2/events') return [PLATFORM_RATE_LIMIT_POLICIES.eventIp];
  if (pathname === '/api/v2/claims') return [PLATFORM_RATE_LIMIT_POLICIES.rightsClaimIp];
  if (pathname === '/api/v2/radio/session') return [PLATFORM_RATE_LIMIT_POLICIES.radioSessionIp];
  if (pathname === '/api/v2/voice/render') return [PLATFORM_RATE_LIMIT_POLICIES.voiceRenderIp];
  if (method === 'GET') return [PLATFORM_RATE_LIMIT_POLICIES.apiReadIp];
  return [PLATFORM_RATE_LIMIT_POLICIES.apiWriteIp];
}

async function enforceRateLimit(rateLimiter, policy, subject, res, requestId) {
  let decision;
  try {
    decision = await rateLimiter.consume({ ...policy, subject });
  } catch (error) {
    if (error instanceof PlatformRateLimitUnavailableError) throw error;
    throw new PlatformRateLimitUnavailableError(error);
  }

  res.setHeader('RateLimit-Limit', String(decision.limit));
  res.setHeader('RateLimit-Remaining', String(decision.remaining));
  res.setHeader('RateLimit-Reset', String(Math.max(0, Math.ceil((decision.resetAtMs - Date.now()) / 1_000))));
  if (decision.allowed) return true;

  const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1_000));
  res.setHeader('Retry-After', String(retryAfter));
  sendJson(res, 429, {
    error: { code: 'rate_limited', message: 'Too many requests. Try again later.', request_id: requestId },
  });
  return false;
}

/** @param {import('node:http').IncomingMessage} req @param {number} [maxBytes] */
async function readJson(req, maxBytes = MAX_JSON_BYTES) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new PlatformAuthError('unsupported_media_type', 415, 'Content-Type must be application/json.');
  }
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > maxBytes) {
    throw new PlatformAuthError('request_too_large', 413, 'JSON request body is too large.');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      throw new PlatformAuthError('request_too_large', 413, 'JSON request body is too large.');
    }
    chunks.push(bytes);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected an object.');
    return body;
  } catch {
    throw new PlatformAuthError('invalid_json', 400, 'Request body must be a JSON object.');
  }
}

/** @param {import('node:http').IncomingMessage} req */
function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  if (!match) throw new PlatformAuthError('invalid_access_token', 401, 'Access token is required.');
  return match[1];
}

/**
 * Creates the isolated v2 platform API. It is deliberately separate from the
 * legacy SQLite HTTP server until a reviewed cutover is approved.
 * @param {{pool: import('pg').Pool, secret?: string|Buffer, registrationEnabled?: boolean,
 *   uploadsEnabled?: boolean, maxUploadBytes?: number, storage?: ReturnType<typeof import('./storage.js').createS3Storage>,
 *   rateLimiter: Pick<ReturnType<typeof import('./rate-limit.js').createPlatformRateLimiter>, 'consume'> & {ready?: () => Promise<unknown>},
 *   ttsProvider?: import('./voice.js').TtsProvider}} options
 */
export function createPlatformServer({
  pool,
  secret,
  registrationEnabled = false,
  uploadsEnabled = false,
  maxUploadBytes = 200 * 1024 * 1024,
  storage,
  rateLimiter,
  ttsProvider = new UnconfiguredTtsProvider(),
}) {
  const signingKey = requirePlatformAuthSecret(secret);
  if (!rateLimiter || typeof rateLimiter.consume !== 'function') {
    throw new Error('A platform rate limiter is required before the API can start.');
  }

  const server = createServer((req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    securityHeaders(res);
    void handleRequest(req, res, { pool, signingKey, registrationEnabled, uploadsEnabled, maxUploadBytes, storage, rateLimiter, ttsProvider, requestId });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;
  return server;
}

async function handleRequest(req, res, context) {
  const { pool, signingKey, registrationEnabled, uploadsEnabled, maxUploadBytes, storage, rateLimiter, ttsProvider, requestId } = context;
  const method = String(req.method || 'GET').toUpperCase();
  let url;
  try {
    url = new URL(req.url || '/', 'http://platform.local');
  } catch {
    sendJson(res, 400, { error: { code: 'invalid_url', message: 'Request URL is invalid.', request_id: requestId } });
    return;
  }
  const pathname = url.pathname;
  const trackPublishMatch = /^\/api\/v2\/tracks\/([^/]+)\/publish$/.exec(pathname);
  const trackMediaMatch = /^\/api\/v2\/tracks\/([^/]+)\/media$/.exec(pathname);
  const trackMatch = /^\/api\/v2\/tracks\/([^/]+)$/.exec(pathname);
  const moderationDecisionMatch = /^\/api\/v2\/moderation\/([^/]+)\/decision$/.exec(pathname);
  const claimCounterMatch = /^\/api\/v2\/claims\/([^/]+)\/counter$/.exec(pathname);
  const uploadCompleteMatch = /^\/api\/v2\/uploads\/([^/]+)\/complete$/.exec(pathname);
  const radioNextMatch = /^\/api\/v2\/radio\/([^/]+)\/next$/.exec(pathname);
  const radioSkipMatch = /^\/api\/v2\/radio\/([^/]+)\/skip$/.exec(pathname);
  const radioFeedbackMatch = /^\/api\/v2\/radio\/([^/]+)\/feedback$/.exec(pathname);
  const playbackSessionRevokeMatch = /^\/api\/v2\/playback\/sessions\/([^/]+)\/revoke$/.exec(pathname);
  try {
    const methods = ROUTE_METHODS.get(pathname)
      || (trackPublishMatch ? ['POST'] : undefined)
      || (playbackSessionRevokeMatch ? ['POST'] : undefined)
      || (trackMediaMatch ? ['GET'] : undefined)
      || (radioNextMatch ? ['GET'] : undefined)
      || (radioSkipMatch || radioFeedbackMatch ? ['POST'] : undefined)
      || (trackMatch ? ['GET', 'PATCH'] : undefined)
      || (moderationDecisionMatch || claimCounterMatch || uploadCompleteMatch ? ['POST'] : undefined);
    if (!methods) {
      sendJson(res, 404, { error: { code: 'not_found', message: 'Route not found.', request_id: requestId } });
      return;
    }
    if (!methods.includes(method)) {
      res.setHeader('Allow', methods.join(', '));
      sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.', request_id: requestId } });
      return;
    }

    const policies = requestRateLimitPolicies(method, pathname, {
      trackMediaMatch, trackMatch, uploadCompleteMatch,
    });
    const addressSubject = requestAddressSubject(req);
    for (const policy of policies) {
      if (!await enforceRateLimit(rateLimiter, policy, addressSubject, res, requestId)) return;
    }

    if (pathname === '/api/v2/health') {
      try {
        const { migration: current, ready: schemaReady } = await getPlatformSchemaStatus(pool);
        const rateLimitReady = typeof rateLimiter.ready === 'function' ? await rateLimiter.ready() : true;
        const status = schemaReady && rateLimitReady ? 200 : 503;
        sendJson(res, status, {
          ok: status === 200,
          service: 'vision-platform-api',
          schemaReady,
          migration: current,
          requiredMigration: PLATFORM_SCHEMA_VERSION,
          rateLimitReady: Boolean(rateLimitReady),
        });
      } catch {
        sendJson(res, 503, {
          ok: false,
          service: 'vision-platform-api',
          schemaReady: false,
          migration: null,
          requiredMigration: PLATFORM_SCHEMA_VERSION,
          rateLimitReady: false,
        });
      }
      return;
    }
    if (pathname === '/api/v2/openapi.json') {
      sendJson(res, 200, PLATFORM_OPENAPI);
      return;
    }
    if (pathname === '/api/v2/auth/register') {
      if (!registrationEnabled) throw new PlatformAuthError('registration_disabled', 403, 'Registration is currently disabled.');
      const body = await readJson(req);
      if (!await enforceRateLimit(
        rateLimiter,
        PLATFORM_RATE_LIMIT_POLICIES.registerIdentity,
        rateLimitIdentitySubject(body.email),
        res,
        requestId,
      )) return;
      assertAllowedFields(body, ['email', 'password', 'displayName']);
      const result = await registerWithPassword(pool, body, { secret: signingKey });
      sendJson(res, 201, result);
      return;
    }
    if (pathname === '/api/v2/auth/login') {
      const body = await readJson(req);
      if (!await enforceRateLimit(
        rateLimiter,
        PLATFORM_RATE_LIMIT_POLICIES.loginIdentity,
        rateLimitIdentitySubject(body.email),
        res,
        requestId,
      )) return;
      assertAllowedFields(body, ['email', 'password']);
      const result = await loginWithPassword(pool, body, { secret: signingKey });
      sendJson(res, 200, result);
      return;
    }
    if (pathname === '/api/v2/auth/refresh') {
      const body = await readJson(req);
      assertAllowedFields(body, ['refreshToken']);
      const result = await rotateRefreshToken(pool, body.refreshToken, { secret: signingKey });
      sendJson(res, 200, result);
      return;
    }
    if (pathname === '/api/v2/auth/logout') {
      const body = await readJson(req);
      assertAllowedFields(body, ['refreshToken']);
      await revokeRefreshToken(pool, body.refreshToken);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === '/api/v2/me') {
      const user = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      if (method === 'GET') {
        sendJson(res, 200, user);
        return;
      }
      const body = await readJson(req);
      assertAllowedFields(body, ['displayName', 'locale', 'country', 'city']);
      sendJson(res, 200, await updateCurrentUserProfile(pool, user.id, body));
      return;
    }
    if (pathname === '/api/v2/me/artist') {
      const user = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const body = await readJson(req);
      assertAllowedFields(body, ['stageName', 'bio', 'links', 'offerVersion', 'rightsConfirmed']);
      const profile = await createArtistProfile(pool, user.id, body);
      sendJson(res, 201, profile);
      return;
    }
    if (pathname === '/api/v2/catalog') {
      sendJson(res, 200, await listPublicCatalog(pool, url.searchParams));
      return;
    }
    if (playbackSessionRevokeMatch) {
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const revoked = await revokePlaybackSession(pool, actor.id, playbackSessionRevokeMatch[1]);
      if (!revoked) throw new PlatformAuthError('not_found', 404, 'Playback session not found.');
      sendJson(res, 200, { sessionId: playbackSessionRevokeMatch[1].toLowerCase(), revoked: true });
      return;
    }
    if (pathname === '/api/v2/playback/sessions') {
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const body = await readJson(req);
      assertAllowedFields(body, ['trackId']);
      sendJson(res, 201, await createPlaybackSession(pool, actor.id, body.trackId, { secret: signingKey }));
      return;
    }
    if (pathname === '/api/v2/events') {
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const body = await readJson(req, MAX_EVENT_JSON_BYTES);
      assertAllowedFields(body, ['events']);
      sendJson(res, 202, await ingestPlayEvents(pool, actor.id, body, { secret: signingKey }));
      return;
    }
    if (pathname === '/api/v2/recommendations') {
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      sendJson(res, 200, await getRecommendations(pool, actor.id, url.searchParams));
      return;
    }
    if (pathname === '/api/v2/voice/render') {
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const body = await readJson(req);
      assertAllowedFields(body, ['scriptId', 'voice']);
      sendJson(res, 200, await renderRadioScript(pool, actor, body, { storage, provider: ttsProvider }));
      return;
    }
    if (pathname === '/api/v2/radio/session') {
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const body = await readJson(req);
      assertAllowedFields(body, ['mood', 'genre']);
      sendJson(res, 201, await startRadioSession(pool, actor.id, body, { storage }));
      return;
    }
    if (radioNextMatch) {
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const aheadSeconds = url.searchParams.has('ahead') ? Number(url.searchParams.get('ahead')) : 900;
      sendJson(res, 200, await getRadioSchedule(pool, radioNextMatch[1], actor.id, { storage, aheadSeconds }));
      return;
    }
    if (radioFeedbackMatch) {
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const body = await readJson(req);
      assertAllowedFields(body, ['segmentId', 'reaction']);
      sendJson(res, 200, await recordRadioFeedback(pool, radioFeedbackMatch[1], actor.id, body));
      return;
    }
    if (radioSkipMatch) {
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const body = await readJson(req);
      assertAllowedFields(body, ['segmentId']);
      const feedback = await skipRadioSegment(pool, radioSkipMatch[1], actor.id, body.segmentId);
      const schedule = await getRadioSchedule(pool, radioSkipMatch[1], actor.id, { storage });
      sendJson(res, 200, { feedback, schedule });
      return;
    }
    if (pathname === '/api/v2/uploads') {
      if (!uploadsEnabled) throw new PlatformAuthError('uploads_disabled', 403, 'Uploads are currently disabled.');
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const body = await readJson(req);
      assertAllowedFields(body, ['title', 'artistDisplay', 'contentType', 'sizeBytes']);
      const idempotencyKey = req.headers['idempotency-key'];
      sendJson(res, 201, await createUploadIntent(pool, actor, body, {
        storage, maxUploadBytes, idempotencyKey,
      }));
      return;
    }
    if (uploadCompleteMatch) {
      if (!uploadsEnabled) throw new PlatformAuthError('uploads_disabled', 403, 'Uploads are currently disabled.');
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      sendJson(res, 200, await completeUploadIntent(pool, uploadCompleteMatch[1], actor, { storage }));
      return;
    }
    if (trackMediaMatch) {
      const actor = req.headers.authorization
        ? await getCurrentUser(pool, bearerToken(req), { secret: signingKey })
        : null;
      const codec = url.searchParams.get('codec') ?? 'auto';
      sendJson(res, 200, await createTrackMediaUrl(pool, trackMediaMatch[1], actor, { storage, codec }));
      return;
    }
    if (pathname === '/api/v2/moderation/queue') {
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const status = url.searchParams.get('status') ?? undefined;
      const limit = url.searchParams.has('limit') ? url.searchParams.get('limit') : 50;
      const offset = url.searchParams.has('offset') ? url.searchParams.get('offset') : 0;
      sendJson(res, 200, { items: await listModerationQueue(pool, actor, { status, limit, offset }) });
      return;
    }
    if (moderationDecisionMatch) {
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const body = await readJson(req);
      assertAllowedFields(body, ['decision', 'reason']);
      sendJson(res, 200, await decideModeration(pool, moderationDecisionMatch[1], actor, body, { requestId }));
      return;
    }
    if (pathname === '/api/v2/claims') {
      const body = await readJson(req);
      assertAllowedFields(body, ['trackId', 'claimantEmail', 'claimantName', 'evidenceUrl', 'claimText']);
      sendJson(res, 201, await createRightsClaim(pool, body, { requestId }));
      return;
    }
    if (claimCounterMatch) {
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const body = await readJson(req);
      assertAllowedFields(body, ['counterNoticeText']);
      sendJson(res, 200, await fileCounterNotice(pool, claimCounterMatch[1], actor, body, { requestId }));
      return;
    }
    if (pathname === '/api/v2/admin/claims') {
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const status = url.searchParams.get('status') ?? undefined;
      const limit = url.searchParams.has('limit') ? url.searchParams.get('limit') : 50;
      const offset = url.searchParams.has('offset') ? url.searchParams.get('offset') : 0;
      sendJson(res, 200, { items: await listRightsClaims(pool, actor, { status, limit, offset }) });
      return;
    }
    if (trackPublishMatch) {
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const body = await readJson(req);
      assertAllowedFields(body, ['rightsConfirmed', 'offerVersion']);
      sendJson(res, 202, await requestTrackPublication(pool, trackPublishMatch[1], actor, body, { requestId }));
      return;
    }
    if (trackMatch) {
      if (method === 'GET') {
        const actor = req.headers.authorization
          ? await getCurrentUser(pool, bearerToken(req), { secret: signingKey })
          : null;
        sendJson(res, 200, await getTrackForActor(pool, trackMatch[1], actor));
        return;
      }
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const body = await readJson(req);
      assertAllowedFields(body, ['title', 'artistDisplay', 'album', 'genre', 'mood']);
      sendJson(res, 200, await updateTrackMetadata(pool, trackMatch[1], actor, body, { requestId }));
      return;
    }
  } catch (error) {
    if (error instanceof PlatformAuthError) {
      sendJson(res, error.status, {
        error: { code: error.code, message: error.message, request_id: requestId },
      });
      return;
    }
    if (error instanceof PlatformRateLimitUnavailableError) {
      sendJson(res, 503, {
        error: { code: 'rate_limit_unavailable', message: 'Request protection is temporarily unavailable.', request_id: requestId },
      });
      return;
    }
    console.error('Platform API request failed.', {
      requestId,
      method,
      path: pathname,
      errorName: error?.name,
      errorCode: error?.code,
    });
    sendJson(res, 500, {
      error: { code: 'internal_error', message: 'An internal error occurred.', request_id: requestId },
    });
  }
}
