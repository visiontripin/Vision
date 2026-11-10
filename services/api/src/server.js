import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync, statfsSync, rmSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  db, DATA_DIR, MEDIA_DIR, COVER_DIR,
  getTrack, getTrackFile, listTracks, countTracks, insertTrack, updateTrackFields,
  deleteTrackRecord, findByChecksum, recordListen, listHistory, clearHistory,
  setCoverMime, getCoverInfo, listPlaylists, getPlaylist, stats, genres, migrationStatus,
  listExternal, getExternal, upsertExternal, updateExternalNote, deleteExternal,
  listVariants, getVariant, deleteVariants, trackByChecksum,
} from './db.js';
import {
  STORAGE_MODE, SEED_ENABLED, DEVICE_ID, PUBLIC_URL, SEED_TTL_MS,
  isHash, extForMime, declareBlob, getBlob, registerSeed, removeSeed, listSeeds,
  seedSummary, withSources, resolveDownload, localFileFor, adoptBlob, heartbeatSelf,
  reconcileSelf, pruneSeeds, seedUrl, verifySeedToken, trackerStats,
} from './seeds.js';
import {
  backfillVariants, enqueueTranscode, hlsPath, removeVariants, transcodeStatus, variantPath,
} from './transcode.js';
import { ffmpegAvailable, ffmpegVersion, resolveFfmpeg } from './ffmpeg.js';
import { ImportError, resolveSoundCloudLink } from './external.js';
import { readTags, isSupportedCover } from './tags.js';
import { inc, observeDuration, renderMetrics, setGauge } from './metrics.js';
import { OPENAPI } from './openapi.js';
import {
  VERSION, PASSWORD, issueToken, verifyToken, safeEqual, rateLimit,
  detectAudio, detectImage, json, fail, readJson, uid, str, log,
  signMedia, verifyMedia, MEDIA_TTL_MS,
} from './lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WEB_DIST = path.join(ROOT, 'apps', 'web', 'dist');
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD = 500 * 1024 * 1024;
const MAX_COVER = 8 * 1024 * 1024;
// Разрешаем только официальный виджет SoundCloud: он играет со своих серверов,
// наших файлов и нашего трафика это не касается.
// Остальные узлы роя (Termux/десктоп) живут на своих адресах — их нужно явно
// разрешить в CSP и CORS-политике медиа, иначе браузер не даст проиграть файл.
const EXTRA_ORIGINS = (process.env.EXTRA_ORIGINS || '')
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter(Boolean)
  .join(' ');

