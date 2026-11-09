import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Playlist, Stats, Track } from '@vision/shared';
import { api } from '../api';

type LibraryValue = {
  tracks: Track[];
  playlists: Playlist[];
  stats: Stats | null;
  loading: boolean;
  error: string | null;
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить библиотеку');
    } finally {
      setLoading(false);
    }
  }, []);

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
    () => ({ tracks, playlists, stats, loading, error, reload, patchTrack, dropTrack, patchPlaylist, dropPlaylist }),
    [tracks, playlists, stats, loading, error, reload, patchTrack, dropTrack, patchPlaylist, dropPlaylist]
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryValue {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary must be used inside LibraryProvider');
  return ctx;
}
