/**
 * Приватные ссылки (Фаза 6, E1): «послушай мой микс» без аккаунта.
 *
 * Модель безопасности (docs/ADR 0007):
 *  - ссылка = случайный 256-битный токен в пути (`/s/<token>`), не сессионный токен;
 *  - в БД лежит только `sha256(token)` — дамп базы не даёт рабочий URL;
 *  - срок жизни и лимит открытий задаёт владелец, отзыв мгновенный;
 *  - гость не получает доступа к API: только чтение одной цели (трек/плейлист),
 *    поток с Range и обложку. Никаких поисков, лент и чужих треков.
 *
 * Гостевые страницы рендерятся на сервере без JavaScript: `<audio src>` сам
 * делает Range-запросы, а OG-теги нужны мессенджерам, которые JS не выполняют.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  COVER_DIR, MEDIA_DIR, db, deleteCommentsForShare, deleteShare, findShareByTokenHash, getCoverInfo,
  getPlaylist, getShare, getTrack, insertShare, listShareComments, listShares, listTracks,
  recordShareHit, revokeShare, revokeSharesForTarget, rotateShareToken, shareStats,
  updateShare,
} from './db.js';
import { withSources, resolveDownload, localFileFor } from './seeds.js';
import { log } from './lib.js';

const DEFAULT_TTL_MS = Number(process.env.SHARE_DEFAULT_TTL_MS || 7 * 24 * 3600_000);
const MAX_TTL_MS = 365 * 24 * 3600_000;

export const SHARE_KINDS = new Set(['track', 'playlist']);

/** «7d», «24h», «30m», «forever» → миллисекунды (null = бессрочно). */
export function parseTtl(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_TTL_MS;
  if (value === 0 || value === '0' || value === 'forever' || value === 'never') return null;
  if (typeof value === 'number') return Math.min(Math.max(value, 60_000), MAX_TTL_MS);

  const match = /^(\d+)\s*(m|h|d|w)$/i.exec(String(value).trim());
  if (!match) return DEFAULT_TTL_MS;
  const amount = Number(match[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2].toLowerCase()];
  return Math.min(Math.max(amount * unit, 60_000), MAX_TTL_MS);
}

const newToken = () => randomBytes(32).toString('base64url');
const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

/**
 * `ip_hash` вместо сырого IP: для «сколько разных людей открыло» достаточно
 * необратимого хеша с секретом, а PII в логах и БД не появляется.
 */
export function ipHash(ip, secret = process.env.VISION_SECRET || 'vision') {
  if (!ip) return null;
  return createHash('sha256').update(`${secret}:${ip}`).digest('hex').slice(0, 32);
}

export class ShareError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Создание ссылки. Возвращает share + одноразово показанный токен. */
export function createShare({ targetKind, targetId, title = null, ttl, maxPlays = null } = {}) {
  if (!SHARE_KINDS.has(targetKind)) {
    throw new ShareError('invalid_kind', 'Ссылку можно сделать только на трек или плейлист.');
  }
  const exists = targetKind === 'track' ? getTrack(targetId) : getPlaylist(targetId);
  if (!exists) throw new ShareError('target_not_found', 'Трек или плейлист не найден.', 404);

  const ttlMs = parseTtl(ttl);
  const limit = maxPlays === null || maxPlays === undefined || maxPlays === ''
    ? null
    : Math.max(1, Math.min(10_000, Number(maxPlays) || 1));

  const token = newToken();
  const share = insertShare({
    id: randomBytes(16).toString('hex'),
    tokenHash: hashToken(token),
    targetKind,
    targetId,
    title: title ? String(title).slice(0, 120) : null,
    expiresAt: ttlMs === null ? null : new Date(Date.now() + ttlMs).toISOString(),
    maxPlays: limit,
    createdAt: new Date().toISOString(),
  });

  return { share, token };
}

/** Перевыпуск: старая ссылка перестаёт работать, новая показывается один раз. */
export function rotateShare(id) {
  const share = getShare(id);
  if (!share) throw new ShareError('not_found', 'Ссылка не найдена.', 404);
  const token = newToken();
  const updated = rotateShareToken(id, hashToken(token));
  return { share: updated, token };
}

