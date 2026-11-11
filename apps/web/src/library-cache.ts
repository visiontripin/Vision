/**
 * Локальный кэш библиотеки (I5): библиотека открывается без сервера.
 *
 * Зачем отдельный слой, если уже есть Cache Storage для звука и Service Worker
 * для оболочки: они дают **треки**, но не **список**. Без сети страница
 * открывалась, показывала «Не удалось загрузить библиотеку» и пустой экран —
 * при том что все файлы уже лежали на диске. Здесь список, плейлисты и
 * статистика сохраняются в localStorage снимком, а при ошибке сети читаются
 * обратно.
 *
 * Решения, которые важнее кода:
 *  - **только чтение**: в офлайне правки (лайк, переименование) не копятся в
 *    очередь — сервер о них не узнает, и «потом синхронизируем» врёт человеку.
 *    Интерфейс показывает «офлайн-копия», а кнопки правок остаются как есть;
 *  - **снимок, а не событийный лог**: библиотека личная и маленькая, а слияние
 *    правок без сервера — источник конфликтов;
 *  - **битый снимок = отсутствие снимка**: исключение из разбора не должно
 *    превращать «нет кэша» в «приложение упало»;
 *  - **чужой сервер не читает чужой кэш**: снимок подписан адресом API, иначе
 *    после переключения на другой сервер мы показали бы его треки.
 */

export const CACHE_KEY = 'vision.library.snapshot';
/** Без сети снимок живёт сколько угодно; ограничение — только размер и адрес API. */
export const CACHE_VERSION = 1;

export type LibrarySnapshot = {
  version: number;
  /** Адрес API, с которого снят снимок: `''` — тот же origin. */
  base: string;
  savedAt: number;
  tracks: unknown[];
  playlists: unknown[];
  stats: unknown | null;
  /**
   * Сколько треков было в библиотеке на момент снимка. Больше, чем
   * `tracks.length`, — значит в кэш влезла только часть (упирались в квоту
   * localStorage), и интерфейс обязан это сказать.
   */
  total: number;
};

export type SnapshotInput = {
  tracks: unknown[];
  playlists: unknown[];
  stats: unknown | null;
};

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function safeStore(store?: Store | null): Store | null {
  if (store) return store;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Сохраняет снимок. Возвращает `true`, если запись удалась.
 *
 * localStorage даёт ~5 МБ на origin, а трек с волной занимает ~1.9 КБ — на
 * 2000 треках снимок ещё влезает, на 5000 уже нет. Вместо «нет кэша вообще»
 * сохраняем **часть** библиотеки: офлайн-список из 2 тысяч песен полезнее
 * пустого экрана, если интерфейс честно говорит, что список неполный.
 */
export function saveSnapshot(
  input: SnapshotInput,
  { base = '', now = Date.now(), store }: { base?: string; now?: number; store?: Store | null } = {}
): boolean {
  const target = safeStore(store);
  if (!target) return false;
  const tracks = Array.isArray(input.tracks) ? input.tracks : [];
  const make = (slice: unknown[]): LibrarySnapshot => ({
    version: CACHE_VERSION,
    base,
    savedAt: now,
    tracks: slice,
    playlists: Array.isArray(input.playlists) ? input.playlists : [],
    stats: input.stats ?? null,
    total: tracks.length,
  });

  try {
    target.setItem(CACHE_KEY, JSON.stringify(make(tracks)));
    return true;
  } catch {
    /* упираемся в квоту — ниже подбираем, сколько треков влезает */
  }

  // Спускаемся по 70%, пока запись не пройдёт (обычно 1–3 попытки), затем
  // уточняем двоичным поиском в узком интервале: сериализация 5000 треков по
  // 4 МБ — это ~200 мс на попытку, полный бинпоиск стоил бы секунду.
  let fits = 0;
  let tooMuch = tracks.length;
  let count = Math.floor(tracks.length * 0.7);
  let saved: unknown[] | null = null;
  for (let attempt = 0; attempt < 8 && count >= 0; attempt += 1) {
    try {
      target.setItem(CACHE_KEY, JSON.stringify(make(tracks.slice(0, count))));
      saved = tracks.slice(0, count);
      fits = count;
      break;
    } catch {
      tooMuch = count;
      count = Math.floor(count * 0.7);
    }
  }
  if (!saved) return false;

  while (fits + 1 < tooMuch) {
    const middle = Math.floor((fits + tooMuch) / 2);
    try {
      target.setItem(CACHE_KEY, JSON.stringify(make(tracks.slice(0, middle))));
      saved = tracks.slice(0, middle);
      fits = middle;
    } catch {
      tooMuch = middle;
    }
  }
  return true;
}

/** Читает снимок. `null` — нет, битый, другая версия формата или другой сервер. */
export function readSnapshot(
  { base = '', now = Date.now() }: { base?: string; now?: number } = {},
  store?: Store | null
): LibrarySnapshot | null {
  const target = safeStore(store);
  if (!target) return null;
  let raw: string | null = null;
  try {
    raw = target.getItem(CACHE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: Partial<LibrarySnapshot>;
  try {
    parsed = JSON.parse(raw) as Partial<LibrarySnapshot>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.version !== CACHE_VERSION) return null;
  if (String(parsed.base ?? '') !== String(base ?? '')) return null;
  if (!Array.isArray(parsed.tracks)) return null;
  if (typeof parsed.savedAt !== 'number' || !Number.isFinite(parsed.savedAt)) return null;
  // часы могли перевести назад: снимок «из будущего» считаем нормальным, но
  // отрицательный возраст показывать нельзя
  const savedAt = Math.min(parsed.savedAt, now);

  return {
    version: CACHE_VERSION,
    base: String(parsed.base ?? ''),
    savedAt,
    tracks: parsed.tracks,
    playlists: Array.isArray(parsed.playlists) ? parsed.playlists : [],
    stats: parsed.stats ?? null,
    // старые снимки без поля `total`: считаем, что влезло всё
    total: Math.max(parsed.tracks.length, Number(parsed.total) || 0),
  };
}

export function clearSnapshot(store?: Store | null): void {
  const target = safeStore(store);
  if (!target) return;
  try {
    target.removeItem(CACHE_KEY);
  } catch {
    /* noop */
  }
}

/**
 * «Сохранено 2 часа назад». Отдельной функцией, потому что строка нужна и в
 * баннере, и в настройках, и в тестах — дублировать склонения не хочется.
 */
export function snapshotAge(savedAt: number, now = Date.now()): string {
  if (!Number.isFinite(savedAt) || savedAt <= 0) return 'неизвестно когда';
  const seconds = Math.max(0, Math.round((now - savedAt) / 1000));
  if (seconds < 60) return 'только что';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`;
  const days = Math.round(hours / 24);
  return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
}

function plural(value: number, one: string, few: string, many: string): string {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** Текст баннера об офлайн-режиме: одна строка, без технических деталей. */
export function offlineBannerText(
  savedAt: number | null,
  now = Date.now(),
  { saved, total }: { saved?: number; total?: number } = {}
): string {
  if (savedAt === null) {
    return 'Нет связи с сервером, а сохранённой копии библиотеки нет. Проверьте, что сервер запущен.';
  }
  const partial = Number(saved) > 0 && Number(total) > Number(saved);
  const scope = partial ? ` — сохранены первые ${saved} из ${total} треков` : '';
  return `Нет связи с сервером — показана сохранённая библиотека (${snapshotAge(savedAt, now)})${scope}. Новые треки появятся после подключения.`;
}
