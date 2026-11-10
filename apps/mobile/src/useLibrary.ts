import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Playlist, Track } from '@vision/shared';
import { api } from './api';

/** Данные библиотеки для мобильного экрана: треки, плейлисты, поиск. */
export function useLibrary() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [trackList, playlistList] = await Promise.all([
        api.tracks({ limit: 500 }),
        api.playlists().catch(() => [] as Playlist[]),
      ]);
      setTracks(Array.isArray(trackList) ? trackList : []);
      setPlaylists(Array.isArray(playlistList) ? playlistList : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить библиотеку');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { tracks, playlists, loading, error, reload };
}

/** Клиентский поиск: серверу не нужен запрос на каждую букву. */
export function filterTracks(tracks: Track[], query: string): Track[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return tracks;
  return tracks.filter((track) =>
    [track.title, track.artist, track.album ?? '', track.genre ?? '']
      .join(' ')
      .toLowerCase()
      .includes(needle)
  );
}

/** Суммарное время списка — для шапки плейлиста. */
export function useTotalDuration(tracks: Track[]): number {
  return useMemo(() => tracks.reduce((sum, track) => sum + (track.duration || 0), 0), [tracks]);
}
