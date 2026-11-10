import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export const VERSION = '0.7.0';
export const PASSWORD = process.env.VISION_PASSWORD || 'vision';
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SECRET =
  process.env.VISION_SECRET ||
  createHmac('sha256', 'vision-audio').update(PASSWORD).digest('hex');

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function issueToken() {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = b64u(JSON.stringify({ sub: 'owner', exp }));
  return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(exp).toISOString() };
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() && data.sub === 'owner';
  } catch {
    return false;
  }
}

export function safeEqual(a = '', b = '') {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Простой rate limit: max попыток за окно на ключ. */
const buckets = new Map();
export function rateLimit(key, max = 10, windowMs = 5 * 60_000) {
  const now = Date.now();
  const bucket = buckets.get(key) || { count: 0, reset: now + windowMs };
  if (now > bucket.reset) {
    bucket.count = 0;
    bucket.reset = now + windowMs;
  }
  bucket.count += 1;
  buckets.set(key, bucket);
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
  }
  return bucket.count <= max;
}

/**
 * Определяет реальный аудио-формат по magic bytes, а не по расширению.
 * @returns {{mime: string, ext: string} | null}
 */
export function detectAudio(head) {
  if (!head || head.length < 12) return null;
  const ascii = (start, end) => head.subarray(start, end).toString('latin1');

  if (ascii(0, 3) === 'ID3') return { mime: 'audio/mpeg', ext: 'mp3' };
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return { mime: 'audio/mpeg', ext: 'mp3' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
  if (ascii(0, 4) === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
  if (ascii(0, 4) === 'fLaC') return { mime: 'audio/flac', ext: 'flac' };
  if (ascii(4, 8) === 'ftyp') return { mime: 'audio/mp4', ext: 'm4a' };
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return { mime: 'audio/webm', ext: 'webm' };
  }
  if (ascii(0, 4) === 'FORM' && ascii(8, 12) === 'AIFF') return { mime: 'audio/aiff', ext: 'aiff' };
  return null;
}

/** @returns {{mime: string, ext: string} | null} */
export function detectImage(head) {
  if (!head || head.length < 12) return null;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') {
    return { mime: 'image/png', ext: 'png' };
  }
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
  return null;
}

export function json(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

export function fail(res, status, code, message) {
  json(res, status, { error: { code, message } });
}

const MAX_BODY = 1024 * 1024;
export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid_json');
  }
}

/* ----------------------------- подписанные URL ---------------------------- */

export const MEDIA_TTL_MS = Number(process.env.MEDIA_URL_TTL_MS || 30 * 60 * 1000);

/**
 * Короткоживущая подпись для медиа. Нужна потому, что <audio>/<img> не умеют
 * отправлять Authorization. В отличие от «вечного» токена в query, подпись
 * привязана к конкретному треку и ресурсу и истекает.
 */
export function signMedia(trackId, kind, ttlMs = MEDIA_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const payload = `${trackId}:${kind}:${exp}`;
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return { exp, sig };
}

export function verifyMedia(trackId, kind, exp, sig) {
  if (!exp || !sig) return false;
  const expires = Number(exp);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;

  const expected = createHmac('sha256', SECRET).update(`${trackId}:${kind}:${exp}`).digest('base64url');
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function mediaUrls(track, base = '') {
  const stream = signMedia(track.id, 'stream');
  const cover = signMedia(track.id, 'cover');
  return {
    stream: `${base}/api/tracks/${track.id}/stream?exp=${stream.exp}&sig=${stream.sig}`,
    cover: track.cover ? `${base}/api/tracks/${track.id}/cover?exp=${cover.exp}&sig=${cover.sig}` : null,
    expiresAt: new Date(stream.exp).toISOString(),
  };
}

/* --------------------------------- логи ---------------------------------- */

const isProd = process.env.NODE_ENV === 'production';

export function log(level, message, fields = {}) {
  const entry = { ts: new Date().toISOString(), level, msg: message, ...fields };
  const line = isProd ? JSON.stringify(entry) : `${entry.ts} ${level.toUpperCase()} ${message} ${Object.keys(fields).length ? JSON.stringify(fields) : ''}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

export function uid() {
  return randomBytes(16).toString('hex');
}

export function str(value, max = 300) {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  return s ? s.slice(0, max) : null;
}
