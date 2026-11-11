/**
 * Встраивание (Фаза 6, E4): oEmbed и компактный виджет `/embed/:token`.
 *
 * Модель доступа та же, что у гостевой страницы (`docs/adr/0007`): ключ — токен
 * приватной ссылки, никакой сессии и никакого API. Виджет — это один `<audio>`
 * на трек (или первый трек плейлиста) плюс список остальных; всё остальное
 * отдаёт браузер, поэтому скриптов и бандла нет.
 *
 * Почему отдельный модуль: гостевая страница (`shares.js`) — «полный» экран с
 * комментариями и скачиванием, виджет — маленький и в чужом документе. Общего
 * у них только источник данных (`guestView`) и стиль ссылок.
 *
 * Безопасность:
 *  - `frame-ancestors *` нужен по определению встраивания, но `X-Frame-Options`
 *    не ставим — иначе браузер выкинет виджет;
 *  - `sandbox` в iframe не ставим: `<audio>` и так не даёт доступа к родителю,
 *    а `allow-same-origin` всё равно бы понадобился для медиа;
 *  - `Referrer-Policy: no-referrer`, чтобы токен не утёк в логи чужих сайтов;
 *  - `plays` виджет не инкрементирует: вставка в популярный блог не должна
 *    сжигать лимит открытий. Прослушивания идут через `/s/:token/stream/:id`
 *    и учитываются как обычно.
 */
import { formatDuration } from './shares.js';
import { VERSION } from './lib.js';

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const DEFAULT_WIDTH = 480;
export const TRACK_HEIGHT = 180;
export const PLAYLIST_HEIGHT = 320;
const MIN_SIZE = 40;
const MAX_SIZE = 960;

/** Размеры виджета: пропорциональное уменьшение под maxwidth/maxheight. */
export function embedSize(kind, { maxwidth, maxheight } = {}) {
  const width = clamp(maxwidth, DEFAULT_WIDTH);
  const naturalHeight = kind === 'playlist' ? PLAYLIST_HEIGHT : TRACK_HEIGHT;
  let height = Math.round((width / DEFAULT_WIDTH) * naturalHeight);
  const limit = clamp(maxheight, null);
  if (limit && height > limit) {
    height = limit;
    return { width: Math.max(MIN_SIZE, Math.round((height / naturalHeight) * DEFAULT_WIDTH)), height };
  }
  return { width, height };
}

function clamp(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.max(Math.round(number), MIN_SIZE), MAX_SIZE);
}

/**
 * Адрес ссылки из параметра `url` oEmbed → `{ token }`.
 * Принимаем только свои адреса: oEmbed-эндпоинт публичный, и открытый редирект
 * на произвольный хост превратил бы его в инструмент для фишинга.
 */
export function parseShareUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw, 'http://local.invalid');
  } catch {
    return null;
  }
  const match = /^\/(?:s|embed)\/([A-Za-z0-9_-]{20,128})\/?$/.exec(url.pathname);
  if (!match) return null;
  return { token: match[1] };
}

/** Признак «ссылка жива» по полю share/`publicShare`. */
export function shareIsUsable(share, now = Date.now()) {
  if (!share || share.revokedAt || share.rotatedAt) return false;
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= now) return false;
  if (share.maxPlays !== null && share.maxPlays !== undefined && share.plays >= share.maxPlays) return false;
  return true;
}

/** Заголовок и подпись карточки: то же, что видит гость на странице. */
export function embedMeta(view) {
  const tracks = view.tracks ?? [];
  const isPlaylist = view.kind === 'playlist';
  const title = isPlaylist
    ? view.playlist?.name || 'Плейлист'
    : tracks[0]?.title || 'Трек';
  const duration = tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0);
  const author = isPlaylist
    ? `${tracks.length} ${plural(tracks.length, 'трек', 'трека', 'треков')}`
    : [tracks[0]?.artist, tracks[0]?.duration ? formatDuration(tracks[0].duration) : null]
        .filter(Boolean)
        .join(' · ');
  return {
    title,
    author,
    duration,
    tracks,
    isPlaylist,
    coverTrackId: tracks[0]?.id ?? null,
  };
}

