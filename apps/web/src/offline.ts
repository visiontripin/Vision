import { useCallback, useSyncExternalStore } from 'react';
import type { Track } from '@vision/shared';

/**
 * Офлайн-копии треков в Cache Storage.
 *
 * Зачем: домашний сервер живёт за Wi-Fi/Tailscale, а телефон — не всегда. Явно
 * скачанные треки играют из кэша браузера без сети (и не тратят трафик в LTE).
 *
 * Устройство простое:
 *  - аудио лежит в Cache Storage под синтетическим ключом
 *    `/__vision-offline/<checksum>` — адресация контентная, как у трекера реплик:
 *    один и тот же файл, импортированный заново или пришедший с другого узла
 *    (другой `id`), не качается второй раз. Если `checksum` неизвестен (старые
 *    треки), ключом остаётся `id` (подписанные ссылки живут 30 минут, поэтому
 *    запоминать их бессмысленно);
 *  - список копий и их размеры — в localStorage (маленький, синхронный);
 *  - при переполнении лимита удаляются самые старые копии (LRU по `at`).
 *
 * Работает только в защищённом контексте (HTTPS или localhost): на `http://192.168.*`
 * браузер не даёт Cache Storage, и интерфейс просто не показывает эти кнопки.
 */

export const MEDIA_CACHE = 'vision-media-v1';
export const KEY_PREFIX = '/__vision-offline/';
const INDEX_KEY = 'vision.offline.index';
const LIMIT_KEY = 'vision.offline.limitMb';
export const DEFAULT_LIMIT_MB = 512;

export type OfflineEntry = {
  id: string;
  /** sha256 содержимого: настоящий ключ копии. Пустой у треков до трекера. */
  hash: string;
  title: string;
  artist: string;
  bytes: number;
  at: number;
};

/**
 * Ключ копии: содержимое, а не строка трека. Трекер адресует файлы по sha256,
 * поэтому копия, скачанная под одним `id`, находится и после повторного импорта
 * того же файла под другим `id`.
 */
export function offlineRef(track: Pick<Track, 'id' | 'checksum'> | null | undefined): string {
  if (!track) return '';
  return String(track.checksum ?? '').trim() || track.id;
}

/** Все ключи, под которыми может лежать копия трека: sha256 и (для старых) id. */
function refKeys(track: Pick<Track, 'id' | 'checksum'> | null | undefined): string[] {
  if (!track) return [];
  const keys: string[] = [];
  const hash = String(track.checksum ?? '').trim();
  if (hash) keys.push(hash);
  if (track.id && !keys.includes(track.id)) keys.push(track.id);
  return keys;
}

/** Есть ли копия этого трека (учитывает записи, адресованные по `id`). */
export function isTrackCached(track: Pick<Track, 'id' | 'checksum'> | null | undefined): boolean {
  return refKeys(track).some((key) => isOfflineCached(key));
}

/** Object URL копии этого трека (или null) — с учётом старых ключей по `id`. */
export async function offlinePlayable(
  track: Pick<Track, 'id' | 'checksum'> | null | undefined
): Promise<string | null> {
  for (const key of refKeys(track)) {
    const url = await offlinePlayableUrl(key);
    if (url) return url;
  }
  return null;
}

/** Удалить копию этого трека, каким бы ключом она ни была записана. */
export async function removeTrackCopy(
  track: Pick<Track, 'id' | 'checksum'> | null | undefined
): Promise<void> {
  const keys = refKeys(track);
  if (!keys.length) return;
  for (const key of keys) await removeOffline(key);
}

export function offlineSupported(): boolean {
  return typeof window !== 'undefined' && typeof caches !== 'undefined' && 'CacheStorage' in window;
}

/* ------------------------------- индекс ---------------------------------- */

function safeParse(raw: string | null): OfflineEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is OfflineEntry => Boolean(item && typeof item === 'object'))
      .map((item) => ({
        id: String((item as OfflineEntry).id || ''),
        hash: String((item as OfflineEntry).hash || ''),
        title: String((item as OfflineEntry).title || ''),
        artist: String((item as OfflineEntry).artist || ''),
        bytes: Math.max(0, Number((item as OfflineEntry).bytes) || 0),
        at: Number((item as OfflineEntry).at) || 0,
      }))
      .filter((item) => item.id);
  } catch {
    return [];
  }
}

// Индекс читают все строки списка, поэтому разбор JSON кэшируется по «сырой» строке.
let rawCache: string | null | undefined;
let parsedCache: OfflineEntry[] = [];
/** id и sha256 → запись: искать копию можно любым из двух ключей. */
let refCache = new Map<string, OfflineEntry>();

