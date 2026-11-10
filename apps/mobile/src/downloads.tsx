import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import type { Track } from '@vision/shared';
import { downloadFileName } from './lib/format';
import { announceReplica, withdrawReplica } from './lib/seeds';

/**
 * Скачанные треки: файл лежит в приватном каталоге приложения, запись о нём —
 * в AsyncStorage. Плеер сначала смотрит сюда, поэтому в самолёте всё играет.
 *
 * Это же хранилище позже станет «сидом» Фазы 3.5: файл уже на устройстве,
 * останется научить приложение отдавать его другим (см. docs/MOBILE.md).
 */

export type DownloadEntry = {
  id: string;
  /** sha256 файла — адрес блоба в реестре реплик */
  hash?: string;
  title: string;
  artist: string;
  uri: string;
  bytes: number;
  mime: string;
  at: number;
};

type DownloadsValue = {
  ready: boolean;
  entries: Record<string, DownloadEntry>;
  progress: Record<string, number>;
  totalBytes: number;
  count: number;
  error: string | null;
  localUri: (id: string) => string | null;
  has: (id: string) => boolean;
  download: (track: Track, url: string, mime?: string) => Promise<void>;
  downloadMany: (
    items: { track: Track; url: string; mime?: string }[],
    onStep?: (done: number, total: number) => void
  ) => Promise<number>;
  remove: (id: string) => Promise<void>;
  clear: () => Promise<void>;
};

const STORAGE_KEY = 'vision.downloads';
const DIR = `${FileSystem.documentDirectory ?? ''}vision/`;

const DownloadsContext = createContext<DownloadsValue | null>(null);

async function ensureDir() {
  const info = await FileSystem.getInfoAsync(DIR).catch(() => null);
  if (!info?.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
}

function parseIndex(raw: string | null): Record<string, DownloadEntry> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const result: Record<string, DownloadEntry> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, Partial<DownloadEntry>>)) {
      if (!value || typeof value.uri !== 'string') continue;
      result[id] = {
        id,
        hash: typeof value.hash === 'string' ? value.hash : undefined,
        title: String(value.title ?? ''),
        artist: String(value.artist ?? ''),
        uri: value.uri,
        bytes: Math.max(0, Number(value.bytes) || 0),
        mime: String(value.mime ?? 'audio/mpeg'),
        at: Number(value.at) || 0,
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Record<string, DownloadEntry>>({});
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const persist = useCallback(async (next: Record<string, DownloadEntry>) => {
    setEntries(next);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* noop */
    }
  }, []);

  /* восстанавливаем индекс и выкидываем записи, чьи файлы пропали (чистка Storage) */
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        const stored = parseIndex(raw);
        const alive: Record<string, DownloadEntry> = {};
        for (const [id, entry] of Object.entries(stored)) {
          const info = await FileSystem.getInfoAsync(entry.uri);
          if (info.exists) alive[id] = entry;
        }
        setEntries(alive);
        if (Object.keys(alive).length !== Object.keys(stored).length) {
          await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(alive));
        }
      } catch {
        /* первый запуск или нет доступа к файлам */
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const download = useCallback(
    async (track: Track, url: string, mime?: string) => {
      if (!url) throw new Error('Нет ссылки на файл');
      if (entriesRef.current[track.id]) return;

      setError(null);
      setProgress((prev) => ({ ...prev, [track.id]: 0 }));
      try {
        await ensureDir();
        const contentType = mime ?? track.mime;
        const destination = `${DIR}${downloadFileName(track.id, contentType)}`;

        const task = FileSystem.createDownloadResumable(url, destination, {}, (snapshot) => {
          const total = snapshot.totalBytesExpectedToWrite || 0;
          const ratio = total > 0 ? Math.min(1, snapshot.totalBytesWritten / total) : 0;
          setProgress((prev) => ({ ...prev, [track.id]: ratio }));
        });

        const result = await task.downloadAsync();
        if (!result?.uri) throw new Error('Загрузка не завершилась');

        const info = await FileSystem.getInfoAsync(result.uri);
        const bytes = info.exists && !info.isDirectory ? info.size ?? 0 : 0;

        const entry: DownloadEntry = {
          id: track.id,
          hash: track.checksum ?? undefined,
          title: track.title,
          artist: track.artist,
          uri: result.uri,
          bytes,
          mime: contentType,
          at: Date.now(),
        };
        await persist({ ...entriesRef.current, [track.id]: entry });
        void announceReplica(track); // «копия есть у телефона» — best effort
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Не удалось скачать трек');
        throw cause;
      } finally {
        setProgress((prev) => {
          const next = { ...prev };
          delete next[track.id];
          return next;
        });
      }
    },
    [persist]
  );

  const downloadMany = useCallback(
    async (items: { track: Track; url: string; mime?: string }[], onStep?: (done: number, total: number) => void) => {
      let done = 0;
      for (const item of items) {
        try {
          await download(item.track, item.url, item.mime);
          done += 1;
        } catch {
          /* один сбойный трек не должен останавливать плейлист */
        }
        onStep?.(done, items.length);
      }
      return done;
    },
    [download]
  );

  const remove = useCallback(
    async (id: string) => {
      const entry = entriesRef.current[id];
      if (entry) await FileSystem.deleteAsync(entry.uri, { idempotent: true }).catch(() => {});
      const next = { ...entriesRef.current };
      delete next[id];
      await persist(next);
      void withdrawReplica(entry?.hash);
    },
    [persist]
  );

  const clear = useCallback(async () => {
    const removed = Object.values(entriesRef.current);
    await Promise.all(removed.map((entry) => FileSystem.deleteAsync(entry.uri, { idempotent: true }).catch(() => {})));
    await persist({});
    for (const entry of removed) void withdrawReplica(entry.hash);
  }, [persist]);

  const value = useMemo<DownloadsValue>(() => {
    const totalBytes = Object.values(entries).reduce((sum, entry) => sum + entry.bytes, 0);
    return {
      ready,
      entries,
      progress,
      totalBytes,
      count: Object.keys(entries).length,
      error,
      localUri: (id: string) => entries[id]?.uri ?? null,
      has: (id: string) => Boolean(entries[id]),
      download,
      downloadMany,
      remove,
      clear,
    };
  }, [entries, progress, ready, error, download, downloadMany, remove, clear]);

  return <DownloadsContext.Provider value={value}>{children}</DownloadsContext.Provider>;
}

export function useDownloads(): DownloadsValue {
  const value = useContext(DownloadsContext);
  if (!value) throw new Error('useDownloads вне DownloadsProvider');
  return value;
}