const SECURITY_TXT = [
  "default-src 'self'",
  `img-src 'self' data: blob: ${EXTRA_ORIGINS}`.trim(),
  `media-src 'self' blob: ${EXTRA_ORIGINS}`.trim(),
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  `connect-src 'self' ${EXTRA_ORIGINS}`.trim(),
  "font-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  'frame-src https://w.soundcloud.com https://soundcloud.com',
  'frame-ancestors *',
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const COVER_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/* ------------------------------- утилиты -------------------------------- */

function authorized(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return verifyToken(token);
}

function authoriseMedia(req, url, trackId, kind) {
  if (verifyMedia(trackId, kind, url.searchParams.get('exp'), url.searchParams.get('sig'))) return true;
  return authorized(req);
}

/** Медиа-путь → вид подписи. Возвращает null, если путь не медийный. */
function signedMediaTarget(pathname, url) {
  const stream = /^\/api\/tracks\/([a-f0-9]{32})\/(stream|cover|download|hls\.m3u8|hls\/seg-\d{3,5}\.ts)$/.exec(pathname);
  if (!stream) return null;
  const [, id, tail] = stream;

  if (tail === 'cover') return { id, kinds: ['cover'] };
  // редирект на живой сид: браузер должен уметь открыть его без заголовков
  if (tail === 'download') return { id, kinds: ['download'] };
  if (tail === 'hls.m3u8' || tail.startsWith('hls/')) return { id, kinds: ['hls'] };

  const format = String(url.searchParams.get('format') || 'original').toLowerCase();
  const kinds = ['opus', 'aac'].includes(format) ? [`stream:${format}`, 'stream'] : ['stream', 'stream:original'];
  return { id, kinds };
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim()
    || req.socket.remoteAddress
    || 'local';
}

function freeDiskMb() {
  try {
    const s = statfsSync(DATA_DIR);
    return Math.round((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}

function securityHeaders(res, req) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  const forwarded = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  if (forwarded === 'https' || process.env.FORCE_HSTS === '1') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * `/api/v1/...` — публичный алиас контракта, `/api/...` остаётся рабочим.
 * Внутри сервера маршруты описаны один раз (без версии), версия — в пути.
 */
function versionedPath(pathname) {
  if (pathname === '/api/v1' || pathname === '/api/v1/') return '/api/health';
  if (pathname.startsWith('/api/v1/')) return `/api/${pathname.slice('/api/v1/'.length)}`;
  return pathname;
}

function routeKey(pathname) {
  return pathname.replace(/\/[A-Za-z0-9_-]{32}(?=\/|$)/g, '/:id');
}

/* --------------------------------- auth --------------------------------- */

async function handleLogin(req, res) {
  if (!rateLimit(clientIp(req))) {
    inc('vision_auth_rate_limited_total');
    return fail(res, 429, 'rate_limited', 'Слишком много попыток входа. Попробуйте через 5 минут.');
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    return fail(res, 400, 'invalid_json', 'Ожидался JSON.');
  }
  if (!safeEqual(body.password || '', PASSWORD)) {
    inc('vision_auth_failures_total');
    return fail(res, 401, 'unauthorized', 'Неверный пароль.');
  }
  inc('vision_auth_success_total');
  json(res, 200, issueToken());
}

/* ----------------------------- сиды и трекер ----------------------------- */

/** Свой публичный адрес: из PUBLIC_URL или из заголовков запроса. */
function selfBaseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `${proto}://${host}` : '';
}

const TRACK_URL = (id) => `/api/tracks/${id}`;

/**
 * Отдача блоба с этого устройства: `/seed/<sha256>?exp&sig`.
 * Подпись общая для всех узлов роя (один VISION_SECRET), поэтому ссылку можно
 * выдать с трекера и открыть на любом сиде. Живёт 30 минут.
 */
function handleSeed(req, res, url, pathname) {
  const match = /^\/seed\/([a-f0-9]{64})$/.exec(pathname);
  if (!match) return fail(res, 404, 'not_found', 'Неизвестный блоб.');
  if (!SEED_ENABLED) {
    return fail(res, 403, 'seed_disabled', 'Этот узел не раздаёт файлы (SEED_ENABLED=0).');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return fail(res, 405, 'method_not_allowed', 'Только GET/HEAD.');
  }

  const hash = match[1];
  const signed = verifySeedToken(hash, url.searchParams.get('exp'), url.searchParams.get('sig'));
  if (!signed && !authorized(req)) return fail(res, 401, 'unauthorized', 'Ссылка истекла или неверна.');

  const local = localFileFor(hash);
  if (!local) return fail(res, 404, 'not_here', 'Этого файла нет на данном устройстве.');

  registerSeed({ hash, deviceId: DEVICE_ID, kind: 'origin', baseUrl: PUBLIC_URL || selfBaseUrl(req) });
  inc('vision_seed_served_total');
  return sendFile(req, res, {
    file: local.file,
    mime: local.mime,
    etagBase: `seed:${hash}`,
    counters: { partial: 'vision_seed_partial_total', full: 'vision_seed_full_total' },
  });
}

/** Трек «только метаданные»: файл остался у загрузившего, у нас адрес и сид. */
async function handleMetadataUpload(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return fail(res, 400, 'invalid_json', 'Ожидался JSON с метаданными трека.');
  }

  const hash = String(body.hash || '').toLowerCase();
  if (!isHash(hash)) {
    return fail(res, 400, 'invalid_hash', 'Нужен sha256 содержимого (64 hex-символа) в поле hash.');
  }

  const duplicate = findByChecksum(hash);
  if (duplicate) {
    return json(res, 409, {
      error: { code: 'duplicate', message: 'Этот файл уже есть в библиотеке.' },
      existing: { id: duplicate.id, title: duplicate.title, artist: duplicate.artist },
    });
  }

  const mime = str(body.mime, 80) || 'audio/mpeg';
  const bytes = Math.max(0, Number(body.bytes ?? body.size) || 0);
  if (!bytes) return fail(res, 400, 'invalid_size', 'Нужен размер файла в байтах (поле bytes).');

  const id = uid();
  const peaks = Array.isArray(body.peaks)
    ? body.peaks.slice(0, 400).map((value) => Math.max(0, Math.min(1, Number(value) || 0)))
    : null;

  try {
    insertTrack({
      id,
      title: str(body.title, 300) || 'Без названия',
      artist: str(body.artist, 120) || 'Unknown',
      album: str(body.album, 160),
      genre: str(body.genre, 80),
      description: str(body.description, 2000),
      mime,
      ext: extForMime(mime),
      size: bytes,
      duration: Math.max(0, Number(body.duration) || 0),
      peaks: peaks ? JSON.stringify(peaks) : null,
      cover_mime: null,
      checksum: hash,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    log('error', 'metadata track insert failed', { error: error?.message });
    return fail(res, 500, 'db_error', 'Не удалось сохранить трек.');
  }

  declareBlob({ hash, bytes, mime });
  const kind = str(body.kind, 20) || 'node';
  registerSeed({
    hash,
    deviceId: str(body.deviceId, 120) || DEVICE_ID,
    kind,
    baseUrl: str(body.baseUrl, 500) || (kind === 'origin' ? PUBLIC_URL || selfBaseUrl(req) : null),
  });

  inc('vision_track_metadata_total');
  return json(res, 201, { ...withSources(getTrack(id, { withPeaks: true })), checksum: hash });
}

/* ------------------------------- стриминг -------------------------------- */

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'invalid';

  let start;
  let end;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!suffix) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Отдача файла с Range/ETag — общая для треков (origin) и блобов (сид).
 * `etagBase` делает ETag уникальным для источника.
 */
function sendFile(req, res, { file, mime, etagBase, cacheControl = 'private, max-age=3600', counters = null }) {
  if (!existsSync(file)) return fail(res, 404, 'file_missing', 'Файл не найден.');

  const size = statSync(file).size;
  const range = parseRange(req.headers.range, size);
  const etag = `"${createHash('sha1').update(`${etagBase}:${size}`).digest('hex')}"`;

  if (req.headers['if-none-match'] === etag && !req.headers.range) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }

  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    ETag: etag,
  };

  if (req.method === 'HEAD') {
    headers['Content-Length'] = size;
    res.writeHead(200, headers);
    return res.end();
  }

  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = range.end - range.start + 1;
    res.writeHead(206, headers);
    createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    inc(counters?.partial ?? 'vision_stream_partial_total');
  } else {
    headers['Content-Length'] = size;
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
    inc(counters?.full ?? 'vision_stream_full_total');
  }
}

function streamAudio(req, res, track, variant = null) {
  const meta = getTrackFile(track.id);
  const file = variant?.file ?? path.join(MEDIA_DIR, `${track.id}.${meta?.ext}`);
  const mime = variant?.mime ?? meta?.mime ?? track.mime;
  return sendFile(req, res, {
    file,
    mime,
    etagBase: `${track.id}:${variant?.kind ?? 'original'}`,
  });
}

