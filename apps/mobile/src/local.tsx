import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import { Audio } from 'expo-av';
import type { Playlist, Track } from '@vision/shared';
import {
  EMPTY_LIBRARY,
  EMPTY_STATS,
  createPlaylist as addPlaylist,
  addToPlaylist as pushTrack,
  listTracks,
  localUriOf,
  prunePlaylists,
  recordPlay,
  registerFile,
  removeFile,
  removeFromPlaylist,
  topTracks,
  tracksOfPlaylist,
  totalBytes,
  upsertMeta,
  type LocalLibrary,
  type LocalMeta,
  type LocalPlaylist,
  type LocalStats,
} from './lib/local';
import * as FileSystem from 'expo-file-system/legacy';
import { guessMeta, mimeForFile } from './lib/upload';

/** Откуда берём файл по ссылке: папка приложения, чтобы не зависеть от чужого доступа. */
const DOWNLOAD_DIR = `${FileSystem.documentDirectory ?? ''}vision/link/`;

/** Расширение → mime для локальных файлов; неизвестное расширение — по сигнатуре. */
function mimeOf(name: string): string {
  return mimeForFile({ uri: name, name, mimeType: null });
}


/**
 * Библиотека на устройстве: файлы, которые лежат на телефоне.
 *
 * Раньше единственным источником музыки был домашний сервер, и без него
 * приложение показывало только экран «введите адрес». Теперь источник по
 * умолчанию — сам телефон: импорт файла и воспроизведение не требуют ни сети,
 * ни сервера, ни пароля.
 *
 * Хранение разделено по смыслу, чтобы падение одного не ломало остальное:
 * - `vision.local.files` — где лежит файл (перепроверяется при запуске: файл
 *   могли удалить другим приложением);
 * - `vision.local.meta` — названия и артисты (переживают удаление файла);
 * - `vision.local.playlists`, `vision.local.stats` — независимые срезы.
 */

const KEYS = {
  files: 'vision.local.files',
  meta: 'vision.local.meta',
  playlists: 'vision.local.playlists',
  stats: 'vision.local.stats',
} as const;

/** Сколько файлов импортировать за один выбор: больше — телефон «задумывается». */
const MAX_IMPORT = 2000;

export type ImportResult = { added: number; skipped: number; total: number; error?: string };

type LocalLibraryValue = {
  ready: boolean;
  tracks: Track[];
  playlists: Playlist[];
  /** размер локальной библиотеки в байтах — для экрана статистики */
  bytes: number;
  stats: { played: number; top: { trackId: string; title: string; plays: number }[]; weekSeconds: number };
  /** размер одного файла: нужен синхронизации, чтобы отдать метаданные без чтения файла */
  bytesOf: (id: string) => number;
  /** обложка локального трека (сейчас всегда null: теги не читаем) */
  coverOf: (id: string) => string | null;
  /** локальный файл трека — плеер берёт его первым делом */
  uriOf: (ref: string | null | undefined) => string | null;
  importFiles: () => Promise<ImportResult>;
  /** скачать трек по ссылке в папку приложения и добавить в библиотеку */
  addFromLink: (input: { url: string; title: string; id?: string }) => Promise<string | null>;
  /** добавить один файл по пути (после скачивания или из системного «Поделиться») */
  adopt: (input: { uri: string; name?: string | null; mime?: string | null; bytes?: number | null; id?: string }) => Promise<string | null>;
  removeTrack: (id: string) => Promise<void>;
  createPlaylist: (name: string) => Promise<string>;
  /** треки плейлиста в порядке добавления (для плеера) */
  tracksOfPlaylist: (playlistId: string) => Track[];
  addToPlaylist: (playlistId: string, trackId: string) => Promise<void>;
  removeFromPlaylist: (playlistId: string, trackId: string) => Promise<void>;
  /** отметить прослушивание: питает статистику на телефоне */
  logPlay: (trackId: string, seconds: number) => void;
  reload: () => Promise<void>;
};

const LocalLibraryContext = createContext<LocalLibraryValue | null>(null);

/* --------------------------------------------------------------- чтение --- */

