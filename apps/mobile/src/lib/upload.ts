/**
 * Загрузка треков с телефона (H4): чистая логика, без React и без expo.
 *
 * Телефон не знает ничего, кроме ссылки после выбора файла (`file:///…`) и
 * имени, которое дал файловый менеджер. Всё, что можно решить заранее —
 * тип, расширение, метаданные, — решается здесь, чтобы это можно было проверить
 * тестами: на устройстве отлаживать «почему сервер ответил 415» дорого.
 *
 * Формат запроса — тот же, что у веба: тело запроса это сам аудиофайл
 * (`Content-Type: audio/*`), метаданные едут в query. Один контракт на всех
 * клиентах значит, что сервер не надо учить новому способу загрузки.
 */

/** Расширения и mime, которые сервер принимает (`detectAudio` в server.js). */
export const AUDIO_TYPES = [
  { ext: 'mp3', mime: 'audio/mpeg', label: 'MP3' },
  { ext: 'm4a', mime: 'audio/mp4', label: 'M4A' },
  { ext: 'aac', mime: 'audio/aac', label: 'AAC' },
  { ext: 'wav', mime: 'audio/wav', label: 'WAV' },
  { ext: 'flac', mime: 'audio/flac', label: 'FLAC' },
  { ext: 'ogg', mime: 'audio/ogg', label: 'OGG' },
  { ext: 'opus', mime: 'audio/ogg', label: 'OPUS' },
] as const;

/** Предел сервера: больше 500 МБ он отвергнет ещё до чтения тела. */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export type PickedAudio = {
  uri: string;
  name?: string | null;
  mimeType?: string | null;
  size?: number | null;
  duration?: number | null;
};

export type UploadMeta = {
  title: string;
  artist?: string | null;
  album?: string | null;
  genre?: string | null;
  duration?: number | null;
};

export type UploadPlan = {
  /** Адрес запроса: тело = файл, метаданные в query. */
  path: string;
  mime: string;
  ext: string;
  title: string;
  bytes: number | null;
};

// `Map<string, string>` явно: вывод из `as const` даёт union литералов, и любой
// mime из системы (`audio/x-flac`) перестаёт в него влезать.
const MIME_BY_EXT = new Map<string, string>(AUDIO_TYPES.map((item) => [item.ext, item.mime]));
const EXT_BY_MIME = new Map<string, string>(AUDIO_TYPES.map((item) => [item.mime, item.ext]));

/** `Cool Track (1).mp3` → `mp3`; null, если расширения нет. */
export function extOf(name: string | null | undefined): string | null {
  const value = String(name ?? '').trim().toLowerCase();
  const match = /\.([a-z0-9]{2,5})$/.exec(value);
  return match ? match[1] : null;
}

/**
 * Mime файла: сначала то, что сказала система, потом расширение, потом
 * `application/octet-stream` (сервер сам разберётся по сигнатуре).
 *
 * Порядок именно такой: у Android `content://` uri `mimeType` бывает пустым, но
 * бывает и врущим (`audio/mpeg` для m4a) — расширение надёжнее, а сигнатура
 * надёжнее обоих, поэтому решает сервер.
 */
export function mimeForFile(picked: PickedAudio): string {
  const declared = String(picked.mimeType ?? '').trim().toLowerCase();
  const ext = extOf(picked.name ?? picked.uri);
  const fromExt = ext ? MIME_BY_EXT.get(ext) : null;
  /*
   * Расширение важнее системного mime: Android регулярно присылает `audio/mpeg`
   * для m4a и файлов из мессенджеров. Нет расширения — берём mime, если он
   * вообще про аудио; иначе пусть решает сигнатура на сервере.
   */
  if (fromExt) return fromExt;
  if (EXT_BY_MIME.has(declared) || declared.startsWith('audio/')) return declared;
  return 'application/octet-stream';
}

export function extForMime(mime: string): string | null {
  return EXT_BY_MIME.get(String(mime ?? '').toLowerCase()) ?? null;
}

/**
 * Имя файла для метаданных. `content://` — это не имя: Android отдаёт такой uri,
 * и без проверки `title` превратился бы в «42».
 */