function serveCover(req, res, track) {
  if (!track.cover) return fail(res, 404, 'no_cover', 'Обложка не загружена.');
  const info = getCoverInfo(track.id);
  const mime = info?.cover_mime || 'image/jpeg';
  const ext = COVER_EXT[mime] || 'jpg';
  const file = path.join(COVER_DIR, `${track.id}.${ext}`);
  if (!existsSync(file)) return fail(res, 404, 'no_cover', 'Обложка не загружена.');

  const size = statSync(file).size;
  const etag = `"${track.id}-${size}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': size,
    ETag: etag,
    'Cache-Control': 'private, max-age=86400',
  });
  createReadStream(file).pipe(res);
}

/* --------------------------------- загрузка ------------------------------- */

function saveCover(trackId, cover) {
  const mime = String(cover.mime || '').toLowerCase();
  const ext = isSupportedCover(mime) ? COVER_EXT[mime] : null;
  if (!ext) return null;
  return writeFile(path.join(COVER_DIR, `${trackId}.${ext}`), cover.data).then(() => mime);
}

async function handleUpload(req, res, url) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > MAX_UPLOAD) {
    return fail(res, 413, 'too_large', 'Файл больше 500 МБ.');
  }

  const tmp = path.join(MEDIA_DIR, `.incoming-${uid()}`);
  const ws = createWriteStream(tmp);
  const hash = createHash('sha256');
  let head = Buffer.alloc(0);
  let received = 0;
  let detected = null;
  let rejection = null;
  let discarded = 0;

  const cleanup = () => {
    try { ws.destroy(); } catch { /* already closed */ }
    rm(tmp, { force: true }).catch(() => {});
  };

  try {
    for await (const chunk of req) {
      received += chunk.length;

      if (rejection) {
        discarded += chunk.length;
        if (discarded > 1024 * 1024) break;
        continue;
      }

      if (received > MAX_UPLOAD) {
        rejection = [413, 'too_large', 'Файл больше 500 МБ.'];
        ws.destroy();
        continue;
      }

      if (!detected) {
        head = head.length ? Buffer.concat([head, chunk]) : chunk;
        if (head.length >= 16) {
          detected = detectAudio(head);
          if (!detected) {
            rejection = [415, 'unsupported_type', 'Это не похоже на аудиофайл (mp3, wav, flac, ogg, m4a).'];
            ws.destroy();
            continue;
          }
        }
      }

      hash.update(chunk);
      if (!ws.write(chunk)) await once(ws, 'drain');
    }
  } catch {
    rejection = rejection || [400, 'upload_failed', 'Не удалось прочитать тело запроса.'];
  }

  if (!rejection && !detected) detected = detectAudio(head);
  if (!rejection && !detected) {
    rejection = [415, 'unsupported_type', 'Это не похоже на аудиофайл (mp3, wav, flac, ogg, m4a).'];
  }
  if (!rejection && received === 0) rejection = [400, 'empty_file', 'Пустой файл.'];

  if (rejection) {
    cleanup();
    res.setHeader('Connection', 'close');
    return fail(res, ...rejection);
  }

  try {
    ws.end();
    await once(ws, 'finish');
  } catch {
    cleanup();
    return fail(res, 500, 'write_failed', 'Не удалось сохранить файл.');
  }
  if (!ws.writableFinished) {
    cleanup();
    return fail(res, 500, 'write_failed', 'Не удалось сохранить файл.');
  }

  const checksum = hash.digest('hex');
  const duplicate = findByChecksum(checksum);
  if (duplicate) {
    cleanup();
    inc('vision_upload_duplicates_total');
    res.statusCode = 409;
    return json(res, 409, {
      error: { code: 'duplicate', message: 'Этот файл уже есть в библиотеке.' },
      existing: { id: duplicate.id, title: duplicate.title, artist: duplicate.artist },
    });
  }

  const id = uid();
  const finalPath = path.join(MEDIA_DIR, `${id}.${detected.ext}`);

  try {
    await rename(tmp, finalPath);
  } catch {
    cleanup();
    return fail(res, 500, 'write_failed', 'Не удалось сохранить файл.');
  }

  const tags = await readTags(finalPath);

  let peaks = null;
  try {
    const raw = url.searchParams.get('peaks');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.length <= 400) {
        peaks = parsed.map((value) => Math.max(0, Math.min(1, Number(value) || 0)));
      }
    }
  } catch { /* битые пики не критичны */ }

  const filename = url.searchParams.get('filename');
  const filenameBase = filename ? filename.replace(/\.[a-z0-9]+$/i, '') : null;
  const providedTitle = str(url.searchParams.get('title'));
  const titleIsAuto = !providedTitle || (filenameBase && normalize(providedTitle) === normalize(filenameBase));
  const providedArtist = str(url.searchParams.get('artist'));

  const title = (!titleIsAuto ? providedTitle : null) || tags.title || providedTitle || filenameBase || 'Без названия';
  const artist = (providedArtist && providedArtist !== 'Unknown' ? providedArtist : null) || tags.artist || 'Unknown';
  const album = tags.album || str(url.searchParams.get('album'));
  const genre = tags.genre || str(url.searchParams.get('genre'), 80);
  const duration = Math.max(0, Number(url.searchParams.get('duration')) || 0);

  let coverMime = null;
  if (tags.cover) {
    try {
      coverMime = await saveCover(id, tags.cover);
    } catch {
      coverMime = null;
    }
  }

  try {
    insertTrack({
      id,
      title,
      artist,
      album,
      genre,
      description: str(url.searchParams.get('description'), 2000),
      mime: detected.mime,
      ext: detected.ext,
      size: received,
      duration,
      peaks: peaks ? JSON.stringify(peaks) : null,
      cover_mime: coverMime,
      checksum,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    rm(finalPath, { force: true }).catch(() => {});
    log('error', 'track insert failed', { error: error?.message });
    return fail(res, 500, 'db_error', 'Не удалось сохранить трек.');
  }

  inc('vision_upload_success_total');
  // файл на этом узле = блоб + живой сид: трекер сразу знает, у кого он есть
  declareBlob({ hash: checksum, bytes: received, mime: detected.mime });
  registerSeed({ hash: checksum, deviceId: DEVICE_ID, kind: 'origin', baseUrl: PUBLIC_URL || selfBaseUrl(req) });
  // транскодинг — в фоне: ответ клиенту не ждёт ffmpeg
  enqueueTranscode(id);
  json(res, 201, { ...withSources(getTrack(id, { withPeaks: true })), checksum });
}

async function handleCoverUpload(req, res, track) {
  const tmp = path.join(COVER_DIR, `.incoming-${track.id}`);
  const ws = createWriteStream(tmp);
  let head = Buffer.alloc(0);
  let received = 0;
  let detected = null;
  let rejection = null;

  try {
    for await (const chunk of req) {
      received += chunk.length;
      if (received > MAX_COVER) {
        rejection = [413, 'too_large', 'Обложка больше 8 МБ.'];
        break;
      }
      if (!detected) {
        head = head.length ? Buffer.concat([head, chunk]) : chunk;
        if (head.length >= 12) {
          detected = detectImage(head);
          if (!detected) {
            rejection = [415, 'unsupported_type', 'Нужен jpeg, png, webp или gif.'];
            break;
          }
        }
      }
      if (!ws.write(chunk)) await once(ws, 'drain');
    }
  } catch {
    rejection = [400, 'upload_failed', 'Не удалось прочитать файл.'];
  }

  if (!rejection && !detected) detected = detectImage(head);
  if (!rejection && !detected) rejection = [415, 'unsupported_type', 'Нужен jpeg, png, webp или gif.'];

  if (rejection) {
    ws.destroy();
    rm(tmp, { force: true }).catch(() => {});
    return fail(res, ...rejection);
  }

  ws.end();
  await once(ws, 'finish');

  for (const ext of Object.values(COVER_EXT)) {
    rmSync(path.join(COVER_DIR, `${track.id}.${ext}`), { force: true });
  }
  await rename(tmp, path.join(COVER_DIR, `${track.id}.${detected.ext}`));
  setCoverMime(track.id, detected.mime);
  res.writeHead(204);
  res.end();
}

/* --------------------------------- routes --------------------------------- */

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  if (pathname === '/api/health' && method === 'GET') {
    const free = freeDiskMb();
    setGauge('vision_disk_free_bytes', free === null ? null : free * 1024 * 1024);
    return json(res, 200, {
      ok: true,
      tracks: stats().tracks,
      diskFreeMb: free,
      version: VERSION,
      migrations: migrationStatus(),
      ffmpeg: {
        available: await ffmpegAvailable(),
        version: await ffmpegVersion(),
        path: await resolveFfmpeg(),
      },
      runtime: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        termux: Boolean(process.env.TERMUX_VERSION),
      },
      transcode: transcodeStatus(),
      storage: {
        mode: STORAGE_MODE,
        seedEnabled: SEED_ENABLED,
        deviceId: DEVICE_ID,
        publicUrl: PUBLIC_URL || null,
      },
      tracker: (() => {
        const t = trackerStats();
        setGauge('vision_seeds_online', t.seeds);
        setGauge('vision_blobs_total', t.blobs);
        setGauge('vision_blobs_no_source', t.noSource);
        return { blobs: t.blobs, seeds: t.seeds, servableBlobs: t.servableBlobs, noSource: t.noSource, ttlMs: t.ttlMs };
      })(),
    });
  }

  if ((pathname === '/api/openapi.json' || pathname === '/api/v1/openapi.json') && method === 'GET') {
    return json(res, 200, OPENAPI, { 'Cache-Control': 'public, max-age=300' });
  }

  if (pathname === '/api/auth/login' && method === 'POST') return handleLogin(req, res);

  if (!authorized(req)) {
    // <audio>/<img> не умеют присылать заголовок Authorization — для них
    // достаточно короткоживущей HMAC-подписи в query.
    const target = signedMediaTarget(pathname, url);
    const exp = url.searchParams.get('exp');
    const sig = url.searchParams.get('sig');
    const signed = Boolean(target && target.kinds.some((kind) => verifyMedia(target.id, kind, exp, sig)));
    if (!signed) return fail(res, 401, 'unauthorized', 'Требуется вход.');
  }

  if (pathname === '/api/me' && method === 'GET') {
    return json(res, 200, { ok: true, role: 'owner', version: VERSION });
  }

  if (pathname === '/api/stats' && method === 'GET') {
    const free = freeDiskMb();
    return json(res, 200, {
      ...stats(),
      diskFreeMb: free,
      version: VERSION,
      genres: genres(),
      migrations: migrationStatus(),
    });
  }

  /* ---- подписанные медиа-ссылки ---- */
  /* ---- внешние источники (метаданные + официальный виджет) ---- */
  if (pathname === '/api/external') {
    if (method === 'GET') {
      return json(res, 200, listExternal(Number(url.searchParams.get('limit')) || 200));
    }

    if (method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return fail(res, 400, 'invalid_json', 'Ожидался JSON вида { "urls": ["..."] }.');
      }

      const raw = Array.isArray(body.urls) ? body.urls : body.url ? [body.url] : [];
      const urls = raw.map((value) => String(value ?? '').trim()).filter(Boolean);
      if (!urls.length) return fail(res, 400, 'no_urls', 'Добавьте хотя бы одну ссылку.');
      if (urls.length > 50) return fail(res, 400, 'too_many_urls', 'За один раз — не больше 50 ссылок.');

      const added = [];
      const failed = [];
      for (const link of urls) {
        try {
          // только метаданные: аудио не скачиваем и не проксируем
          const resolved = await resolveSoundCloudLink(link);
          const record = upsertExternal(resolved);
          added.push(record);
          inc('vision_external_import_total', 1, { result: record.created ? 'created' : 'updated' });
        } catch (error) {
          if (!(error instanceof ImportError)) throw error;
          failed.push({ url: link, code: error.code, message: error.message });
          inc('vision_external_import_total', 1, { result: 'failed' });
        }
      }

      return json(res, added.length ? 201 : 400, { added, failed });
    }

    return fail(res, 405, 'method_not_allowed', 'Метод не поддерживается.');
  }

  const externalMatch = /^\/api\/external\/([A-Za-z0-9_-]{8,64})$/.exec(pathname);
  if (externalMatch) {
    const id = externalMatch[1];
    const record = getExternal(id);
    if (!record) return fail(res, 404, 'not_found', 'Ссылка не найдена.');

    if (method === 'PATCH') {
      const body = await readJson(req).catch(() => ({}));
      const note = body.note === null ? null : str(body.note, 300);
      return json(res, 200, updateExternalNote(id, note));
    }

    if (method === 'DELETE') {
      deleteExternal(id);
      res.writeHead(204);
      return res.end();
    }
  }

  /* ---- HLS: плейлист и сегменты (подпись та же, что для медиа) ---- */
  const hlsPlaylistMatch = /^\/api\/tracks\/([a-f0-9]{32})\/hls\.m3u8$/.exec(pathname);
  if (hlsPlaylistMatch && method === 'GET') {
    const id = hlsPlaylistMatch[1];
    if (!authoriseMedia(req, url, id, 'hls')) return fail(res, 401, 'unauthorized', 'Ссылка истекла.');
    const playlist = path.join(hlsPath(id), 'index.m3u8');
    if (!existsSync(playlist)) return fail(res, 404, 'no_hls', 'HLS ещё не нарезан.');

    const exp = url.searchParams.get('exp');
    const sig = url.searchParams.get('sig');
    const suffix = exp && sig ? `?exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}` : '';
    const body = readFileSync(playlist, 'utf8')
      .split('\n')
      .map((line) => {
        const value = line.trim();
        if (!value || value.startsWith('#')) return line;
        // относительные сегменты нельзя отдавать как есть: query-подпись
        // потеряется при разрешении относительного пути
        return `/api/tracks/${id}/hls/${value}${suffix}`;
      })
      .join('\n');

    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'private, max-age=60',
    });
    return res.end(body);
  }

  const hlsSegmentMatch = /^\/api\/tracks\/([a-f0-9]{32})\/hls\/(seg-\d{3,5}\.ts)$/.exec(pathname);
  if (hlsSegmentMatch && method === 'GET') {
    const [, id, segment] = hlsSegmentMatch;
    if (!authoriseMedia(req, url, id, 'hls')) return fail(res, 401, 'unauthorized', 'Ссылка истекла.');
    const file = path.join(hlsPath(id), segment);
    if (!existsSync(file)) return fail(res, 404, 'not_found', 'Сегмент не найден.');

    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Content-Length': statSync(file).size,
      'Cache-Control': 'private, max-age=3600',
    });
    return createReadStream(file).pipe(res);
  }

  if (pathname === '/api/media' && method === 'GET') {
    const ids = (url.searchParams.get('ids') || '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => /^[a-f0-9]{32}$/.test(id))
      .slice(0, 200);

    if (!ids.length) return fail(res, 400, 'invalid_ids', 'Нужен параметр ids со списком идентификаторов.');

    const items = {};
    for (const id of ids) {
      const track = getTrack(id);
      if (!track) continue;
      const variants = listVariants(id);
      const kinds = new Set(variants.map((variant) => variant.kind));

      const stream = signMedia(id, 'stream');
      const cover = track.cover ? signMedia(id, 'cover') : null;
      const local = track.checksum ? Boolean(localFileFor(track.checksum)) : true;
      const streams = local
        ? { original: `/api/tracks/${id}/stream?exp=${stream.exp}&sig=${stream.sig}` }
        : {};

      for (const codec of ['opus', 'aac']) {
        if (!kinds.has(codec)) continue;
        const signed = signMedia(id, `stream:${codec}`);
        streams[codec] = `/api/tracks/${id}/stream?format=${codec}&exp=${signed.exp}&sig=${signed.sig}`;
      }

      let hls = null;
      if (kinds.has('hls')) {
        const signed = signMedia(id, 'hls');
        hls = `/api/tracks/${id}/hls.m3u8?exp=${signed.exp}&sig=${signed.sig}`;
      }

      // файла на этом узле нет — отдаём подписанную ссылку на /download,
      // сервер сам сделает 302 на первое живое устройство
      let best = streams.opus ?? streams.aac ?? streams.original ?? null;
      if (!best) {
        const dl = signMedia(id, 'download');
        best = `/api/tracks/${id}/download?exp=${dl.exp}&sig=${dl.sig}`;
      }

      items[id] = {
        stream: best,
        streams,
        hls,
        cover: cover ? `/api/tracks/${id}/cover?exp=${cover.exp}&sig=${cover.sig}` : null,
        expiresAt: new Date(stream.exp).toISOString(),
      };
    }

    return json(res, 200, { ttlMs: MEDIA_TTL_MS, items });
  }

  /* ---- трекер реплик: блобы и сиды ---- */
  if (pathname === '/api/seeds' && method === 'GET') {
    return json(res, 200, trackerStats());
  }

  if (pathname === '/api/blobs' && method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const hash = String(body.hash || '').toLowerCase();
    if (!isHash(hash)) return fail(res, 400, 'invalid_hash', 'Нужен sha256 содержимого (64 hex).');
    const blob = declareBlob({
      hash,
      bytes: Number(body.bytes ?? body.size) || 0,
      mime: str(body.mime, 80) || 'application/octet-stream',
    });
    if (body.deviceId || body.kind) {
      registerSeed({
        hash,
        deviceId: str(body.deviceId, 120) || DEVICE_ID,
        kind: str(body.kind, 20) || 'node',
        baseUrl: str(body.baseUrl, 500),
      });
    }
    return json(res, 201, { blob, seeds: listSeeds(hash) });
  }

  const blobMatch = /^\/api\/blobs\/([a-f0-9]{64})(\/[a-z]+)?$/.exec(pathname);
  if (blobMatch) {
    const [, hash, action] = blobMatch;
    const blob = getBlob(hash);
    const local = localFileFor(hash);

    if (!action && method === 'GET') {
      if (!blob) return fail(res, 404, 'not_found', 'Блоб неизвестен.');
      return json(res, 200, {
        blob,
        local: Boolean(local),
        seeds: listSeeds(hash),
        stats: seedSummary([hash]).get(hash),
      });
    }

    if (!action && method === 'DELETE') {
      const removed = db.prepare('DELETE FROM blobs WHERE hash = ?').run(hash).changes > 0;
      if (!removed) return fail(res, 404, 'not_found', 'Блоб неизвестен.');
      inc('vision_blob_deleted_total');
      res.writeHead(204);
      return res.end();
    }

    if (action === '/seeds' && method === 'GET') {
      const seeds = listSeeds(hash);
      const base = selfBaseUrl(req);
      return json(res, 200, {
        hash,
        ttlMs: SEED_TTL_MS,
        stats: seedSummary([hash]).get(hash),
        local: Boolean(local),
        seeds: seeds.map((seed) => ({
          ...seed,
          url: seed.servable ? seedUrl(seed.deviceId === DEVICE_ID ? base : seed.baseUrl, hash) : null,
        })),
      });
    }

    if (action === '/seed' && (method === 'POST' || method === 'DELETE')) {
      if (method === 'DELETE') {
        const deviceId = url.searchParams.get('deviceId') || DEVICE_ID;
        const removed = removeSeed(hash, deviceId);
        if (!removed) return fail(res, 404, 'not_found', 'Сид не найден.');
        res.writeHead(204);
        return res.end();
      }

      const body = await readJson(req).catch(() => ({}));
      const kind = str(body.kind, 20) || 'node';
      const registered = registerSeed({
        hash,
        deviceId: str(body.deviceId, 120) || DEVICE_ID,
        kind,
        baseUrl: str(body.baseUrl, 500) || (kind === 'origin' ? PUBLIC_URL || selfBaseUrl(req) : null),
        ttlHint: true,
      });
      return json(res, 200, { ...registered, stats: seedSummary([hash]).get(hash) });
    }

    if (action === '/replicate' && method === 'POST') {
      const result = await adoptBlob(hash);
      if (!result.ok) return fail(res, 409, result.reason || 'replicate_failed', 'Не удалось забрать файл с сидов.');
      inc('vision_blob_replicated_total');
      return json(res, 200, { ...result, stats: seedSummary([hash]).get(hash) });
    }

    return fail(res, 404, 'not_found', 'Неизвестное действие с блобом.');
  }

  /* ---- треки ---- */
  if (pathname === '/api/tracks') {
    if (method === 'GET') {
      const filters = {
        q: url.searchParams.get('q') || undefined,
        genre: url.searchParams.get('genre') || undefined,
        liked: url.searchParams.get('liked') === '1',
        sort: url.searchParams.get('sort') || 'recent',
        limit: url.searchParams.get('limit') || 50,
        offset: url.searchParams.get('offset') || 0,
      };
      const items = withSources(listTracks(filters), { selfBase: selfBaseUrl(req) });
      const total = countTracks(filters);
      return json(res, 200, items, {
        'X-Total-Count': String(total),
        'X-Limit': String(filters.limit),
        'X-Offset': String(filters.offset),
      });
    }
    if (method === 'POST') {
      const type = String(req.headers['content-type'] || '').toLowerCase();
      const json = type.includes('application/json');
      if (json && STORAGE_MODE !== 'metadata') {
        return fail(
          res, 415, 'upload_expected',
          'Сервер хранит файлы сам (STORAGE_MODE=local) — загрузите аудио. Метаданные без файла принимаются в режиме metadata.'
        );
      }
      if (json) return handleMetadataUpload(req, res);
      return handleUpload(req, res, url);
    }
    return fail(res, 405, 'method_not_allowed', 'Метод не поддерживается.');
  }

  const trackMatch = /^\/api\/tracks\/([a-f0-9]{32})(\/[a-z]+)?$/.exec(pathname);
  if (trackMatch) {
    const [, id, action] = trackMatch;
    const track = getTrack(id, { withPeaks: true });
    if (!track) return fail(res, 404, 'not_found', 'Трек не найден.');

    if (!action && method === 'GET') {
      return json(res, 200, {
        ...withSources(track, { selfBase: selfBaseUrl(req) }),
        variants: listVariants(id),
      });
    }

    if (!action && method === 'PATCH') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return fail(res, 400, 'invalid_json', 'Ожидался JSON.');
      }

      const textFields = { title: 300, artist: 120, album: 160, genre: 80, description: 2000 };
      const patch = {};
      for (const [key, max] of Object.entries(textFields)) {
        if (key in body) {
          const value = str(body[key], max);
          if (key === 'title' && !value) return fail(res, 400, 'invalid_title', 'Название не может быть пустым.');
          patch[key] = value;
        }
      }
      if ('liked' in body) patch.liked = Boolean(body.liked);
      if (!Object.keys(patch).length) return fail(res, 400, 'nothing_to_update', 'Нет полей для обновления.');

      return json(res, 200, withSources(updateTrackFields(id, patch), { selfBase: selfBaseUrl(req) }));
    }

    if (!action && method === 'DELETE') {
      const meta = getTrackFile(track.id);
      deleteTrackRecord(id);
      if (meta?.ext) rm(path.join(MEDIA_DIR, `${track.id}.${meta.ext}`), { force: true }).catch(() => {});
      for (const ext of Object.values(COVER_EXT)) {
        rm(path.join(COVER_DIR, `${track.id}.${ext}`), { force: true }).catch(() => {});
      }
      deleteVariants(track.id);
      void removeVariants(track.id);
      inc('vision_track_deleted_total');
      res.writeHead(204);
      return res.end();
    }

    if (action === '/stream' && method === 'GET') {
      const format = String(url.searchParams.get('format') || 'original').toLowerCase();
      const normalised = ['opus', 'aac'].includes(format) ? format : 'original';
      const kind = normalised === 'original' ? 'stream' : `stream:${normalised}`;

      const allowed = normalised === 'original'
        ? authoriseMedia(req, url, id, 'stream') || authoriseMedia(req, url, id, 'stream:original')
        : authoriseMedia(req, url, id, kind);
      if (!allowed) return fail(res, 401, 'unauthorized', 'Ссылка истекла.');

      if (normalised !== 'original') {
        const variant = getVariant(id, normalised);
        const file = variantPath(id, normalised);
        if (variant && file && existsSync(file)) {
          return streamAudio(req, res, track, { file, mime: variant.mime, kind: normalised });
        }
        // варианта ещё нет (транскодинг идёт) — отдаём оригинал, клиенту это норм
        res.setHeader('X-Variant-Fallback', normalised);
      }
      return streamAudio(req, res, track);
    }

    if (action === '/cover') {
      if (method === 'PUT') return handleCoverUpload(req, res, track);
      if (method === 'GET') {
        if (!authoriseMedia(req, url, id, 'cover')) return fail(res, 401, 'unauthorized', 'Ссылка истекла.');
        return serveCover(req, res, track);
      }
    }

    if (action === '/download' && (method === 'GET' || method === 'HEAD')) {
      const allowed = authoriseMedia(req, url, id, 'download');
      if (!allowed) return fail(res, 401, 'unauthorized', 'Ссылка истекла.');

      const resolved = resolveDownload(track, { selfBase: selfBaseUrl(req) });
      const wantsJson = url.searchParams.get('json') === '1'
        || String(req.headers.accept || '').includes('application/json');

      if (!resolved) {
        inc('vision_download_no_source_total');
        return fail(res, 409, 'no_source', 'Ни одно устройство сейчас не раздаёт этот файл.');
      }

      if (wantsJson) {
        const blob = track.checksum ? getBlob(track.checksum) : null;
        return json(res, 200, {
          ...resolved,
          bytes: blob?.bytes ?? track.size,
          mime: blob?.mime ?? track.mime,
          seeds: track.checksum ? listSeeds(track.checksum) : [],
        });
      }

      inc('vision_download_redirect_total');
      res.writeHead(302, { Location: resolved.url, 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (action === '/play' && method === 'POST') {
      db.prepare('UPDATE tracks SET plays = plays + 1 WHERE id = ?').run(id);
      inc('vision_play_total');
      res.writeHead(204);
      return res.end();
    }

    if (action === '/listen' && method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const position = Math.max(0, Number(body.position) || 0);
      const duration = Math.max(0, Number(body.duration) || track.duration || 0);
      const completed = Boolean(body.completed) || (duration > 0 && position / duration > 0.9);
      recordListen(id, { position, duration, completed });
      res.writeHead(204);
      return res.end();
    }

    return fail(res, 404, 'not_found', 'Неизвестное действие.');
  }

  /* ---- история ---- */
  if (pathname === '/api/history') {
    if (method === 'GET') {
      const history = listHistory(url.searchParams.get('limit') || 12).map((entry) => ({
        ...entry,
        track: withSources(entry.track, { selfBase: selfBaseUrl(req) }),
      }));
      return json(res, 200, history);
    }
    if (method === 'DELETE') {
      clearHistory();
      res.writeHead(204);
      return res.end();
    }
  }

  /* ---- плейлисты ---- */
  if (pathname === '/api/playlists') {
    if (method === 'GET') return json(res, 200, listPlaylists());
    if (method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return fail(res, 400, 'invalid_json', 'Ожидался JSON.');
      }
      const name = str(body.name, 120);
      if (!name) return fail(res, 400, 'invalid_name', 'Нужно название плейлиста.');
      const id = uid();
      db.prepare('INSERT INTO playlists (id, name, description, created_at) VALUES (?, ?, ?, ?)')
        .run(id, name, str(body.description, 500), new Date().toISOString());
      return json(res, 201, getPlaylist(id));
    }
    return fail(res, 405, 'method_not_allowed', 'Метод не поддерживается.');
  }

  const playlistMatch = /^\/api\/playlists\/([a-f0-9]{32})(\/tracks(?:\/([a-f0-9]{32}))?)?$/.exec(pathname);
  if (playlistMatch) {
    const [, playlistId, sub, trackId] = playlistMatch;
    const playlist = getPlaylist(playlistId);
    if (!playlist) return fail(res, 404, 'not_found', 'Плейлист не найден.');

    if (!sub && method === 'GET') return json(res, 200, playlist);

    if (!sub && method === 'PATCH') {
      const body = await readJson(req).catch(() => ({}));
      const name = 'name' in body ? str(body.name, 120) : playlist.name;
      if (!name) return fail(res, 400, 'invalid_name', 'Нужно название плейлиста.');
      const description = 'description' in body ? str(body.description, 500) : playlist.description;
      db.prepare('UPDATE playlists SET name = ?, description = ? WHERE id = ?').run(name, description, playlistId);
      return json(res, 200, getPlaylist(playlistId));
    }

    if (!sub && method === 'DELETE') {
      db.prepare('DELETE FROM playlists WHERE id = ?').run(playlistId);
      res.writeHead(204);
      return res.end();
    }

    if (sub === '/tracks' && method === 'GET') {
      const filters = { playlistId, limit: 500, offset: 0 };
      return json(res, 200, withSources(listTracks(filters), { selfBase: selfBaseUrl(req) }), {
        'X-Total-Count': String(countTracks(filters)),
      });
    }

    if (sub === '/tracks' && method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const idToAdd = str(body.trackId);
      if (!idToAdd || !getTrack(idToAdd)) return fail(res, 400, 'invalid_track', 'Трек не найден.');
      const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
      db.prepare('INSERT OR REPLACE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)')
        .run(playlistId, idToAdd, (max?.p ?? -1) + 1);
      res.writeHead(204);
      return res.end();
    }

    if (sub?.startsWith('/tracks/') && method === 'DELETE') {
      db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').run(playlistId, trackId);
      res.writeHead(204);
      return res.end();
    }
  }

  return fail(res, 404, 'not_found', 'Маршрут не найден.');
}

/* --------------------------------- static --------------------------------- */

function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return fail(res, 400, 'invalid_path', 'Некорректный путь.');
  }
  if (pathname === '/') pathname = '/index.html';

  const resolved = path.resolve(WEB_DIST, `.${pathname}`);
  if (!resolved.startsWith(WEB_DIST)) return fail(res, 403, 'forbidden', 'Недопустимый путь.');

  if (existsSync(resolved) && statSync(resolved).isFile()) {
    const ext = path.extname(resolved).toLowerCase();
    const isAsset = pathname.startsWith('/assets/');
    const isHtml = ext === '.html';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': statSync(resolved).size,
      'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(isHtml ? { 'Content-Security-Policy': SECURITY_TXT } : {}),
    });
    return createReadStream(resolved).pipe(res);
  }

  const index = path.join(WEB_DIST, 'index.html');
  if (existsSync(index)) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': SECURITY_TXT,
    });
    return createReadStream(index).pipe(res);
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': SECURITY_TXT });
  res.end(`<!doctype html><meta charset="utf-8"><title>Vision Audio</title>
  <body style="font-family:system-ui;background:#0b0b0f;color:#eee;padding:40px">
  <h1>Vision Audio API работает</h1>
  <p>Веб-клиент ещё не собран. Выполните <code>npm run build</code> или запустите
  <code>npm run dev</code> (Vite проксирует /api на этот сервер).</p>
  <p>Health: <a style="color:#7c5cff" href="/api/health">/api/health</a></p></body>`);
}

/* --------------------------------- server --------------------------------- */

const server = createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  const requestId = randomUUID().slice(0, 8);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  res.setHeader('X-Request-Id', requestId);

  securityHeaders(res, req);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count, X-Limit, X-Offset, X-Request-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/metrics' && req.method === 'GET') {
    const metricsToken = process.env.METRICS_TOKEN;
    if (metricsToken) {
      const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
      if (provided !== metricsToken) return fail(res, 401, 'unauthorized', 'Нужен METRICS_TOKEN.');
    }
    const s = stats();
    const tracker = trackerStats();
    const free = freeDiskMb();
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    return res.end(renderMetrics({
      vision_tracks_total: s.tracks,
      vision_plays_total: s.plays,
      vision_likes_total: s.liked,
      vision_playlists_total: s.playlists,
      vision_storage_bytes: s.bytes,
      vision_disk_free_bytes: free === null ? null : free * 1024 * 1024,
      vision_blobs_total: tracker.blobs,
      vision_seeds_online: tracker.seeds,
      vision_blobs_no_source: tracker.noSource,
    }));
  }

  const finish = () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const status = res.statusCode;
    const route = routeKey(versionedPath(url.pathname));
    inc('vision_http_requests_total', 1, { method: req.method, route, status });
    observeDuration(durationMs / 1000, { route });

    if (!url.pathname.startsWith('/api/') && url.pathname !== '/metrics') return;
    log('info', 'http', {
      id: requestId,
      method: req.method,
      path: url.pathname,
      status,
      ms: Math.round(durationMs),
    });
  };
  res.on('finish', finish);

  try {
    if (url.pathname.startsWith('/seed/')) {
      return handleSeed(req, res, url, url.pathname);
    }
    if (url.pathname.startsWith('/api/')) {
      const internal = versionedPath(url.pathname);
      const target = internal === url.pathname ? url : new URL(`${internal}${url.search}`, 'http://internal');
      return await handleApi(req, res, target);
    }
    return serveStatic(req, res, url);
  } catch (error) {
    if (error?.message === 'body_too_large') return fail(res, 413, 'too_large', 'Тело запроса слишком велико.');
    if (error?.message === 'invalid_json') return fail(res, 400, 'invalid_json', 'Некорректный JSON.');
    log('error', 'unhandled', { id: requestId, path: url.pathname, error: error?.stack || String(error) });
    if (!res.headersSent) return fail(res, 500, 'internal_error', 'Внутренняя ошибка сервера.');
    res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  log('info', 'server started', {
    host: HOST,
    port: PORT,
    data: DATA_DIR,
    version: VERSION,
    storage: STORAGE_MODE,
    seeding: SEED_ENABLED,
    device: DEVICE_ID,
  });

  // Трекер знает про этот узел, только пока идёт heartbeat: раз в минуту.
  const beat = () => {
    try {
      const count = heartbeatSelf();
      const stale = reconcileSelf();
      const pruned = pruneSeeds();
      if (count || stale || pruned) {
        log('info', 'seed heartbeat', { blobs: count, reconciled: stale, pruned });
      }
    } catch (error) {
      log('error', 'seed heartbeat failed', { error: error?.message });
    }
  };
  beat();
  setInterval(beat, 60_000).unref();
  if (process.env.TRANSCODE_BACKFILL === '1') {
    void backfillVariants().then((count) => {
      if (count) log('info', 'transcode backfill queued', { tracks: count });
    });
  }
});

const shutdown = () => {
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server };
