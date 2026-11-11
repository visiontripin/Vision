import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Playlist, Stats, Track } from '@vision/shared';
import { api, apiBase, IS_LOCAL_MODE } from '../api';
import { readSnapshot, saveSnapshot } from '../library-cache';

type LibraryValue = {
  tracks: Track[];
  playlists: Playlist[];
  stats: Stats | null;
  loading: boolean;
  error: string | null;
  /**
   * Показана сохранённая копия: сервер недоступен (I5). `null` — связь есть.
   * `saved`/`total` — сколько треков влезло в кэш и сколько было всего.
   */
  offline: { savedAt: number; saved: number; total: number } | null;
  reload: () => Promise<void>;
  patchTrack: (id: string, patch: Partial<Track>) => void;
  dropTrack: (id: string) => void;
  patchPlaylist: (playlist: Playlist) => void;
  dropPlaylist: (id: string) => void;
};

const LibraryContext = createContext<LibraryValue | null>(null);

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState<{ savedAt: number; saved: number; total: number } | null>(null);

  /**
   * Сервер ответил — сохраняем снимок, чтобы следующее открытие без сети было
   * не пустым экраном. В локальном режиме (IndexedDB) кэш не нужен: данные и
   * так на устройстве.
   */
  const remember = useCallback((next: { tracks: Track[]; playlists: Playlist[]; stats: Stats | null }) => {
    if (IS_LOCAL_MODE) return;
    const write = () => saveSnapshot(next, { base: apiBase() });
    // Запись в localStorage — синхронная и на большой библиотеке заметная
    // (5 тысяч треков ≈ 4 МБ JSON). Откладываем на простой, чтобы не
    // задерживать отрисовку уже полученной библиотеки.
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (typeof idle === 'function') idle(write, { timeout: 3000 });
    else setTimeout(write, 0);
  }, []);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [nextTracks, nextPlaylists, nextStats] = await Promise.all([
        api.tracks({ limit: 2000 }),
        api.playlists(),
        api.stats(),
      ]);
      setTracks(nextTracks);
      setPlaylists(nextPlaylists);
      setStats(nextStats);
      setOffline(null);
      remember({ tracks: nextTracks, playlists: nextPlaylists, stats: nextStats });
    } catch (e) {
      // Сеть пропала — показываем последний снимок. Ошибку не прячем: человек
      // должен знать, что видит копию, а не актуальную библиотеку.
      const snapshot = IS_LOCAL_MODE ? null : readSnapshot({ base: apiBase() });
      setError(e instanceof Error ? e.message : 'Не удалось загрузить библиотеку');
      if (snapshot) {
        setTracks(snapshot.tracks as Track[]);
        setPlaylists(snapshot.playlists as Playlist[]);
        setStats((snapshot.stats as Stats | null) ?? null);
        setOffline({ savedAt: snapshot.savedAt, saved: snapshot.tracks.length, total: snapshot.total });
      }
    } finally {
      setLoading(false);
    }
  }, [remember]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const patchTrack = useCallback((id: string, patch: Partial<Track>) => {
    setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const dropTrack = useCallback((id: string) => {
    setTracks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const patchPlaylist = useCallback((playlist: Playlist) => {
    setPlaylists((prev) => prev.map((p) => (p.id === playlist.id ? playlist : p)));
  }, []);

  const dropPlaylist = useCallback((id: string) => {
    setPlaylists((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const value = useMemo(
    () => ({ tracks, playlists, stats, loading, error, offline, reload, patchTrack, dropTrack, patchPlaylist, dropPlaylist }),
    [tracks, playlists, stats, loading, error, offline, reload, patchTrack, dropTrack, patchPlaylist, dropPlaylist]
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryValue {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary must be used inside LibraryProvider');
  return ctx;
}