export function shareList({ targetKind, targetId, includeRevoked = false } = {}) {
  return listShares({ targetKind, targetId, includeRevoked }).map((share) => ({
    ...share,
    stats: shareStats(share.id),
    active: isActive(share),
  }));
}

export function isActive(share, now = Date.now()) {
  if (!share || share.revokedAt) return false;
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= now) return false;
  if (share.maxPlays !== null && share.plays >= share.maxPlays) return false;
  return true;
}

/** Правка ссылки: подпись, срок, лимит открытий. */
export function updateShareFields(id, patch) {
  return updateShare(id, patch);
}

/** Полная очистка: ссылка, её журнал и комментарии (FK-каскад включён не всегда). */
export function dropShareById(id) {
  deleteCommentsForShare(id);
  return deleteShare(id);
}

export function revokeShareById(id) {
  return revokeShare(id);
}


/** Удаление трека/плейлиста гасит его ссылки (иначе 404 вместо «файла нет»). */
export function revokeForTarget(targetKind, targetId) {
  return revokeSharesForTarget(targetKind, targetId);
}

export function shareUrl(baseUrl, token) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  return `${base}/s/${token}`;
}

/* ------------------------------ гостевое чтение --------------------------- */

/**
 * По токену: живая ссылка или понятная причина отказа.
 * 404 — токена нет; 410 — истекла/отозвана/лимит открытий.
 */
export function resolveShareToken(token) {
  if (!token || typeof token !== 'string' || token.length < 20) {
    return { error: 'not_found', status: 404 };
  }
  const found = findShareByTokenHash(hashToken(token));
  if (!found) return { error: 'not_found', status: 404 };
  const { share, previous } = found;
  if (previous) return { share, error: 'rotated', status: 410 };
  if (share.revokedAt) return { share, error: 'revoked', status: 410 };
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) {
    return { share, error: 'expired', status: 410 };
  }
  if (share.maxPlays !== null && share.plays >= share.maxPlays) {
    return { share, error: 'exhausted', status: 410 };
  }
  return { share };
}

/** Данные для гостевой страницы/JSON: только цель ссылки, ничего лишнего. */
export function guestView(share, { selfBase = '' } = {}) {
  const withComments = (tracks) =>
    tracks.map((track) => ({ ...track, comments: listShareComments({ shareId: share.id, trackId: track.id }) }));

  if (share.targetKind === 'track') {
    const track = getTrack(share.targetId, { withPeaks: true });
    if (!track) return null;
    const view = withSources(track, { selfBase });
    return {
      kind: 'track',
      share: publicShare(share),
      track: view,
      tracks: withComments([view]),
      playlist: null,
    };
  }

  const playlist = getPlaylist(share.targetId);
  if (!playlist) return null;
  const tracks = withSources(listTracks({ playlistId: playlist.id, limit: 500, offset: 0 }), { selfBase });
  return { kind: 'playlist', share: publicShare(share), playlist, track: null, tracks: withComments(tracks) };
}

/** Наружу — без token_hash и прочих внутренностей. */
export function publicShare(share) {
  return {
    id: share.id,
    targetKind: share.targetKind,
    targetId: share.targetId,
    title: share.title,
    expiresAt: share.expiresAt,
    maxPlays: share.maxPlays,
    plays: share.plays,
    revokedAt: share.revokedAt,
    lastSeenAt: share.lastSeenAt,
    createdAt: share.createdAt,
  };
}

/** Можно ли отдать конкретный трек по этой ссылке. */
export function shareAllowsTrack(share, trackId) {
  if (share.targetKind === 'track') return share.targetId === trackId;
  if (share.targetKind !== 'playlist') return false;
  const row = db
    .prepare('SELECT 1 AS ok FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?')
    .get(share.targetId, trackId);
  return Boolean(row);
}

/* --------------------------------- отдача --------------------------------- */

function sendFile(req, res, { file, mime, etagBase, cacheControl = 'private, max-age=300' }) {
  if (!existsSync(file)) return false;

  const size = statSync(file).size;
  const etag = `"${createHash('sha1').update(`${etagBase}:${size}`).digest('hex')}"`;
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    ETag: etag,
  };
  const range = parseRange(req.headers.range, size);

  if (req.headers['if-none-match'] === etag && !req.headers.range) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return true;
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    res.end();
    return true;
  }
  if (range) {
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': range.end - range.start + 1,
    });
    createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  createReadStream(file).pipe(res);
  return true;
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
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

