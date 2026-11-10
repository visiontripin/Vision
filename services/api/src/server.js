import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, statSync, statfsSync, rmSync } from 'node:fs';
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
} from './db.js';
import { readTags, isSupportedCover } from './tags.js';
import { inc, observeDuration, renderMetrics, setGauge } from './metrics.js';
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
const SECURITY_TXT = 'default-src \'self\'; img-src \'self\' data: blob:; media-src \'self\' blob:; '
  + 'style-src \'self\' \'unsafe-inline\'; script-src \'self\'; connect-src \'self\'; font-src \'self\'; '
  + 'frame-ancestors *; base-uri \'self\'; form-action \'self\'';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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

function streamAudio(req, res, track) {
  const meta = getTrackFile(track.id);
  const file = path.join(MEDIA_DIR, `${track.id}.${meta?.ext}`);
  if (!existsSync(file)) return fail(res, 404, 'file_missing', 'Файл трека не найден.');

  const size = statSync(file).size;
  const range = parseRange(req.headers.range, size);
  const etag = `"${createHash('sha1').update(`${track.id}:${size}`).digest('hex')}"`;

  if (req.headers['if-none-match'] === etag && !req.headers.range) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }

  const headers = {
    'Content-Type': meta?.mime || track.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    ETag: etag,
  };

  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = range.end - range.start + 1;
    res.writeHead(206, headers);
    createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    inc('vision_stream_partial_total');
  } else {
    headers['Content-Length'] = size;
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
    inc('vision_stream_full_total');
  }
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
  json(res, 201, { ...getTrack(id, { withPeaks: true }), checksum });
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
    });
  }

  if (pathname === '/api/auth/login' && method === 'POST') return handleLogin(req, res);

  if (!authorized(req)) {
    // <audio>/<img> не умеют присылать заголовок Authorization — для них
    // достаточно короткоживущей HMAC-подписи в query.
    const signedMedia = /^\/api\/tracks\/([a-f0-9]{32})\/(stream|cover)$/.exec(pathname);
    const signed = signedMedia
      && verifyMedia(signedMedia[1], signedMedia[2], url.searchParams.get('exp'), url.searchParams.get('sig'));
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
      const stream = signMedia(id, 'stream');
      const cover = track.cover ? signMedia(id, 'cover') : null;
      items[id] = {
        stream: `/api/tracks/${id}/stream?exp=${stream.exp}&sig=${stream.sig}`,
        cover: cover ? `/api/tracks/${id}/cover?exp=${cover.exp}&sig=${cover.sig}` : null,
        expiresAt: new Date(stream.exp).toISOString(),
      };
    }

    return json(res, 200, { ttlMs: MEDIA_TTL_MS, items });
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
      const items = listTracks(filters);
      const total = countTracks(filters);
      return json(res, 200, items, {
        'X-Total-Count': String(total),
        'X-Limit': String(filters.limit),
        'X-Offset': String(filters.offset),
      });
    }
    if (method === 'POST') return handleUpload(req, res, url);
    return fail(res, 405, 'method_not_allowed', 'Метод не поддерживается.');
  }

  const trackMatch = /^\/api\/tracks\/([a-f0-9]{32})(\/[a-z]+)?$/.exec(pathname);
  if (trackMatch) {
    const [, id, action] = trackMatch;
    const track = getTrack(id, { withPeaks: true });
    if (!track) return fail(res, 404, 'not_found', 'Трек не найден.');

    if (!action && method === 'GET') return json(res, 200, track);

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

      return json(res, 200, updateTrackFields(id, patch));
    }

    if (!action && method === 'DELETE') {
      const meta = getTrackFile(track.id);
      deleteTrackRecord(id);
      if (meta?.ext) rm(path.join(MEDIA_DIR, `${track.id}.${meta.ext}`), { force: true }).catch(() => {});
      for (const ext of Object.values(COVER_EXT)) {
        rm(path.join(COVER_DIR, `${track.id}.${ext}`), { force: true }).catch(() => {});
      }
      inc('vision_track_deleted_total');
      res.writeHead(204);
      return res.end();
    }

    if (action === '/stream' && method === 'GET') {
      if (!authoriseMedia(req, url, id, 'stream')) return fail(res, 401, 'unauthorized', 'Ссылка истекла.');
      return streamAudio(req, res, track);
    }

    if (action === '/cover') {
      if (method === 'PUT') return handleCoverUpload(req, res, track);
      if (method === 'GET') {
        if (!authoriseMedia(req, url, id, 'cover')) return fail(res, 401, 'unauthorized', 'Ссылка истекла.');
        return serveCover(req, res, track);
      }
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
      return json(res, 200, listHistory(url.searchParams.get('limit') || 12));
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
      return json(res, 200, listTracks(filters), {
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
    const free = freeDiskMb();
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    return res.end(renderMetrics({
      vision_tracks_total: s.tracks,
      vision_plays_total: s.plays,
      vision_likes_total: s.liked,
      vision_playlists_total: s.playlists,
      vision_storage_bytes: s.bytes,
      vision_disk_free_bytes: free === null ? null : free * 1024 * 1024,
    }));
  }

  const finish = () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const status = res.statusCode;
    inc('vision_http_requests_total', 1, { method: req.method, route: routeKey(url.pathname), status });
    observeDuration(durationMs / 1000, { route: routeKey(url.pathname) });

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
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
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
  log('info', 'server started', { host: HOST, port: PORT, data: DATA_DIR, version: VERSION });
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
