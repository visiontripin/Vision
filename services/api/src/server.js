import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, statSync, statfsSync, rmSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  db, DATA_DIR, MEDIA_DIR, COVER_DIR,
  getTrack, getTrackFile, listTracks, listPlaylists, getPlaylist, stats, genres,
} from './db.js';
import {
  VERSION, PASSWORD, issueToken, verifyToken, safeEqual, rateLimit,
  detectAudio, detectImage, json, fail, readJson, uid, str,
} from './lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WEB_DIST = path.join(ROOT, 'apps', 'web', 'dist');
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD = 500 * 1024 * 1024;
const MAX_COVER = 8 * 1024 * 1024;

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

function authorized(req, url) {
  const header = req.headers.authorization || '';
  const headerToken = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (verifyToken(headerToken)) return true;
  // <audio>/<img> не умеют отправлять заголовки — для GET-медиа разрешаем токен в query.
  const queryToken = url.searchParams.get('token');
  return req.method === 'GET' && verifyToken(queryToken || '');
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.socket.remoteAddress || 'local';
}

/* ---------------------------------- auth --------------------------------- */

async function handleLogin(req, res) {
  if (!rateLimit(clientIp(req))) {
    return fail(res, 429, 'rate_limited', 'Слишком много попыток входа. Попробуйте через 5 минут.');
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    return fail(res, 400, 'invalid_json', 'Ожидался JSON.');
  }
  if (!safeEqual(body.password || '', PASSWORD)) {
    return fail(res, 401, 'unauthorized', 'Неверный пароль.');
  }
  json(res, 200, issueToken());
}

/* -------------------------------- streaming ------------------------------- */

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

  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }

  const headers = {
    'Content-Type': track.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    ETag: etag,
  };

  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = range.end - range.start + 1;
    res.writeHead(206, headers);
    createReadStream(file, { start: range.start, end: range.end }).pipe(res);
  } else {
    headers['Content-Length'] = size;
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
  }
}

/* --------------------------------- uploads -------------------------------- */