/** Ключ записи в Cache Storage: sha256, если он известен, иначе id трека. */
function entryKey(entry: OfflineEntry): string {
  return entry.hash || entry.id;
}

export function offlineEntries(): OfflineEntry[] {
  if (typeof localStorage === 'undefined') return [];
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(INDEX_KEY);
  } catch {
    return [];
  }
  if (raw !== rawCache) {
    rawCache = raw;
    parsedCache = safeParse(raw).sort((a, b) => b.at - a.at);
    refCache = new Map();
    for (const entry of parsedCache) {
      if (entry.id) refCache.set(entry.id, entry);
      if (entry.hash) refCache.set(entry.hash, entry);
    }
  }
  return parsedCache;
}

export function offlineTotalBytes(entries: OfflineEntry[] = offlineEntries()): number {
  return entries.reduce((sum, entry) => sum + entry.bytes, 0);
}

function writeIndex(entries: OfflineEntry[]) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(entries));
  } catch {
    /* приватный режим или переполнение localStorage — кэш всё равно в Cache Storage */
  }
  notify();
}

export function offlineLimitMb(): number {
  try {
    const raw = Number(localStorage.getItem(LIMIT_KEY));
    if (Number.isFinite(raw) && raw > 0) return raw;
  } catch {
    /* noop */
  }
  return DEFAULT_LIMIT_MB;
}

export function setOfflineLimitMb(mb: number) {
  const value = Math.max(32, Math.min(8192, Math.round(mb)));
  try {
    localStorage.setItem(LIMIT_KEY, String(value));
  } catch {
    /* noop */
  }
  notify();
}

export function isOfflineCached(ref: string | null | undefined): boolean {
  if (!ref) return false;
  offlineEntries(); // прогревает refCache
  return refCache.has(ref);
}

/**
 * Какие копии нужно удалить, чтобы после добавления `incomingBytes` влезть в лимит.
 * Чистая функция — её удобно тестировать без браузера.
 */
export function pickEvictions(
  entries: OfflineEntry[],
  incomingBytes: number,
  limitBytes: number,
  keepId?: string
): string[] {
  const budget = Math.max(0, limitBytes);
  const others = entries
    .filter((entry) => entry.id !== keepId)
    .sort((a, b) => a.at - b.at); // сначала самые старые

  let total = offlineTotalBytes(others) + Math.max(0, incomingBytes);
  const evicted: string[] = [];
  for (const entry of others) {
    if (total <= budget) break;
    total -= entry.bytes;
    evicted.push(entry.id);
  }
  return evicted;
}

/* ------------------------------- кэш ------------------------------------- */

const cacheKey = (id: string) => `${KEY_PREFIX}${id}`;

async function openCache(): Promise<Cache | null> {
  if (!offlineSupported()) return null;
  try {
    return await caches.open(MEDIA_CACHE);
  } catch {
    return null;
  }
}

export type CacheProgress = (ratio: number | null, loadedBytes: number) => void;

/** Скачивает трек целиком и кладёт офлайн-копию в Cache Storage. */
export async function cacheTrack(
  track: Track,
  url: string,
  options: { signal?: AbortSignal; onProgress?: CacheProgress; limitMb?: number } = {}
): Promise<OfflineEntry> {
  const cache = await openCache();
  if (!cache) throw new Error('Офлайн-копии не поддерживаются этим браузером (нужен HTTPS или localhost).');

  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) throw new Error(`Сервер ответил ${response.status}`);

  const total = Number(response.headers.get('content-length') || 0);
  const type = response.headers.get('content-type') || 'audio/mpeg';

  // читаем потоком: так работает отмена и прогресс
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.length;
        options.onProgress?.(total ? Math.min(1, loaded / total) : null, loaded);
      }
    }
  } else {
    const buffer = new Uint8Array(await response.arrayBuffer());
    chunks.push(buffer);
    loaded = buffer.byteLength;
  }

  const hash = String(track.checksum ?? '').trim();
  const entry: OfflineEntry = {
    id: track.id,
    hash,
    title: track.title,
    artist: track.artist,
    bytes: 0,
    at: Date.now(),
  };

  const blob = new Blob(chunks as BlobPart[], { type });
  entry.bytes = blob.size;
  await cache.put(
    cacheKey(entryKey(entry)),
    new Response(blob, {
      headers: { 'Content-Type': type, 'Content-Length': String(blob.size) },
    })
  );

  // копия могла быть скачана раньше под ключом-`id`: старый ключ больше не нужен
  const previous = refCache.get(track.id);
  if (previous && entryKey(previous) !== entryKey(entry)) {
    await cache.delete(cacheKey(entryKey(previous))).catch(() => {});
    revokeOfflineUrl(entryKey(previous));
  }

  const limitBytes = (options.limitMb ?? offlineLimitMb()) * 1024 * 1024;
  // тот же файл мог быть скачан под другим id — вторую копию не держим
  const existing = offlineEntries().filter(
    (item) => item.id !== track.id && (!hash || item.hash !== hash)
  );
  const evict = pickEvictions(existing, entry.bytes, limitBytes, track.id);
  for (const id of evict) await removeOffline(id);

  // вытесненные уже удалены из кэша и индекса — в новый индекс их не возвращаем
  const kept = existing.filter((item) => !evict.includes(item.id));
  writeIndex([entry, ...kept]);
  return entry;
}