const COVER_MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Поток трека для гостя: локальный файл, иначе редирект на живой сид. */
export function serveGuestStream(req, res, share, trackId, { selfBase = '' } = {}) {
  const track = getTrack(trackId);
  if (!track) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: { code: 'not_found', message: 'Трек не найден.' } }));
  }
  if (!shareAllowsTrack(share, trackId)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: { code: 'forbidden', message: 'Этого трека нет в ссылке.' } }));
  }

  const meta = trackFileMeta(trackId);
  const local = meta?.ext ? path.join(MEDIA_DIR, `${track.id}.${meta.ext}`) : null;
  if (local && existsSync(local)) {
    return sendFile(req, res, {
      file: local,
      mime: meta?.mime || track.mime,
      etagBase: `share:${share.id}:${track.id}`,
    });
  }

  const resolved = resolveDownload(track, { selfBase });
  if (!resolved) {
    res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: { code: 'no_source', message: 'Файл сейчас не раздаётся.' } }));
  }
  res.writeHead(302, { Location: resolved.url, 'Cache-Control': 'no-store' });
  return res.end();
}

/** Скачивание: всегда редирект на подписанную ссылку сида (или локальный файл). */
export function serveGuestDownload(req, res, share, trackId, { selfBase = '' } = {}) {
  const track = getTrack(trackId);
  if (!track) {
    res.writeHead(404);
    return res.end();
  }
  if (!shareAllowsTrack(share, trackId)) {
    res.writeHead(403);
    return res.end();
  }

  const local = track.checksum ? localFileFor(track.checksum) : null;
  if (local) {
    const name = encodeURIComponent(`${track.artist} - ${track.title}`.replace(/[\\/:*?"<>|]/g, '_'));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${name}.${local.file.split('.').pop()}`);
    return sendFile(req, res, {
      file: local.file,
      mime: local.mime,
      etagBase: `share-dl:${share.id}:${track.id}`,
      cacheControl: 'private, no-store',
    });
  }

  const resolved = resolveDownload(track, { selfBase });
  if (!resolved) {
    res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: { code: 'no_source', message: 'Файл сейчас не раздаётся.' } }));
  }
  res.writeHead(302, { Location: resolved.url, 'Cache-Control': 'no-store' });
  return res.end();
}

export function serveGuestCover(req, res, share, trackId) {
  if (!shareAllowsTrack(share, trackId)) {
    res.writeHead(403);
    return res.end();
  }
  const info = getCoverInfo(trackId);
  const ext = COVER_MIME_EXT[info?.cover_mime];
  if (!ext) {
    res.writeHead(404);
    return res.end();
  }
  const file = path.join(COVER_DIR, `${trackId}.${ext}`);
  return sendFile(req, res, {
    file,
    mime: info.cover_mime,
    etagBase: `share-cover:${trackId}`,
    cacheControl: 'private, max-age=3600',
  });
}

/* -------------------------------- страницы -------------------------------- */

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Абсолютный адрес для OG-тегов и ссылок в ответах. Гости открывают страницу
 * с другого устройства, поэтому относительный путь в `og:image` бесполезен.
 * `PUBLIC_URL` (если задан) приоритетнее заголовков запроса.
 */
export function externalBase(publicUrl, req) {
  if (publicUrl) return String(publicUrl).replace(/\/$/, '');
  const headers = req?.headers || {};
  const proto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req?.socket?.encrypted ? 'https' : 'http');
  const host = headers['x-forwarded-host'] || headers.host;
  return host ? `${proto}://${host}` : '';
}

export function formatDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (!total) return '0:00';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** `1:07` — таймкод комментария; часы появляются только у длинных треков. */
export function commentClock(seconds) {
  return formatDuration(seconds);
}

/** Подпись автора: имя обрезано, чтобы длинное не ломало строку. */
function shortAuthor(name) {
  const text = String(name || 'Гость');
  return text.length > 24 ? `${text.slice(0, 23)}…` : text;
}

/**
 * HTML гостевой страницы. Без JavaScript и без бандла: нативный `<audio>`
 * покрывает play/pause/seek, а OG-теги читают мессенджеры.
 */