function parseFiles(raw: string | null): LocalLibrary {
  if (!raw) return EMPTY_LIBRARY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY_LIBRARY;
    const entries = (parsed as { entries?: unknown }).entries;
    if (!entries || typeof entries !== 'object') return EMPTY_LIBRARY;
    const result: LocalLibrary = { version: 1, entries: {} };
    for (const [id, value] of Object.entries(entries as Record<string, Partial<LocalLibrary['entries'][string]>>)) {
      if (!value || typeof value.uri !== 'string') continue;
      result.entries[id] = {
        id,
        uri: value.uri,
        checksum: typeof value.checksum === 'string' ? value.checksum : null,
        bytes: Math.max(0, Number(value.bytes) || 0),
        mime: String(value.mime ?? 'audio/mpeg'),
        addedAt: Number(value.addedAt) || 0,
      };
    }
    return result;
  } catch {
    // Битый индекс — не повод терять приложение: считаем, что файлов нет,
    // и предлагаем импорт заново.
    return EMPTY_LIBRARY;
  }
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Длительность файла средствами системы: теги читать нечем, а метаданные дают её точно. */
async function probeDuration(uri: string): Promise<number | null> {
  try {
    const { sound, status } = await Audio.Sound.createAsync({ uri }, { shouldPlay: false });
    const seconds = status.isLoaded && status.durationMillis ? status.durationMillis / 1000 : null;
    await sound.unloadAsync().catch(() => {});
    return seconds && Number.isFinite(seconds) ? Math.round(seconds) : null;
  } catch {
    return null;
  }
}

