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
import { completeUploadIntent, createUploadIntent } from './upload.js';
import { createTrackMediaUrl } from './media.js';
import { ingestPlayEvents } from './events.js';
import { getRecommendations } from './recsys.js';
import { renderRadioScript, UnconfiguredTtsProvider } from './voice.js';
import { getRadioSchedule, recordRadioFeedback, skipRadioSegment, startRadioSession } from './radio.js';

const MAX_JSON_BYTES = 16 * 1024;
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

/** @param {import('node:http').IncomingMessage} req */
async function readJson(req) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new PlatformAuthError('unsupported_media_type', 415, 'Content-Type must be application/json.');
  }
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > MAX_JSON_BYTES) {
    throw new PlatformAuthError('request_too_large', 413, 'JSON request body is too large.');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_JSON_BYTES) {
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
 *   ttsProvider?: import('./voice.js').TtsProvider}} options
 */
export function createPlatformServer({
  pool,
  secret,
  registrationEnabled = false,
  uploadsEnabled = false,
  maxUploadBytes = 200 * 1024 * 1024,
  storage,
  ttsProvider = new UnconfiguredTtsProvider(),
}) {
  const signingKey = requirePlatformAuthSecret(secret);

  const server = createServer((req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    securityHeaders(res);
    void handleRequest(req, res, { pool, signingKey, registrationEnabled, uploadsEnabled, maxUploadBytes, storage, ttsProvider, requestId });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;
  return server;
}

async function handleRequest(req, res, context) {
  const { pool, signingKey, registrationEnabled, uploadsEnabled, maxUploadBytes, storage, ttsProvider, requestId } = context;
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
  try {
    const methods = ROUTE_METHODS.get(pathname)
      || (trackPublishMatch ? ['POST'] : undefined)
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

    if (pathname === '/api/v2/health') {
      try {
        const schema = await pool.query(`
          SELECT to_regclass('public.platform_schema_migrations') IS NOT NULL AS has_migrations,
            to_regclass('public.users') IS NOT NULL AS has_users
        `);
        const ready = Boolean(schema.rows[0]?.has_migrations && schema.rows[0]?.has_users);
        let current = null;
        if (ready) {
          const migration = await pool.query('SELECT version FROM platform_schema_migrations ORDER BY version DESC LIMIT 1');
          current = migration.rows[0]?.version ?? null;
        }
        const status = ready && current ? 200 : 503;
        sendJson(res, status, { ok: status === 200, service: 'vision-platform-api', schemaReady: Boolean(current), migration: current });
      } catch {
        sendJson(res, 503, { ok: false, service: 'vision-platform-api', schemaReady: false });
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
      assertAllowedFields(body, ['email', 'password', 'displayName']);
      const result = await registerWithPassword(pool, body, { secret: signingKey });
      sendJson(res, 201, result);
      return;
    }
    if (pathname === '/api/v2/auth/login') {
      const body = await readJson(req);
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
    if (pathname === '/api/v2/events') {
      const actor = await getCurrentUser(pool, bearerToken(req), { secret: signingKey });
      const body = await readJson(req);
      assertAllowedFields(body, ['events']);
      sendJson(res, 202, await ingestPlayEvents(pool, actor.id, body));
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