export function renderSharePage(view, { token, selfBase = '' }) {
  const base = String(selfBase || '').replace(/\/$/, '');
  const link = `${base}/s/${token}`;
  const tracks = view.tracks ?? [];
  /** Имя гостя помним в пределах страницы: после отправки поле не пустое. */
  const guestName = String(view.guestName || '').trim();
  const isPlaylist = view.kind === 'playlist';
  const title = isPlaylist
    ? (view.playlist?.name || 'Плейлист')
    : (tracks[0]?.title || 'Трек');
  const subtitle = isPlaylist
    ? `${tracks.length} треков · ${formatDuration(tracks.reduce((sum, t) => sum + (t.duration || 0), 0))}`
    : [tracks[0]?.artist, formatDuration(tracks[0]?.duration)].filter(Boolean).join(' · ');
  const coverTrack = tracks[0];
  const ogImage = coverTrack?.cover ? `${base}/s/${token}/cover/${coverTrack.id}` : null;
  const description = isPlaylist
    ? (view.playlist?.description || `${tracks.length} треков · Vision Audio`)
    : [tracks[0]?.artist, tracks[0]?.album].filter(Boolean).join(' · ') || 'Vision Audio';

  /**
   * Каждая строка — трек, плеер и лента комментариев к секундам. Комментарии
   * выводятся сервером, поэтому гость видит их без JavaScript; форма работает
   * обычным POST и возвращает на страницу с якорем к треку.
   */
  const rows = tracks
    .map((track) => {
      const comments = track.comments ?? [];
      const feed = comments.length
        ? comments
            .map(
              (comment) => `
          <li class="cmt" id="comment-${esc(track.id)}-${esc(comment.id)}">
            <a class="cmt__at" href="#track-${esc(track.id)}" data-seek="${esc(comment.at)}"
               aria-label="Перемотать на ${esc(commentClock(comment.at))}">${esc(commentClock(comment.at))}</a>
            <span class="cmt__author">${esc(shortAuthor(comment.author))}</span>
            <span class="cmt__body">${esc(comment.body)}</span>
            <form class="cmt__del" method="post" action="/s/${esc(token)}/comments">
              <input type="hidden" name="_method" value="delete">
              <input type="hidden" name="commentId" value="${esc(comment.id)}">
              <button type="submit" title="Удалить свой комментарий" aria-label="Удалить комментарий">×</button>
            </form>
          </li>`
            )
            .join('')
        : '<li class="cmt cmt--empty">Комментариев пока нет — отметьте любимую секунду.</li>';

      return `
      <li class="row${track.available === false ? ' row--missing' : ''}" id="track-${esc(track.id)}">
        <div class="row__text">
          <strong>${esc(track.title)}</strong>
          <span>${esc(track.artist)}${track.duration ? ` · ${esc(formatDuration(track.duration))}` : ''}${
            track.available === false ? ' · нет источника' : ''
          }</span>
        </div>
        <audio preload="none" controls src="/s/${esc(token)}/stream/${esc(track.id)}"
               data-track="${esc(track.id)}" data-duration="${esc(track.duration ?? '')}"></audio>
        <a class="dl" href="/s/${esc(token)}/download/${esc(track.id)}" download>Скачать</a>
        <div class="cmtbox">
          <ul class="cmtlist" data-count="${comments.length}">${feed}</ul>
          <form class="cmtform" method="post" action="/s/${esc(token)}/comments">
            <input type="hidden" name="trackId" value="${esc(track.id)}">
            <input type="hidden" name="at" value="0" data-at>
            <input name="author" maxlength="40" placeholder="Ваше имя" autocomplete="nickname" value="${esc(view.guestName || '')}">
            <input name="body" maxlength="600" required placeholder="Что сказать на этой секунде?">
            <button type="submit">Отправить</button>
            <span class="cmtform__hint" data-hint>Комментарий встанет на текущую секунду плеера</span>
          </form>
        </div>
      </li>`;
    })
    .join('');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Vision Audio</title>
<meta property="og:type" content="music.${isPlaylist ? 'playlist' : 'song'}">
<meta property="og:site_name" content="Vision Audio">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(link)}">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">\n<meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}
<meta name="robots" content="noindex, nofollow">
<link rel="alternate" type="application/json+oembed" href="${esc(`${base}/api/oembed?url=${encodeURIComponent(link)}`)}" title="${esc(title)}">
<link rel="alternate" type="text/xml+oembed" href="${esc(`${base}/api/oembed?format=xml&url=${encodeURIComponent(link)}`)}" title="${esc(title)}">
<style>
  :root { color-scheme: dark; --accent:#ff5a1f; --panel:#121218; --line:rgba(255,255,255,.09); --muted:#9a9aab; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; font-family:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
         color:#f4f4f8; background:radial-gradient(900px 520px at 80% -10%, rgba(255,90,31,.18), transparent 60%), #07070a; }
  main { max-width: 720px; margin: 0 auto; padding: 40px 20px 80px; }
  .brand { display:flex; align-items:center; gap:10px; font-weight:800; letter-spacing:-.02em; }
  .mark { width:34px; height:34px; border-radius:11px; display:grid; place-items:center; color:#0a0a0d;
          background:linear-gradient(145deg,#ff8a3d,#ff5a1f); }
  h1 { font-size: clamp(24px, 5vw, 34px); margin: 26px 0 6px; letter-spacing:-.03em; }
  .sub { color: var(--muted); margin: 0 0 26px; font-size: 14.5px; }
  ul { list-style:none; margin:0; padding:0; display:grid; gap:10px; }
  .row--missing audio { opacity: .45; }
  .row { display:grid; grid-template-columns: minmax(0,1fr) auto auto; align-items:center; gap:12px;
         padding:12px 14px; border:1px solid var(--line); border-radius:14px; background: var(--panel); }
  .row__text { min-width:0; display:grid; gap:2px; }
  .row__text strong { font-size:14.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .row__text span { font-size:12.5px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  audio { width: 220px; max-width: 46vw; height: 34px; }
  .dl { font-size:12.5px; color:var(--accent); text-decoration:none; white-space:nowrap; }
  .dl:hover { text-decoration:underline; }
  .note { margin-top:28px; font-size:12.5px; color:var(--muted); line-height:1.6; }
  .cmtbox { grid-column: 1 / -1; display:grid; gap:8px; border-top:1px dashed var(--line); padding-top:10px; }
  .cmtlist { display:grid; gap:6px; }
  .cmt { display:flex; align-items:baseline; gap:8px; font-size:12.5px; }
  .cmt__at { flex:none; min-width:38px; padding:2px 7px; border-radius:999px; text-align:center;
             font-weight:700; font-variant-numeric:tabular-nums; color:var(--accent);
             background:rgba(255,90,31,.12); text-decoration:none; }
  .cmt__at:hover { background:rgba(255,90,31,.22); }
  .cmt__author { color:#f4f4f8; font-weight:600; }
  .cmt__body { color:var(--muted); white-space:pre-wrap; overflow-wrap:anywhere; }
  .cmt--empty { color:var(--muted); font-size:12px; }
  .cmt__del { margin-left:auto; }
  .cmt__del button { border:none; background:none; color:var(--muted); cursor:pointer;
                     font-size:15px; line-height:1; padding:0 4px; border-radius:6px; }
  .cmt__del button:hover { color:#ff6b6b; }
  .cmtform { display:grid; grid-template-columns: 120px minmax(0,1fr) auto; gap:8px; align-items:center; }
  .cmtform input { min-width:0; padding:8px 10px; border-radius:10px; border:1px solid var(--line);
                   background:#0d0d12; color:#f4f4f8; font:inherit; font-size:12.5px; }
  .cmtform input:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  .cmtform button { padding:8px 14px; border:none; border-radius:999px; cursor:pointer;
                    background:var(--accent); color:#120a05; font-weight:700; font-size:12.5px; }
  .cmtform__hint { grid-column:1 / -1; font-size:11.5px; color:var(--muted); }
  @media (max-width: 560px) {
    .row { grid-template-columns: minmax(0,1fr); }
    audio { width: 100%; max-width: none; }
    .dl { justify-self:start; }
    .cmtform { grid-template-columns: 1fr; }
    .cmt { flex-wrap:wrap; }
  }
</style>
</head>
<body>
<main>
  <div class="brand"><span class="mark" aria-hidden="true">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M5 15V9l4 3-4 3z"/><path d="M11 18V6l7 6-7 6z"/></svg>
  </span>Vision Audio</div>
  <h1>${esc(title)}</h1>
  <p class="sub">${esc(subtitle)}${view.share?.title ? ` · ${esc(view.share.title)}` : ''}</p>
  <ul>${rows}</ul>
  <p class="note">Ссылка личная: её можно отозвать в любой момент, а статистика открытий видна только владельцу библиотеки.
  Скачанный файл остаётся у вас — так ссылка работает в метро и самолёте.${
    tracks.some((track) => track.available === false)
      ? ' Треки с пометкой «нет источника» сейчас не раздаются ни одним устройством.'
      : ''
  }</p>
</main>
<script>
/* Прогрессивное улучшение: страница работает и без JS, но с ним удобнее —
   таймкод перематывает плеер, форма подставляет текущую секунду трека. */
(function () {
  /* имя гостя запоминаем локально, чтобы не вводить на каждой секунде */
  var nameInputs = document.querySelectorAll('.cmtform [name="author"]');
  try {
    var saved = window.localStorage.getItem('vision.guestName');
    if (saved) nameInputs.forEach(function (input) { if (!input.value) input.value = saved; });
  } catch (error) { /* приватный режим — просто не запоминаем */ }
  nameInputs.forEach(function (input) {
    input.addEventListener('change', function () {
      try { window.localStorage.setItem('vision.guestName', input.value.slice(0, 40)); } catch (error) {}
    });
  });

  document.querySelectorAll('.cmt__at').forEach(function (link) {
    link.addEventListener('click', function (event) {
      var row = link.closest('.row');
      var audio = row && row.querySelector('audio');
      var seconds = Number(link.getAttribute('data-seek'));
      if (!audio || !Number.isFinite(seconds)) return;
      event.preventDefault();
      audio.currentTime = seconds;
      var playing = audio.play();
      if (playing && playing.catch) playing.catch(function () {});
    });
  });

  document.querySelectorAll('.cmtform').forEach(function (form) {
    var row = form.closest('.row');
    var audio = row && row.querySelector('audio');
    var at = form.querySelector('[data-at]');
    var hint = form.querySelector('[data-hint]');
    if (!audio || !at) return;

    var sync = function () {
      var seconds = Math.max(0, Math.round((audio.currentTime || 0) * 10) / 10);
      at.value = String(seconds);
      if (hint) {
        var total = Math.floor(seconds);
        var mm = Math.floor(total / 60);
        var ss = String(total % 60).padStart(2, '0');
        hint.textContent = 'Комментарий встанет на ' + mm + ':' + ss;
      }
    };

    sync();
    audio.addEventListener('timeupdate', sync);
    var body = form.querySelector('[name="body"]');
    if (body) body.addEventListener('focus', sync);
  });
})();
</script>
</body>
</html>`;
}

export function renderShareGone(reason, customText = null) {
  const text = customText || {
    revoked: 'Ссылка отозвана владельцем.',
    rotated: 'Ссылка перевыпущена — старая больше не действует.',
    expired: 'Срок действия ссылки истёк.',
    exhausted: 'Лимит открытий по этой ссылке исчерпан.',
    not_found: 'Такой ссылки нет. Возможно, она удалена.',
  }[reason] || 'Ссылка недоступна.';

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Ссылка недоступна — Vision Audio</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07070a;color:#f4f4f8;
font-family:'Inter',system-ui,sans-serif;padding:24px}div{max-width:420px;text-align:center;line-height:1.6}
p{color:#9a9aab}strong{font-size:20px}</style></head>
<body><div><strong>Ссылка недоступна</strong><p>${esc(text)}</p>
<p>Попросите владельца библиотеки прислать новую.</p></div></body></html>`;
}

/* ---- небольшие помощники, которым нужен доступ к БД из server.js ---- */

function trackFileMeta(trackId) {
  const row = db.prepare('SELECT ext, mime FROM tracks WHERE id = ?').get(trackId);
  return row ?? null;
}

export function logShareHit(share, kind, ip) {
  try {
    recordShareHit(share.id, { kind, ipHash: ipHash(ip) });
  } catch (error) {
    log('warn', 'share hit failed', { error: error?.message });
  }
}
