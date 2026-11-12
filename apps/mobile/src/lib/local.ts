import type { Playlist, Track } from '@vision/shared';
import { guessMeta } from './upload';

/**
 * Библиотека на самом устройстве.
 *
 * Приложение больше не обязано подключаться к чужому серверу: треки, которые
 * лежат на телефоне, живут здесь. Модель сознательно повторяет серверную
 * (`Track`/`Playlist` из `@vision/shared`), чтобы экраны, плеер и загрузки
 * работали без «режима»: им всё равно, откуда пришли данные.
 *
 * Ключевое правило: **плееру нужен локальный `uri`**, а не сетевой адрес.
 * Поэтому у локального трека обязателен `uri`, и `localUri()` его возвращает —
 * сервер в этот момент не нужен вовсе.
 */

/** Размер локальной библиотеки: id → путь к файлу на устройстве. */
export type LocalEntry = {
  /** `id` трека из общей модели — по нему экраны и плеер находят трек */
  id: string;
  uri: string;
  /** sha256 содержимого, если известен: ключ офлайн-копии, как у сервера */
  checksum?: string | null;
  bytes: number;
  mime: string;
  addedAt: number;
};

export type LocalLibrary = {
  version: 1;
  entries: Record<string, LocalEntry>;
};

export const EMPTY_LIBRARY: LocalLibrary = { version: 1, entries: {} };

/* ------------------------------------------------------------------ id ---- */

/**
 * Постоянный id для файла на устройстве.
 *
 * Считается из ключа (обычно `file://`-путь), а не из случайного числа: при
 * повторном импорте той же папки треки не задвоятся, а «переименовал файл —
 * получил новый трек» — это ожидаемое поведение, а не ошибка.
 */
