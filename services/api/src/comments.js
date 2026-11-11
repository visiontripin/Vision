/**
 * Таймкод-комментарии для приглашённых (Фаза 6, E3).
 *
 * Правила простые и проверяемые:
 *  - комментарий живёт в ленте конкретной ссылки и конкретного трека: гость видит
 *    только тред присланного микса, а не всю библиотеку;
 *  - секунда клампится в `0..duration` — «на 900-й секунде» двухминутного трека
 *    не появится, даже если пришлют руками;
 *  - тело и имя ограничены по длине, HTML не интерпретируется (всё экранируется
 *    при рендере), переводы строк сохраняются;
 *  - удалять может автор (по хешу адреса) или владелец библиотеки;
 *  - троттлинг на адрес: не больше 8 комментариев в минуту по одной ссылке.
 *
 * Отдельный модуль, чтобы правила не расползлись между HTTP-слоем и страницей:
 * `server.js` вызывает их и для API, и для гостевого POST.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  countRecentComments, deleteShareComment, getShareComment, insertShareComment,
  listShareComments,
} from './db.js';
import { shareAllowsTrack } from './shares.js';

export const COMMENT_MAX_BODY = 600;
export const COMMENT_MAX_AUTHOR = 40;
export const COMMENT_MAX_PER_MINUTE = 8;

export class CommentError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Хеш адреса для «своих» комментариев: тот же секрет, что у `share_hits`. */
export function authorHash(ip, secret = process.env.VISION_SECRET || 'vision') {
  if (!ip) return null;
  return createHash('sha256').update(`${secret}:comment:${ip}`).digest('hex').slice(0, 32);
}

/**
 * Гость не должен писать «от имени» знакомого и ломать вёрстку: убираем управляющие
 * символы, схлопываем длинные серии пробелов, обрезаем по длине.
 */
export function cleanText(value, max) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/** Секунда: число, не отрицательное, не больше длительности (если она есть). */
export function clampSeconds(value, duration) {
  const raw = Number(value);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : 0;
  const max = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : null;
  const bounded = max === null ? seconds : Math.min(seconds, max);
  return Math.round(bounded * 10) / 10;
}

/** Наружу: без author_hash и без внутренних полей ссылки. */
export function publicComment(comment) {
  return {
    id: comment.id,
    trackId: comment.trackId,
    at: comment.at,
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt,
  };
}

export function listComments(share, { trackId = null } = {}) {
  if (trackId && !shareAllowsTrack(share, trackId)) {
    throw new CommentError('track_not_in_share', 'Этого трека нет в присланной ссылке.', 403);
  }
  return listShareComments({ shareId: share.id, trackId }).map(publicComment);
}

/**
 * Создание комментария. `actor` — { ip } для гостя или { owner: true } для владельца.
 * Возвращает публичное представление; причина отказа — `CommentError`.
 */
export function addComment(share, { trackId, at, author, body } = {}, { ip = null, duration = null } = {}) {
  const track = String(trackId || '');
  if (!/^[a-f0-9]{32}$/.test(track)) {
    throw new CommentError('invalid_track', 'Нужен trackId — трек из этой ссылки.', 400);
  }
  if (!shareAllowsTrack(share, track)) {
    throw new CommentError('track_not_in_share', 'Этого трека нет в присланной ссылке.', 403);
  }

  const text = cleanText(body, COMMENT_MAX_BODY);
  if (!text) throw new CommentError('empty_body', 'Комментарий пустой.', 400);

  const name = cleanText(author, COMMENT_MAX_AUTHOR) || 'Гость';

  const hash = authorHash(ip);
  if (hash && countRecentComments(share.id, hash, 60_000) >= COMMENT_MAX_PER_MINUTE) {
    throw new CommentError('too_many', 'Слишком много комментариев подряд — подождите минуту.', 429);
  }

  const comment = insertShareComment({
    id: randomUUID().replace(/-/g, ''),
    shareId: share.id,
    trackId: track,
    at: clampSeconds(at, duration),
    author: name,
    authorHash: hash,
    body: text,
    createdAt: new Date().toISOString(),
  });

  return publicComment(comment);
}

/**
 * Удаление: автор (совпадение хеша адреса) или владелец библиотеки.
 * Чужой гость получает 403, несуществующий — 404: без утечки «есть/нет».
 */
export function removeComment(commentId, { ip = null, owner = false } = {}) {
  const comment = getShareComment(String(commentId || ''));
  if (!comment) throw new CommentError('not_found', 'Комментарий не найден.', 404);
  const mine = ip ? authorHash(ip) : null;
  if (!owner && (!mine || comment.authorHash !== mine)) {
    throw new CommentError('forbidden', 'Удалять можно только свои комментарии.', 403);
  }
  deleteShareComment(comment.id);
  return { id: comment.id, deleted: true };
}
