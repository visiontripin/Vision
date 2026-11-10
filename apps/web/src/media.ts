import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { MediaItem } from '@vision/shared';
import { api } from './api';

/**
 * Кэш подписанных медиа-ссылок.
 *
 * Ссылки на поток и обложку живут ~30 минут, поэтому их нельзя хранить в
 * состоянии трека — их нужно перезапрашивать. Здесь один кэш на приложение,
 * дедупликация параллельных запросов и подписка компонентов на обновления.
 */

const SAFETY_MARGIN_MS = 60_000;

/** Какой кодек браузер реально умеет играть. Считаем один раз. */
function pickStream(
  streams: Record<string, string> | undefined,
  fallback: string,
  hls?: string | null
): string {
  try {
    const audio = document.createElement('audio');
    // Safari играет HLS нативно — там это лучший вариант (сегменты по 6 с)
    if (hls && audio.canPlayType('application/vnd.apple.mpegurl')) return hls;

    if (streams) {
      const opus = audio.canPlayType('audio/ogg; codecs=opus');
      const aac = audio.canPlayType('audio/mp4; codecs="mp4a.40.2"') || audio.canPlayType('audio/aac');
      if (streams.opus && opus) return streams.opus;
      if (streams.aac && aac) return streams.aac;
      if (streams.original) return streams.original;
    }
  } catch {
    /* SSR или экзотический браузер */
  }
  return fallback;
}

type Entry = MediaItem & { staleAt: number };

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();

let version = 0;
let batch: { key: string; promise: Promise<void> } | null = null;

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

const isFresh = (entry: Entry | undefined) => Boolean(entry && entry.staleAt > Date.now());

export function getMedia(id: string | null | undefined): MediaItem | null {
  if (!id) return null;
  const entry = cache.get(id);
  if (!entry || !entry.stream) return null;
  return {
    stream: entry.stream,
    streams: entry.streams,
    hls: entry.hls ?? null,
    cover: entry.cover,
    expiresAt: entry.expiresAt,
  };
}

/**
 * Ссылка на сам файл (не HLS-плейлист) — для офлайн-копии.
 * HLS не годится: это набор сегментов, а не один файл.
 */
export function getDownloadUrl(id: string | null | undefined): string | null {
  if (!id) return null;
  const entry = cache.get(id);
  if (!entry) return null;
  return entry.streams?.original ?? entry.streams?.opus ?? entry.streams?.aac ?? null;
}

/** Гарантирует актуальные ссылки для перечисленных треков. */
export async function ensureMedia(ids: string[]): Promise<void> {
  const missing = Array.from(new Set(ids.filter((id) => id && !isFresh(cache.get(id))))).sort();
  if (!missing.length) return;

  const key = missing.join(',');
  if (batch?.key === key) return batch.promise;

  const promise = (async () => {
    try {
      const payload = await api.media(missing);
      const lifetime = Number(payload.ttlMs) || 30 * 60 * 1000;
      let updated = false;
      for (const [id, item] of Object.entries(payload.items)) {
        cache.set(id, {
          ...item,
          stream: pickStream(item.streams, item.stream, item.hls),
          staleAt: Date.now() + Math.max(0, lifetime - SAFETY_MARGIN_MS),
        });
        updated = true;
      }
      if (updated) notify();
    } catch {
      /* оффлайн или 401: оставляем старое значение, следующий вызов повторит */
    }
  })();

  batch = { key, promise };
  try {
    await promise;
  } finally {
    if (batch?.key === key) batch = null;
  }
}

export function invalidateMedia(id?: string) {
  if (id) cache.delete(id);
  else cache.clear();
  notify();
}

/** Подписка на ссылки одного трека; сама запрашивает их при необходимости. */
export function useMedia(id: string | null | undefined): MediaItem | null {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);

  const snapshot = useCallback(() => {
    const entry = id ? cache.get(id) : undefined;
    return entry ? `${version}:${entry.stream}:${entry.cover ?? ''}` : '';
  }, [id]);

  useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (id) void ensureMedia([id]);
  }, [id]);

  return getMedia(id);
}