export function localId(key: string): string {
  let hash = 0x811c9dc5;
  const text = String(key ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `loc_${hash.toString(36)}`;
}

/* --------------------------------------------------------------- запись --- */

export type RegisterInput = {
  key: string;
  uri: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  genre?: string | null;
  duration?: number | null;
  bytes?: number | null;
  mime?: string | null;
  checksum?: string | null;
  addedAt?: number;
};

const DEFAULT_MIME = 'audio/mpeg';

/** Трек, которого нет в локальной библиотеке (серверный), в модель не попадает. */
export function toTrack(entry: LocalEntry, extra: Partial<Track> = {}): Track {
  return {
    id: entry.id,
    title: extra.title ?? 'Без названия',
    artist: extra.artist ?? '',
    album: extra.album ?? null,
    genre: extra.genre ?? null,
    description: null,
    mime: entry.mime,
    size: entry.bytes,
    duration: extra.duration ?? 0,
    peaks: extra.peaks ?? null,
    cover: extra.cover ?? false,
    plays: extra.plays ?? 0,
    liked: extra.liked ?? false,
    checksum: entry.checksum ?? null,
    available: true,
    createdAt: new Date(entry.addedAt).toISOString(),
    ...extra,
  };
}

/**
 * Добавляет файл в библиотеку. Повторный вызов с тем же `key` обновляет запись,
 * а не создаёт вторую: импорт папки можно запускать сколько угодно раз.
 */
export function registerFile(
  library: LocalLibrary,
  input: RegisterInput,
  meta: { title: string; artist?: string | null; album?: string | null; genre?: string | null; duration?: number | null } = { title: input.title }
): { library: LocalLibrary; id: string; added: boolean } {
  const id = localId(input.key);
  const previous = library.entries[id];
  const entry: LocalEntry = {
    id,
    uri: input.uri,
    checksum: input.checksum ?? previous?.checksum ?? null,
    bytes: Math.max(0, Math.round(Number(input.bytes ?? previous?.bytes ?? 0))),
    mime: input.mime || previous?.mime || DEFAULT_MIME,
    // дату первого добавления не перезаписываем: по ней сортируется «недавнее»
    addedAt: previous?.addedAt ?? input.addedAt ?? Date.now(),
  };
  return {
    library: { version: 1, entries: { ...library.entries, [id]: entry } },
    id,
    added: !previous,
  };
}

export function removeFile(library: LocalLibrary, id: string): LocalLibrary {
  if (!library.entries[id]) return library;
  const entries = { ...library.entries };
  delete entries[id];
  return { version: 1, entries };
}

/** Метаданные трека живут отдельно от файла: файл можно удалить, запись — нет. */
export type LocalMeta = {
  title: string;
  artist?: string | null;
  album?: string | null;
  genre?: string | null;
  duration?: number | null;
  peaks?: number[] | null;
};

export function upsertMeta(metas: Record<string, LocalMeta>, id: string, meta: LocalMeta): Record<string, LocalMeta> {
  return { ...metas, [id]: { ...metas[id], ...meta } };
}

/* ---------------------------------------------------------------- чтение -- */

/**
 * Собирает список треков для экранов. Порядок — новые сверху: только что
 * добавленная музыка должна быть на виду, иначе «где мой трек» превращается в
 * поиск.
 */
export function listTracks(
  library: LocalLibrary,
  metas: Record<string, LocalMeta>,
  extras: Record<string, Partial<Track>> = {}
): Track[] {
  return Object.values(library.entries)
    .sort((left, right) => right.addedAt - left.addedAt)
    .map((entry) => {
      const meta = metas[entry.id];
      // Названия нет (файл без тегов, метаданные ещё не читали) — берём имя
      // файла: «Artist - Title.mp3» лучше, чем «Без названия».
      const guessed = guessMeta(entry.uri);
      const title = meta?.title?.trim() || guessed.title;
      const artist = meta?.artist?.trim() || guessed.artist || '';
      return toTrack(entry, {
        title,
        artist,
        ...(meta
          ? {
              album: meta.album ?? null,
              genre: meta.genre ?? null,
              duration: meta.duration ?? 0,
              peaks: meta.peaks ?? null,
            }
          : {}),
        ...(extras[entry.id] ?? {}),
      });
    });
}

/** Локальный путь для плеера: у локальной библиотеки он есть всегда. */
export function localUriOf(library: LocalLibrary, ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (library.entries[ref]) return library.entries[ref].uri;
  const byChecksum = Object.values(library.entries).find((entry) => entry.checksum && entry.checksum === ref);
  return byChecksum?.uri ?? null;
}

export function totalBytes(library: LocalLibrary): number {
  return Object.values(library.entries).reduce((sum, entry) => sum + (entry.bytes || 0), 0);
}

/* -------------------------------------------------------------- плейлисты - */

/**
 * Плейлисты на устройстве. Хранят id треков, а не копии: удалили трек —
 * плейлист не разваливается, просто становится короче.
 */
export type LocalPlaylist = {
  id: string;
  name: string;
  trackIds: string[];
  createdAt: number;
};

export function createPlaylist(playlists: LocalPlaylist[], name: string, now = Date.now()): { playlists: LocalPlaylist[]; id: string } {
  const id = `pl_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const trimmed = String(name ?? '').trim() || 'Новый плейлист';
  return { playlists: [{ id, name: trimmed, trackIds: [], createdAt: now }, ...playlists], id };
}

export function addToPlaylist(playlists: LocalPlaylist[], playlistId: string, trackId: string): LocalPlaylist[] {
  return playlists.map((playlist) =>
    playlist.id === playlistId && !playlist.trackIds.includes(trackId)
      ? { ...playlist, trackIds: [...playlist.trackIds, trackId] }
      : playlist
  );
}

export function removeFromPlaylist(playlists: LocalPlaylist[], playlistId: string, trackId: string): LocalPlaylist[] {
  return playlists.map((playlist) =>
    playlist.id === playlistId
      ? { ...playlist, trackIds: playlist.trackIds.filter((id) => id !== trackId) }
      : playlist
  );
}

/** Треки плейлиста в порядке добавления — то, что нужно плееру. */
export function tracksOfPlaylist(playlist: LocalPlaylist | undefined, tracks: Track[]): Track[] {
  if (!playlist) return [];
  const byId = new Map(tracks.map((track) => [track.id, track]));
  return playlist.trackIds.map((id) => byId.get(id)).filter((track): track is Track => Boolean(track));
}

/** Плейлист в общей модели — экраны не знают, локальный он или серверный. */
export function playlistToModel(playlist: LocalPlaylist, tracks: Track[]): Playlist {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const items = playlist.trackIds.map((id) => byId.get(id)).filter((track): track is Track => Boolean(track));
  return {
    id: playlist.id,
    name: playlist.name,
    description: null,
    createdAt: new Date(playlist.createdAt).toISOString(),
    trackCount: items.length,
    duration: items.reduce((sum, track) => sum + (track.duration || 0), 0),
  };
}

/**
 * Чистит плейлисты от треков, которых больше нет в библиотеке. Вызывается при
 * загрузке: файл могли удалить с диска другим приложением.
 */
export function prunePlaylists(playlists: LocalPlaylist[], knownIds: Set<string>): LocalPlaylist[] {
  return playlists.map((playlist) => {
    const kept = playlist.trackIds.filter((id) => knownIds.has(id));
    return kept.length === playlist.trackIds.length ? playlist : { ...playlist, trackIds: kept };
  });
}

/* -------------------------------------------------------------- статистика */

export type LocalPlay = {
  trackId: string;
  /** сколько секунд реально прослушано в этом сеансе */
  seconds: number;
  at: number;
};

/**
 * Статистика прослушивания на устройстве (её же показывает необязательный
 * экран в настройках). Сознательно совпадает по смыслу с серверной: считается
 * только реально прослушанное время, «дослушал ли» — отдельный флаг.
 */
export type LocalStats = {
  plays: LocalPlay[];
  /** id → сколько раз трек запускали */
  counts: Record<string, number>;
};

export const EMPTY_STATS: LocalStats = { plays: [], counts: {} };

const MAX_PLAYS = 5000;

export function recordPlay(stats: LocalStats, play: LocalPlay): LocalStats {
  if (!play.trackId || !Number.isFinite(play.seconds) || play.seconds <= 0) return stats;
  const plays = [...stats.plays, play].slice(-MAX_PLAYS);
  return {
    plays,
    counts: { ...stats.counts, [play.trackId]: (stats.counts[play.trackId] ?? 0) + 1 },
  };
}

/**
 * Итоги для экрана «что слушал»: самые частые наверху, одинаковые счётчики
 * разрешаются по свежести — иначе порядок прыгает между открытиями экрана.
 */
export function topTracks(stats: LocalStats, limit = 5): { trackId: string; plays: number; lastAt: number }[] {
  const lastAt = new Map<string, number>();
  for (const play of stats.plays) {
    lastAt.set(play.trackId, Math.max(lastAt.get(play.trackId) ?? 0, play.at));
  }
  return Object.entries(stats.counts)
    .map(([trackId, plays]) => ({ trackId, plays, lastAt: lastAt.get(trackId) ?? 0 }))
    .filter((row) => row.plays > 0)
    .sort((left, right) => right.plays - left.plays || right.lastAt - left.lastAt)
    .slice(0, Math.max(0, limit));
}

/** Секунды прослушивания за последние `days` суток — «сколько слушал на этой неделе». */
export function secondsInLastDays(stats: LocalStats, days: number, now = Date.now()): number {
  const from = now - Math.max(0, days) * 24 * 60 * 60 * 1000;
  return stats.plays
    .filter((play) => play.at >= from)
    .reduce((sum, play) => sum + play.seconds, 0);
}
