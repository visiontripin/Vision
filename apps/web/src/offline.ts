import { useCallback, useSyncExternalStore } from 'react';
import type { Track } from '@vision/shared';

/**
 * Офлайн-копии треков в Cache Storage.
 *
 * Зачем: домашний сервер живёт за Wi-Fi/Tailscale, а телефон — не всегда. Явно
 * скачанные треки играют из кэша браузера без сети (и не тратят трафик в LTE).
 *
 * Устройство простое:
 *  - аудио лежит в Cache Storage под синтетическим ключом `/__vision-offline/<id>`
 *    (подписанные ссылки живут 30 минут, поэтому запоминать их бессмысленно);
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
  title: string;
  artist: string;
  bytes: number;
  at: number;
};

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
let idCache = new Set<string>();

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
    idCache = new Set(parsedCache.map((entry) => entry.id));
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

export function isOfflineCached(id: string | null | undefined): boolean {
  if (!id) return false;
  offlineEntries(); // прогревает idCache
  return idCache.has(id);
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

  const blob = new Blob(chunks as BlobPart[], { type });
  await cache.put(
    cacheKey(track.id),
    new Response(blob, {
      headers: { 'Content-Type': type, 'Content-Length': String(blob.size) },
    })
  );

  const entry: OfflineEntry = {
    id: track.id,
    title: track.title,
    artist: track.artist,
    bytes: blob.size,
    at: Date.now(),
  };

  const limitBytes = (options.limitMb ?? offlineLimitMb()) * 1024 * 1024;
  const existing = offlineEntries().filter((item) => item.id !== track.id);
  const evict = pickEvictions(existing, entry.bytes, limitBytes, track.id);
  for (const id of evict) await removeOffline(id);

  // вытесненные уже удалены из кэша и индекса — в новый индекс их не возвращаем
  const kept = existing.filter((item) => !evict.includes(item.id));
  writeIndex([entry, ...kept]);
  return entry;
}

export async function removeOffline(id: string): Promise<void> {
  const cache = await openCache();
  if (cache) await cache.delete(cacheKey(id)).catch(() => {});
  revokeOfflineUrl(id);
  writeIndex(offlineEntries().filter((entry) => entry.id !== id));
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

/** Object URL офлайн-копии (или null). Ссылки кэшируются и переиспользуются. */
export async function offlinePlayableUrl(id: string | null | undefined): Promise<string | null> {
  if (!id || !isOfflineCached(id)) return null;
  const known = blobUrls.get(id);
  if (known) return known;

  const cache = await openCache();
  if (!cache) return null;
  const response = await cache.match(cacheKey(id)).catch(() => undefined);
  if (!response) {
    // индекс и кэш разъехались (например, чистили Storage) — приводим в порядок
    writeIndex(offlineEntries().filter((entry) => entry.id !== id));
    return null;
  }

  const url = URL.createObjectURL(await response.blob());
  blobUrls.set(id, url);
  while (blobUrls.size > MAX_BLOB_URLS) {
    const [oldestId, oldestUrl] = blobUrls.entries().next().value ?? [];
    if (!oldestId || !oldestUrl) break;
    URL.revokeObjectURL(oldestUrl);
    blobUrls.delete(oldestId);
  }
  return url;
}

export function revokeOfflineUrl(id: string) {
  const url = blobUrls.get(id);
  if (!url) return;
  URL.revokeObjectURL(url);
  blobUrls.delete(id);
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
