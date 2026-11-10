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
  return entry && entry.stream ? { stream: entry.stream, cover: entry.cover, expiresAt: entry.expiresAt } : null;
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
        cache.set(id, { ...item, staleAt: Date.now() + Math.max(0, lifetime - SAFETY_MARGIN_MS) });
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