/**
 * Удалить копию. `ref` — sha256 содержимого или id трека: копия одна и та же,
 * поэтому найти её можно любым ключом.
 */
export async function removeOffline(ref: string): Promise<void> {
  const entry = refCache.get(ref);
  const key = entry ? entryKey(entry) : ref;
  const cache = await openCache();
  if (cache) await cache.delete(cacheKey(key)).catch(() => {});
  revokeOfflineUrl(ref);
  writeIndex(
    offlineEntries().filter((item) => item.id !== key && item.hash !== key && entryKey(item) !== key)
  );
}

export async function clearOffline(): Promise<void> {
  const cache = await openCache();
  if (cache) {
    const keys = await cache.keys().catch(() => [] as Request[]);
    await Promise.all(keys.map((request) => cache.delete(request).catch(() => false)));
  }
  blobUrls.forEach((url) => URL.revokeObjectURL(url));
  blobUrls.clear();
  writeIndex([]);
}

/* ---------------------------- воспроизведение ---------------------------- */

const blobUrls = new Map<string, string>();
const MAX_BLOB_URLS = 3;

/**
 * Object URL офлайн-копии (или null). `ref` — sha256 или id трека.
 * Ссылки кэшируются и переиспользуются.
 */
export async function offlinePlayableUrl(ref: string | null | undefined): Promise<string | null> {
  if (!ref) return null;
  offlineEntries(); // прогревает refCache
  const entry = refCache.get(ref);
  const key = entry ? entryKey(entry) : '';
  if (!entry) return null;

  const known = blobUrls.get(key);
  if (known) return known;

  const cache = await openCache();
  if (!cache) return null;
  const response = await cache.match(cacheKey(key)).catch(() => undefined);
  if (!response) {
    // индекс и кэш разъехались (например, чистили Storage) — приводим в порядок
    writeIndex(offlineEntries().filter((item) => entryKey(item) !== key));
    return null;
  }

  const url = URL.createObjectURL(await response.blob());
  blobUrls.set(key, url);
  while (blobUrls.size > MAX_BLOB_URLS) {
    const [oldestId, oldestUrl] = blobUrls.entries().next().value ?? [];
    if (!oldestId || !oldestUrl) break;
    URL.revokeObjectURL(oldestUrl);
    blobUrls.delete(oldestId);
  }
  return url;
}

export function revokeOfflineUrl(ref: string) {
  offlineEntries(); // прогревает refCache
  const entry = refCache.get(ref);
  for (const key of new Set([entry ? entryKey(entry) : ref, ref])) {
    const url = blobUrls.get(key);
    if (!url) continue;
    URL.revokeObjectURL(url);
    blobUrls.delete(key);
  }
}

/* ------------------------------ подписка --------------------------------- */

let version = 0;
const listeners = new Set<() => void>();

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeOffline(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Срез состояния офлайн-кэша для компонентов. */
export function useOffline(): { supported: boolean; entries: OfflineEntry[]; bytes: number; limitMb: number } {
  const subscribe = useCallback((listener: () => void) => subscribeOffline(listener), []);
  const snapshot = useCallback(
    () => (offlineSupported() ? `${version}:${offlineEntries().length}:${offlineTotalBytes()}` : 'off'),
    []
  );
  useSyncExternalStore(subscribe, snapshot, snapshot);

  const entries = offlineSupported() ? offlineEntries() : [];
  return { supported: offlineSupported(), entries, bytes: offlineTotalBytes(entries), limitMb: offlineLimitMb() };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 МБ';
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} МБ`;
  return `${(mb / 1024).toFixed(1)} ГБ`;
}