export function LocalLibraryProvider({ children }: { children: ReactNode }) {
  const [library, setLibrary] = useState<LocalLibrary>(EMPTY_LIBRARY);
  const [metas, setMetas] = useState<Record<string, LocalMeta>>({});
  const [playlistState, setPlaylistState] = useState<LocalPlaylist[]>([]);
  const [stats, setStats] = useState<LocalStats>(EMPTY_STATS);
  const [ready, setReady] = useState(false);

  const libraryRef = useRef(library);
  libraryRef.current = library;

  /* ---- загрузка и перепроверка файлов ---- */
  const load = useCallback(async () => {
    const [rawFiles, rawMeta, rawPlaylists, rawStats] = await Promise.all([
      AsyncStorage.getItem(KEYS.files).catch(() => null),
      AsyncStorage.getItem(KEYS.meta).catch(() => null),
      AsyncStorage.getItem(KEYS.playlists).catch(() => null),
      AsyncStorage.getItem(KEYS.stats).catch(() => null),
    ]);

    const stored = parseFiles(rawFiles);
    // Файл мог исчезнуть (чистка хранилища, удаление из галереи) — такой трек
    // в списке оставлять нельзя: он молча не заиграет.
    const alive: LocalLibrary = { version: 1, entries: {} };
    for (const [id, entry] of Object.entries(stored.entries)) {
      const info = await FileSystem.getInfoAsync(entry.uri).catch(() => null);
      if (info?.exists) alive.entries[id] = entry;
    }

    const meta = parseJson<Record<string, LocalMeta>>(rawMeta, {});
    const playlists = parseJson<LocalPlaylist[]>(rawPlaylists, []);
    const aliveIds = new Set(Object.keys(alive.entries));

    setLibrary(alive);
    setMetas(meta);
    // Плейлист на «пропавший» трек не должен выглядеть полным
    setPlaylistState(prunePlaylists(Array.isArray(playlists) ? playlists : [], aliveIds));
    setStats(parseJson<LocalStats>(rawStats, EMPTY_STATS));

    if (Object.keys(alive.entries).length !== Object.keys(stored.entries).length) {
      await AsyncStorage.setItem(KEYS.files, JSON.stringify(alive)).catch(() => {});
    }
  }, []);

  useEffect(() => {
    void load().finally(() => setReady(true));
  }, [load]);

  /* ---- сохранение ---- */
  const persistFiles = useCallback(async (next: LocalLibrary) => {
    setLibrary(next);
    libraryRef.current = next;
    await AsyncStorage.setItem(KEYS.files, JSON.stringify(next)).catch(() => {});
    return next;
  }, []);

  const persistMeta = useCallback(async (next: Record<string, LocalMeta>) => {
    setMetas(next);
    await AsyncStorage.setItem(KEYS.meta, JSON.stringify(next)).catch(() => {});
    return next;
  }, []);

  const persistPlaylists = useCallback(async (next: LocalPlaylist[]) => {
    setPlaylistState(next);
    await AsyncStorage.setItem(KEYS.playlists, JSON.stringify(next)).catch(() => {});
    return next;
  }, []);

  /* ---- импорт ---- */

  /**
   * Добавляет файл по пути. Название и артист берутся из имени файла, если
   * метаданных ещё нет: у большинства скачанных треков теги есть, но полагаться
   * на это нельзя.
   */
  const adoptOne = useCallback(
    async (input: { uri: string; name?: string | null; mime?: string | null; bytes?: number | null; id?: string }): Promise<string | null> => {
      const uri = String(input.uri ?? '');
      if (!uri) return null;
      const current = libraryRef.current;
      const name = input.name ?? uri.split('/').pop() ?? '';
      const guessed = guessMeta(name || uri);
      const result = registerFile(
        current,
        {
          // `id` приходит, когда файл скачан с другого устройства: чужой трек
          // должен сохраниться под своим id, иначе в ленте появятся два разных
          // трека с одинаковым содержимым.
          key: input.id ?? uri,
          uri,
          title: guessed.title,
          artist: guessed.artist,
          bytes: input.bytes ?? null,
          mime: input.mime || mimeOf(name || uri),
        },
        { title: guessed.title, artist: guessed.artist }
      );

      if (!result.added) return result.id;

      let nextMeta = upsertMeta(metas, result.id, {
        title: guessed.title,
        artist: guessed.artist,
        duration: null,
      });
      // Длительность нужна списку и полосе прогресса до первого воспроизведения
      const duration = await probeDuration(uri);
      if (duration) nextMeta = upsertMeta(nextMeta, result.id, { ...nextMeta[result.id], duration });

      await persistFiles(result.library);
      await persistMeta(nextMeta);
      return result.id;
    },
    [metas, persistFiles, persistMeta]
  );

  const adopt = useCallback(
    async (input: { uri: string; name?: string | null; mime?: string | null; bytes?: number | null; id?: string }) => adoptOne(input),
    [adoptOne]
  );

  /**
   * Ссылка → файл в папке приложения.
   *
   * Скачиваем к себе, а не запоминаем адрес: у прямых ссылок бывают истекающие
   * подписи, а страница-источник может исчезнуть. Имя файла строится из названия
   * трека — по расширению плеер понимает контейнер, поэтому расширение обязательно.
   */
  const addFromLink = useCallback(
    async (input: { url: string; title: string; id?: string }) => {
      const url = String(input.url ?? '').trim();
      if (!url) throw new Error('Пустая ссылка');
      const title = String(input.title ?? '').trim() || 'Трек по ссылке';

      const info = await FileSystem.getInfoAsync(DOWNLOAD_DIR).catch(() => null);
      if (!info?.exists) await FileSystem.makeDirectoryAsync(DOWNLOAD_DIR, { intermediates: true }).catch(() => {});

      const ext = (/\.([a-z0-9]{2,5})(\?|$)/i.exec(url)?.[1] ?? 'mp3').toLowerCase();
      const safe = title.replace(/[^\p{L}\p{N} _.-]+/gu, '').slice(0, 60).trim() || 'track';
      const destination = `${DOWNLOAD_DIR}${Date.now().toString(36)}-${safe}.${ext}`;

      const before = libraryRef.current;
      const result = await FileSystem.downloadAsync(url, destination);
      if (result.status && result.status >= 400) {
        await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
        throw new Error(`Сервер отдал ${result.status} — файл не скачался`);
      }

      const bytes = (await FileSystem.getInfoAsync(destination).catch(() => null)) as { size?: number } | null;
      const size = Number(bytes?.size ?? 0);
      if (!size) {
        await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
        throw new Error('Файл пустой — возможно, ссылка ведёт на страницу, а не на звук');
      }

      // Скачалось не аудио (HTML вместо файла) — такую «музыку» не показываем.
      if (ext === 'mp3' && size < 1024) {
        await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
        throw new Error('По ссылке не аудиофайл');
      }

      const id = await adoptOne({
        uri: destination,
        name: `${title}.${ext}`,
        mime: mimeOf(`${title}.${ext}`),
        bytes: size,
        id: input.id,
      });
      if (!id) {
        // не смогли добавить — файл оставлять незачем
        await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
        return null;
      }
      // Название из ссылки важнее имени файла: оно уже человеческое.
      await persistMeta(upsertMeta(metas, id, { ...(metas[id] ?? {}), title }));
      void before;
      return id;
    },
    [adoptOne, metas, persistMeta]
  );

  /**
   * Импорт нескольких файлов. Копирование не делаем: остаёмся на исходном пути —
   * так библиотека не удваивает занятое место, а файл продолжает жить в своей
   * папке. Пропавшие файлы вычищаются при следующем запуске.
   */
  const importFiles = useCallback(async (): Promise<ImportResult> => {
    let picked: DocumentPicker.DocumentPickerResult;
    try {
      picked = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        copyToCacheDirectory: false,
        multiple: true,
      });
    } catch (cause) {
      return { added: 0, skipped: 0, total: 0, error: cause instanceof Error ? cause.message : 'Не удалось открыть выбор файлов' };
    }
    if (picked.canceled) return { added: 0, skipped: 0, total: 0 };

    const assets = picked.assets.slice(0, MAX_IMPORT);
    let added = 0;
    let skipped = 0;
    for (const asset of assets) {
      const id = await adoptOne({
        uri: asset.uri,
        name: asset.name,
        mime: asset.mimeType ?? null,
        bytes: asset.size ?? null,
      });
      if (!id) skipped += 1;
      else if (libraryRef.current.entries[id]) added += 1;
      else skipped += 1;
    }
    return { added, skipped, total: assets.length };
  }, [adoptOne]);

  const removeTrack = useCallback(
    async (id: string) => {
      const next = await persistFiles(removeFile(libraryRef.current, id));
      await persistPlaylists(prunePlaylists(playlistState, new Set(Object.keys(next.entries))));
      // Сам файл на диске не удаляем: он принадлежит пользователю и лежит не в
      // папке приложения. Убираем только запись в библиотеке.
    },
    [persistFiles, persistPlaylists, playlistState]
  );

  /* ---- плейлисты ---- */
  const createPlaylist = useCallback(
    async (name: string) => {
      const created = addPlaylist(playlistState, name);
      await persistPlaylists(created.playlists);
      return created.id;
    },
    [persistPlaylists, playlistState]
  );

  const addTrackToPlaylist = useCallback(
    async (playlistId: string, trackId: string) => {
      await persistPlaylists(pushTrack(playlistState, playlistId, trackId));
    },
    [persistPlaylists, playlistState]
  );

  const dropFromPlaylist = useCallback(
    async (playlistId: string, trackId: string) => {
      await persistPlaylists(removeFromPlaylist(playlistState, playlistId, trackId));
    },
    [persistPlaylists, playlistState]
  );

  /* ---- статистика ---- */
  const logPlay = useCallback((trackId: string, seconds: number) => {
    setStats((previous) => {
      const next = recordPlay(previous, { trackId, seconds, at: Date.now() });
      void AsyncStorage.setItem(KEYS.stats, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  /* ---- производные значения ---- */
  const tracks = useMemo(() => listTracks(library, metas), [library, metas]);

  const playlists = useMemo(() => {
    const byId = new Map(tracks.map((track) => [track.id, track]));
    return playlistState.map((playlist) => {
      const items = playlist.trackIds.map((id) => byId.get(id)).filter((track): track is Track => Boolean(track));
      return {
        id: playlist.id,
        name: playlist.name,
        description: null,
        createdAt: new Date(playlist.createdAt).toISOString(),
        trackCount: items.length,
        duration: items.reduce((sum, track) => sum + (track.duration || 0), 0),
      } satisfies Playlist;
    });
  }, [playlistState, tracks]);

  const uriOf = useCallback((ref: string | null | undefined) => localUriOf(libraryRef.current, ref), []);
  const bytesOf = useCallback((id: string) => libraryRef.current.entries[id]?.bytes ?? 0, []);
  const coverOf = useCallback(() => null as string | null, []);

  const tracksOf = useCallback(
    (playlistId: string) => tracksOfPlaylist(playlistState.find((item) => item.id === playlistId), tracks),
    [playlistState, tracks]
  );

  const value = useMemo<LocalLibraryValue>(() => {
    const titles = new Map(tracks.map((track) => [track.id, track.title]));
    const weekSeconds = stats.plays
      .filter((play) => play.at >= Date.now() - 7 * 24 * 60 * 60 * 1000)
      .reduce((sum, play) => sum + play.seconds, 0);
    return {
      ready,
      tracks,
      playlists,
      bytes: totalBytes(library),
      stats: {
        played: stats.plays.length,
        top: topTracks(stats, 5).map((row) => ({
          trackId: row.trackId,
          title: titles.get(row.trackId) ?? 'Трек удалён',
          plays: row.plays,
        })),
        weekSeconds,
      },
      uriOf,
      bytesOf,
      coverOf,
      importFiles,
      adopt,
      addFromLink,
      removeTrack,
      createPlaylist,
      tracksOfPlaylist: tracksOf,
      addToPlaylist: addTrackToPlaylist,
      removeFromPlaylist: dropFromPlaylist,
      logPlay,
      reload: load,
    };
  }, [
    ready, tracks, playlists, library, stats, uriOf, bytesOf, coverOf, importFiles, adopt, addFromLink, removeTrack,
    createPlaylist, tracksOf, addTrackToPlaylist, dropFromPlaylist, logPlay, load,
  ]);

  return <LocalLibraryContext.Provider value={value}>{children}</LocalLibraryContext.Provider>;
}

export function useLocalLibrary(): LocalLibraryValue {
  const value = useContext(LocalLibraryContext);
  if (!value) throw new Error('useLocalLibrary вне LocalLibraryProvider');
  return value;
}