function plural(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** Светлая тема — для блогов со светлым фоном (`?theme=light`). */
export function embedTheme(value) {
  return String(value ?? '').toLowerCase() === 'light' ? 'light' : 'dark';
}

/**
 * HTML виджета. Внутри один `<audio>` с `preload="metadata"` и ссылки на все
 * треки плейлиста (переключение — обычный переход на полную страницу: виджет
 * не должен уметь «плеер целиком», иначе он превратится в приложение в iframe).
 */
export function renderEmbedWidget(view, { token, selfBase = '', theme = 'dark' } = {}) {
  const base = String(selfBase || '').replace(/\/$/, '');
  const link = `${base}/s/${token}`;
  const meta = embedMeta(view);
  const first = meta.tracks.find((track) => track.available !== false) ?? meta.tracks[0];
  const src = first ? `/s/${token}/stream/${encodeURIComponent(first.id)}` : '';
  const cover = meta.coverTrackId ? `/s/${token}/cover/${encodeURIComponent(meta.coverTrackId)}` : '';

  const others = meta.isPlaylist ? meta.tracks.slice(1, 7) : [];
  const more = meta.tracks.length - 1 - others.length;
  const rows = others
    .map(
      (track) => `
      <li class="t">
        <a href="${esc(link)}#track-${esc(track.id)}" target="_blank" rel="noreferrer">
          <span class="t__title">${esc(track.title)}</span>
          <span class="t__time">${esc(track.duration ? formatDuration(track.duration) : '')}</span>
        </a>
      </li>`
    )
    .join('');

  return `<!doctype html>
<html lang="ru" data-theme="${esc(theme)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="generator" content="Vision Audio ${esc(VERSION)}">
<title>${esc(meta.title)} — Vision Audio</title>
<link rel="stylesheet" href="/embed/widget.css">
<style>:root{color-scheme:dark}html[data-theme="light"]{color-scheme:light}</style>
</head>
<body>
<div class="w">
  ${cover ? `<img class="w__cover" src="${esc(cover)}" alt="" width="64" height="64" loading="lazy">` : '<span class="w__cover w__cover--empty" aria-hidden="true"></span>'}
  <div class="w__body">
    <a class="w__title" href="${esc(link)}" target="_blank" rel="noreferrer">${esc(meta.title)}</a>
    <span class="w__author">${esc(meta.author)}</span>
    ${src ? `<audio class="w__audio" controls preload="metadata" src="${esc(src)}"></audio>` : '<span class="w__missing">Источник недоступен</span>'}
  </div>
</div>
${
  others.length || more > 0
    ? `<ol class="list">${rows}${
        more > 0 ? `<li class="t t--more">ещё ${more} на странице ссылки</li>` : ''
      }</ol>`
    : ''
}
<footer class="f">
  <a href="${esc(link)}" target="_blank" rel="noreferrer">Открыть в Vision Audio</a>
  <span>·</span>
  <a href="${esc(`${base}/`)}" target="_blank" rel="noreferrer">${esc(hostOf(base) || 'Vision Audio')}</a>
</footer>
</body>
</html>`;
}

function hostOf(base) {
  try {
    return new URL(base).host;
  } catch {
    return '';
  }
}

/** Тело oEmbed-ответа по спецификации 1.0 (`type: rich`). */
export function oembedPayload(view, { token, selfBase = '', maxwidth, maxheight } = {}) {
  const base = String(selfBase || '').replace(/\/$/, '');
  const meta = embedMeta(view);
  const { width, height } = embedSize(view.kind, { maxwidth, maxheight });
  const src = `${base}/embed/${token}`;
  return {
    version: '1.0',
    type: 'rich',
    provider_name: 'Vision Audio',
    provider_url: base,
    title: meta.title,
    author_name: meta.author || undefined,
    thumbnail_url: meta.coverTrackId ? `${base}/s/${token}/cover/${meta.coverTrackId}` : undefined,
    thumbnail_width: meta.coverTrackId ? 512 : undefined,
    thumbnail_height: meta.coverTrackId ? 512 : undefined,
    html: `<iframe src="${esc(src)}" width="${width}" height="${height}" style="border:0;max-width:100%" title="${esc(meta.title)}" loading="lazy" allow="autoplay; fullscreen"></iframe>`,
    width,
    height,
    vision: {
      version: VERSION,
      kind: view.kind,
      tracks: meta.tracks.length,
      duration: meta.duration,
    },
  };
}

/** XML-вариант (`format=xml`) — некоторые агрегаторы просят именно его. */
export function oembedXml(payload) {
  const fields = Object.entries(payload)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      if (typeof value === 'object') {
        const inner = Object.entries(value)
          .map(([k, v]) => `<${k}>${esc(v)}</${k}>`)
          .join('');
        return `<${key}>${inner}</${key}>`;
      }
      return `<${key}>${esc(value)}</${key}>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?><oembed>${fields}</oembed>`;
}

/** Страница-ошибка для виджета: маленькая, в той же теме, без утечек. */
export function renderEmbedGone(reason, theme = 'dark') {
  const text = {
    not_found: 'Ссылка не найдена',
    revoked: 'Ссылка отозвана',
    rotated: 'Ссылка перевыпущена',
    expired: 'Срок действия ссылки истёк',
    exhausted: 'Лимит открытий исчерпан',
  }[reason] || 'Ссылка недоступна';
  return `<!doctype html><html lang="ru" data-theme="${esc(theme)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(text)} — Vision Audio</title><link rel="stylesheet" href="/embed/widget.css"></head>
<body><div class="gone"><strong>${esc(text)}</strong><span>Попросите владельца выпустить новую</span></div></body></html>`;
}