async function handleUpload(req, res, url) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > MAX_UPLOAD) {
    return fail(res, 413, 'too_large', 'Файл больше 500 МБ.');
  }

  const tmp = path.join(MEDIA_DIR, `.incoming-${uid()}`);
  const ws = createWriteStream(tmp);
  let head = Buffer.alloc(0);
  let received = 0;
  let detected = null;
  let rejection = null;

  const cleanup = () => {
    try { ws.destroy(); } catch { /* already closed */ }
    rm(tmp, { force: true }).catch(() => {});
  };

  let discarded = 0;

  try {
    for await (const chunk of req) {
      received += chunk.length;

      // Уже отклонили: дочитываем небольшой хвост, чтобы клиент получил внятный ответ.
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

  const id = uid();
  const finalName = `${id}.${detected.ext}`;
  const finalPath = path.join(MEDIA_DIR, finalName);

  try {
    await rename(tmp, finalPath);
  } catch {
    cleanup();
    return fail(res, 500, 'write_failed', 'Не удалось сохранить файл.');
  }

  let peaks = null;
  try {
    const raw = url.searchParams.get('peaks');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.length <= 400) {
        peaks = parsed.map((n) => Math.max(0, Math.min(1, Number(n) || 0)));
      }
    }
  } catch { /* битые пики не критичны */ }

  const duration = Math.max(0, Number(url.searchParams.get('duration')) || 0);
  const title =
    str(url.searchParams.get('title')) ||
    str(url.searchParams.get('filename'))?.replace(/\.[a-z0-9]+$/i, '') ||
    'Без названия';

  const row = {
    id,
    title,
    artist: str(url.searchParams.get('artist')) || 'Unknown',
    album: str(url.searchParams.get('album')),
    genre: str(url.searchParams.get('genre'), 80),
    description: str(url.searchParams.get('description'), 2000),
    mime: detected.mime,
    ext: detected.ext,
    size: received,
    duration,
    peaks: peaks ? JSON.stringify(peaks) : null,
    created_at: new Date().toISOString(),
  };

  try {
    db.prepare(
      `INSERT INTO tracks (id, title, artist, album, genre, description, mime, ext, size, duration, peaks, plays, liked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
    ).run(
      row.id, row.title, row.artist, row.album, row.genre, row.description,
      row.mime, row.ext, row.size, row.duration, row.peaks, row.created_at
    );
  } catch (error) {
    rm(finalPath, { force: true }).catch(() => {});
    console.error('[db] insert failed', error?.message);
    return fail(res, 500, 'db_error', 'Не удалось сохранить трек.');
  }

  json(res, 201, getTrack(id, { withPeaks: true }));
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

  rmSync(path.join(COVER_DIR, `${track.id}.jpg`), { force: true });
  rmSync(path.join(COVER_DIR, `${track.id}.png`), { force: true });
  rmSync(path.join(COVER_DIR, `${track.id}.webp`), { force: true });
  rmSync(path.join(COVER_DIR, `${track.id}.gif`), { force: true });

  await rename(tmp, path.join(COVER_DIR, `${track.id}.${detected.ext}`));
  db.prepare('UPDATE tracks SET cover_mime = ? WHERE id = ?').run(detected.mime, track.id);
  res.writeHead(204);
  res.end();
}

/* --------------------------------- routes --------------------------------- */

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]

  if (pathname === '/api/health' && method === 'GET') {
    const free = freeDiskMb();
    return json(res, 200, { ok: true, tracks: stats().tracks, diskFreeMb: free, version: VERSION });
  }

  if (pathname === '/api/auth/login' && method === 'POST') return handleLogin(req, res);

  if (!authorized(req, url)) {
    return fail(res, 401, 'unauthorized', 'Требуется вход.');
  }

  if (pathname === '/api/me' && method === 'GET') {
    return json(res, 200, { ok: true, role: 'owner', version: VERSION });
  }

  if (pathname === '/api/stats' && method === 'GET') {
    return json(res, 200, { ...stats(), diskFreeMb: freeDiskMb(), version: VERSION, genres: genres() });
  }

  /* ---- tracks ---- */
  if (pathname === '/api/tracks') {
    if (method === 'GET') {
      return json(res, 200, listTracks({
        q: url.searchParams.get('q') || undefined,
        genre: url.searchParams.get('genre') || undefined,
        liked: url.searchParams.get('liked') === '1',
        sort: url.searchParams.get('sort') || 'recent',
        limit: url.searchParams.get('limit') || 500,
      }));
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
      const fields = [];
      const values = [];
      const textFields = { title: 300, artist: 120, album: 160, genre: 80, description: 2000 };
      for (const [key, max] of Object.entries(textFields)) {
        if (key in body) {
          const value = str(body[key], max);
          if (key === 'title' && !value) return fail(res, 400, 'invalid_title', 'Название не может быть пустым.');
          fields.push(`${key} = ?`);
          values.push(value);
        }
      }
      if ('liked' in body) {
        fields.push('liked = ?');
        values.push(body.liked ? 1 : 0);
      }
      if (!fields.length) return fail(res, 400, 'nothing_to_update', 'Нет полей для обновления.');
      values.push(id);
      db.prepare(`UPDATE tracks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      return json(res, 200, getTrack(id, { withPeaks: true }));
    }

    if (!action && method === 'DELETE') {
      const meta = getTrackFile(track.id);
      const file = path.join(MEDIA_DIR, `${track.id}.${meta?.ext}`);
      db.prepare('DELETE FROM tracks WHERE id = ?').run(id);
      rm(file, { force: true }).catch(() => {});
      for (const ext of ['jpg', 'png', 'webp', 'gif']) {
        rm(path.join(COVER_DIR, `${track.id}.${ext}`), { force: true }).catch(() => {});
      }
      res.writeHead(204);
      return res.end();
    }

    if (action === '/stream' && method === 'GET') return streamAudio(req, res, track);

    if (action === '/cover') {
      if (method === 'PUT') return handleCoverUpload(req, res, track);
      if (method === 'GET') {
        if (!track.cover) return fail(res, 404, 'no_cover', 'Обложка не загружена.');
        for (const ext of ['jpg', 'png', 'webp', 'gif']) {
          const file = path.join(COVER_DIR, `${track.id}.${ext}`);
          if (existsSync(file)) {
            const mime = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext];
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
            return createReadStream(file).pipe(res);
          }
        }
        return fail(res, 404, 'no_cover', 'Обложка не загружена.');
      }
    }

    if (action === '/play' && method === 'POST') {
      db.prepare('UPDATE tracks SET plays = plays + 1 WHERE id = ?').run(id);
      res.writeHead(204);
      return res.end();
    }

    return fail(res, 404, 'not_found', 'Неизвестное действие.');
  }

  /* ---- playlists ---- */
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
      return json(res, 200, listTracks({ playlistId, limit: 2000 }));
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

function freeDiskMb() {
  try {
    const s = statfsSync(DATA_DIR);
    return Math.round((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}

/* --------------------------------- static --------------------------------- */

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const resolved = path.resolve(WEB_DIST, '.' + pathname);
  if (!resolved.startsWith(WEB_DIST)) {
    return fail(res, 403, 'forbidden', 'Недопустимый путь.');
  }

  if (existsSync(resolved) && statSync(resolved).isFile()) {
    const ext = path.extname(resolved).toLowerCase();
    const isAsset = pathname.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': statSync(resolved).size,
      'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    return createReadStream(resolved).pipe(res);
  }

  const index = path.join(WEB_DIST, 'index.html');
  if (existsSync(index)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return createReadStream(index).pipe(res);
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Vision Audio</title>
  <body style="font-family:system-ui;background:#0b0b0f;color:#eee;padding:40px">
  <h1>Vision Audio API работает</h1>
  <p>Веб-клиент ещё не собран. Выполните <code>npm run build</code> или запустите
  <code>npm run dev</code> (Vite проксирует /api на этот сервер).</p>
  <p>Health: <a style="color:#ff5a1f" href="/api/health">/api/health</a></p></body>`);
}

/* --------------------------------- server --------------------------------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    if (error?.message === 'body_too_large') return fail(res, 413, 'too_large', 'Тело запроса слишком велико.');
    if (error?.message === 'invalid_json') return fail(res, 400, 'invalid_json', 'Некорректный JSON.');
    console.error('[api] unhandled', error);
    if (!res.headersSent) return fail(res, 500, 'internal_error', 'Внутренняя ошибка сервера.');
    res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Vision Audio API → http://${HOST}:${PORT} (data: ${DATA_DIR})`);
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