export function fileNameOf(picked: PickedAudio): string {
  const name = String(picked.name ?? '').trim();
  if (name) return name;
  const uri = String(picked.uri ?? '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) && !/^file:/i.test(uri)) return '';
  return uri.split('/').pop() ?? '';
}

/**
 * Разбор имени файла в метаданные — запасной вариант, когда тегов нет.
 *
 * Теги читает сервер (он умеет ID3/FLAC/MP4 и уже это делает при загрузке).
 * Здесь — только то, что видно в имени: «Artist - Title.mp3» и подчёркивания
 * вместо пробелов, как их оставляют диктофоны и мессенджеры.
 */
export function guessMeta(name: string | null | undefined): { title: string; artist: string | null } {
  const raw = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const withoutExt = raw.replace(/\.[a-z0-9]{2,5}$/i, '');
  const cleaned = withoutExt.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return { title: 'Без названия', artist: null };

  const parts = cleaned.split(/\s+-\s+/);
  if (parts.length >= 2 && parts[0] && parts.slice(1).join(' - ').trim()) {
    return { title: parts.slice(1).join(' - ').trim(), artist: parts[0].trim() };
  }
  return { title: cleaned, artist: null };
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: 'unsupported_type' | 'too_large' | 'empty_file' | 'no_file'; message: string };

/**
 * Проверка до отправки. Те же коды, что у сервера (`415`, `413`, `400`), чтобы
 * человек видел одинаковый текст независимо от того, где сработала проверка —
 * и не ждал загрузки 400 МБ, чтобы узнать про FLAC.
 */
export function validatePicked(picked: PickedAudio | null | undefined): ValidationResult {
  if (!picked?.uri) return { ok: false, code: 'no_file', message: 'Файл не выбран.' };

  const ext = extOf(picked.name ?? picked.uri);
  const mime = mimeForFile(picked);
  const known = (ext && MIME_BY_EXT.has(ext)) || EXT_BY_MIME.has(mime) || mime.startsWith('audio/');
  if (!known) {
    return {
      ok: false,
      code: 'unsupported_type',
      message: 'Это не похоже на аудиофайл (mp3, m4a, aac, wav, flac, ogg, opus).',
    };
  }

  if (typeof picked.size === 'number' && picked.size > MAX_UPLOAD_BYTES) {
    return { ok: false, code: 'too_large', message: 'Файл больше 500 МБ.' };
  }
  if (picked.size === 0) return { ok: false, code: 'empty_file', message: 'Пустой файл.' };

  return { ok: true };
}

/**
 * План запроса. Метаданные в query — те же имена, что понимает сервер:
 * `title`, `artist`, `album`, `genre`, `duration`.
 *
 * Пустые значения **не отправляются**: сервер отличает «поле не передали»
 * (тогда берёт тег из файла) от «передали пустую строку» (тогда сотрёт тег).
 */
export function buildUploadPlan(picked: PickedAudio, meta: UploadMeta): UploadPlan {
  const mime = mimeForFile(picked);
  const ext = extOf(fileNameOf(picked) || picked.uri) ?? extForMime(mime) ?? '';
  const guessed = guessMeta(fileNameOf(picked));
  const title = String(meta.title ?? '').trim() || guessed.title;

  const params = new URLSearchParams();
  params.set('title', title);
  const artist = String(meta.artist ?? '').trim() || guessed.artist || '';
  if (artist) params.set('artist', artist);
  for (const key of ['album', 'genre'] as const) {
    const value = String(meta[key] ?? '').trim();
    if (value) params.set(key, value);
  }
  const duration = Number(meta.duration ?? picked.duration ?? 0);
  if (Number.isFinite(duration) && duration > 0) params.set('duration', String(Math.round(duration)));

  return {
    path: `/api/tracks?${params.toString()}`,
    mime,
    ext,
    title,
    bytes: typeof picked.size === 'number' ? picked.size : null,
  };
}

/**
 * Разбор ответа сервера в человеческий результат.
 *
 * Отдельная функция, потому что «дубликат» — не ошибка: файл уже есть, и это
 * хорошая новость. Сервер отдаёт `409 { error: { code: 'duplicate' }, existing }`,
 * и панель загрузки должна сказать «уже в библиотеке: <название>», а не «сбой».
 */
export type UploadOutcome =
  | { kind: 'uploaded'; id: string; title: string }
  | { kind: 'duplicate'; id: string; title: string }
  | { kind: 'failed'; code: string; message: string };

export function parseUploadResponse(status: number, payload: unknown): UploadOutcome {
  const body = (payload ?? {}) as {
    id?: string;
    title?: string;
    error?: { code?: string; message?: string };
    existing?: { id?: string; title?: string };
  };

  if (status === 200 || status === 201) {
    return {
      kind: 'uploaded',
      id: String(body.id ?? ''),
      title: String(body.title ?? 'Трек'),
    };
  }
  if (status === 409 && body.existing) {
    return {
      kind: 'duplicate',
      id: String(body.existing.id ?? ''),
      title: String(body.existing.title ?? 'этот файл'),
    };
  }
  return {
    kind: 'failed',
    code: String(body.error?.code ?? 'http_error'),
    message: String(body.error?.message ?? `Сервер ответил ${status}`),
  };
}

/** «3 из 5» для очереди загрузки: прогресс по числу файлов, а не по байтам. */
export function progressLabel(done: number, total: number): string {
  if (total <= 0) return '';
  if (done >= total) return `Готово: ${total}`;
  return `${done} из ${total}`;
}

/**
 * Сколько файлов можно отправить сразу. Ограничение не серверное, а телефонное:
 * десять параллельных загрузок на мобильной сети — это десять обрывов, поэтому
 * очередь идёт последовательно, а список ограничен, чтобы не переполнить память.
 */
export const MAX_BATCH = 20;
