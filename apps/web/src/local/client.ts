import type { Playlist, Stats, Track, TrackQuery, UploadMeta, VisionClient } from '@vision/shared';

/**
 * Локальный (client-side) клиент: вся библиотека живёт в IndexedDB браузера.
 * Позволяет открывать Vision Audio как статический сайт (GitHub Pages) без API.
 * Контракт повторяет HTTP-клиент из @vision/shared, поэтому UI не знает разницы.
 */

const DB_NAME = 'vision-audio-local';
const DB_VERSION = 1;
const LOCAL_TOKEN = 'local';
const VERSION = '0.1.0-local';

type StoredTrack = Track & { blob: Blob };
type StoredPlaylist = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  trackIds: string[];
};

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const completed = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('IndexedDB недоступен'));
  });
}

const newId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
};

const cloneTrack = (track: StoredTrack): Track => {
  const { blob: _blob, ...rest } = track;
  return { ...rest };
};

export class LocalClient {
  baseUrl = '';
  private opening: Promise<void> | null = null;
  private db!: IDBDatabase;
  private blobs = new Map<string, Blob>();
  private urls = new Map<string, string>();
  private trackStore: StoredTrack[] = [];
  private playlistStore: StoredPlaylist[] = [];

  /* ------------------------- совместимость с HTTP-клиентом ------------------------ */

  getToken() {
    return LOCAL_TOKEN;
  }

  setToken() {
    /* локальному режиму токен не нужен */
  }

  setBaseUrl() {
    /* no-op */
  }

  async login(_password?: string) {
    await this.init();
    return { token: LOCAL_TOKEN, expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString() };
  }

  async me() {
    await this.init();
    return { ok: true, role: 'owner', version: VERSION };
  }

  /* ---------------------------------- загрузка ---------------------------------- */

  private async init() {
    if (!this.opening) this.opening = this.load();
    await this.opening;
  }

  private async load() {
    this.db = await openDb();
    const [tracks, playlists] = await Promise.all([
      request(this.db.transaction('tracks', 'readonly').objectStore('tracks').getAll() as IDBRequest<StoredTrack[]>),
      request(
        this.db.transaction('playlists', 'readonly').objectStore('playlists').getAll() as IDBRequest<StoredPlaylist[]>
      ),
    ]);

    this.trackStore = tracks;
    this.playlistStore = playlists;

    for (const track of this.trackStore) {
      if (!this.blobs.has(track.id)) {
        this.blobs.set(track.id, track.blob);
        this.urls.set(track.id, URL.createObjectURL(track.blob));
      }
    }
  }

  private async putTrack(track: StoredTrack) {
    const tx = this.db.transaction('tracks', 'readwrite');
    tx.objectStore('tracks').put(track);
    await completed(tx);
  }

  private async putPlaylist(playlist: StoredPlaylist) {
    const tx = this.db.transaction('playlists', 'readwrite');
    tx.objectStore('playlists').put(playlist);
    await completed(tx);
  }

  private findTrack(id: string) {
    return this.trackStore.find((track) => track.id === id) ?? null;
  }

  private filterTracks(query: TrackQuery = {}) {
    const needle = query.q?.trim().toLowerCase() ?? '';
    const result = this.trackStore.filter((track) => {
      if (query.liked && !track.liked) return false;
      if (query.genre && track.genre !== query.genre) return false;
      if (!needle) return true;
      return `${track.title} ${track.artist} ${track.album ?? ''} ${track.genre ?? ''}`
        .toLowerCase()
        .includes(needle);
    });

    const sorted = [...result];
    switch (query.sort) {
      case 'title':
        sorted.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
        break;
      case 'plays':
        sorted.sort((a, b) => b.plays - a.plays);
        break;
      case 'duration':
        sorted.sort((a, b) => b.duration - a.duration);
        break;
      case 'oldest':
        sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        break;
      default:
        sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    const limit = query.limit ?? 2000;
    return sorted.slice(0, limit).map(cloneTrack);
  }

  /* ----------------------------------- треки ----------------------------------- */

  async tracks(query: TrackQuery = {}) {
    await this.init();
    const result = this.filterTracks(query);
    // peaks в списке тоже полезны: волна в плеере рисуется сразу
    return result;
  }

  async track(id: string) {
    await this.init();
    const found = this.findTrack(id);
    if (!found) throw new Error('Трек не найден');
    return cloneTrack(found);
  }

  async updateTrack(id: string, patch: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'genre' | 'description' | 'liked'>>) {
    await this.init();
    const found = this.findTrack(id);
    if (!found) throw new Error('Трек не найден');
    const next: StoredTrack = { ...found, ...patch } as StoredTrack;
    await this.putTrack(next);
    this.trackStore = this.trackStore.map((track) => (track.id === id ? next : track));
    return cloneTrack(next);
  }

  async setLiked(id: string, liked: boolean) {
    return this.updateTrack(id, { liked });
  }

  async deleteTrack(id: string) {
    await this.init();
    const tx = this.db.transaction(['tracks', 'playlists'], 'readwrite');
    tx.objectStore('tracks').delete(id);
    for (const playlist of this.playlistStore) {
      if (playlist.trackIds.includes(id)) {
        const next = { ...playlist, trackIds: playlist.trackIds.filter((trackId) => trackId !== id) };
        tx.objectStore('playlists').put(next);
        this.playlistStore = this.playlistStore.map((item) => (item.id === next.id ? next : item));
      }
    }
    await completed(tx);
    this.trackStore = this.trackStore.filter((task) => task.id !== id);
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
    this.blobs.delete(id);
  }

  async registerPlay(id: string) {
    await this.init();
    const found = this.findTrack(id);
    if (!found) return;
    const next = { ...found, plays: found.plays + 1 };
    await this.putTrack(next);
    this.trackStore = this.trackStore.map((track) => (track.id === id ? next : track));
  }

  streamUrl(id: string) {
    return this.urls.get(id) ?? '';
  }

  coverUrl(_id: string) {
    return '';
  }

  async uploadTrack(blob: Blob, meta: UploadMeta, onProgress?: (percent: number) => void) {
    await this.init();

    const id = newId();
    const peaks = Array.isArray(meta.peaks) ? meta.peaks.map((value) => Math.max(0, Math.min(1, Number(value) || 0))) : null;

    const track: StoredTrack = {
      id,
      title: meta.title?.trim() || meta.filename?.replace(/\.[a-z0-9]+$/i, '') || 'Без названия',
      artist: meta.artist?.trim() || 'Unknown',
      album: meta.album?.trim() || null,
      genre: meta.genre?.trim() || null,
      description: meta.description?.trim() || null,
      mime: blob.type || 'audio/mpeg',
      size: blob.size,
      duration: Number(meta.duration) || 0,
      peaks,
      cover: false,
      plays: 0,
      liked: false,
      createdAt: new Date().toISOString(),
      blob,
    };

    onProgress?.(35);
    await this.putTrack(track);
    onProgress?.(100);

    this.trackStore = [...this.trackStore, track];
    this.blobs.set(id, blob);
    this.urls.set(id, URL.createObjectURL(blob));

    return cloneTrack(track);
  }

  /* -------------------------------- плейлисты -------------------------------- */

  private toPlaylist(playlist: StoredPlaylist): Playlist {
    const tracks = playlist.trackIds
      .map((trackId) => this.findTrack(trackId))
      .filter((track): track is StoredTrack => Boolean(track));
    return {
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      createdAt: playlist.createdAt,
      trackCount: tracks.length,
      duration: tracks.reduce((sum, track) => sum + track.duration, 0),
    };
  }

  async playlists() {
    await this.init();
    return [...this.playlistStore]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((playlist) => this.toPlaylist(playlist));
  }

  async createPlaylist(name: string, description?: string) {
    await this.init();
    const clean = name.trim();
    if (!clean) throw new Error('Нужно название плейлиста');
    const playlist: StoredPlaylist = {
      id: newId(),
      name: clean,
      description: description?.trim() || null,
      createdAt: new Date().toISOString(),
      trackIds: [],
    };
    await this.putPlaylist(playlist);
    this.playlistStore = [...this.playlistStore, playlist];
    return this.toPlaylist(playlist);
  }

  async updatePlaylist(id: string, patch: { name?: string; description?: string }) {
    await this.init();
    const found = this.playlistStore.find((playlist) => playlist.id === id);
    if (!found) throw new Error('Плейлист не найден');
    const next: StoredPlaylist = {
      ...found,
      name: patch.name?.trim() || found.name,
      description: patch.description !== undefined ? patch.description : found.description,
    };
    await this.putPlaylist(next);
    this.playlistStore = this.playlistStore.map((playlist) => (playlist.id === id ? next : playlist));
    return this.toPlaylist(next);
  }

  async deletePlaylist(id: string) {
    await this.init();
    const tx = this.db.transaction('playlists', 'readwrite');
    tx.objectStore('playlists').delete(id);
    await completed(tx);
    this.playlistStore = this.playlistStore.filter((playlist) => playlist.id !== id);
  }

  async playlistTracks(id: string) {
    await this.init();
    const playlist = this.playlistStore.find((item) => item.id === id);
    if (!playlist) return [];
    return playlist.trackIds
      .map((trackId) => this.findTrack(trackId))
      .filter((track): track is StoredTrack => Boolean(track))
      .map(cloneTrack);
  }

  async addToPlaylist(playlistId: string, trackId: string) {
    await this.init();
    const playlist = this.playlistStore.find((item) => item.id === playlistId);
    if (!playlist) throw new Error('Плейлист не найден');
    if (!this.findTrack(trackId)) throw new Error('Трек не найден');
    if (playlist.trackIds.includes(trackId)) return;
    const next = { ...playlist, trackIds: [...playlist.trackIds, trackId] };
    await this.putPlaylist(next);
    this.playlistStore = this.playlistStore.map((item) => (item.id === playlistId ? next : item));
  }

  async removeFromPlaylist(playlistId: string, trackId: string) {
    await this.init();
    const playlist = this.playlistStore.find((item) => item.id === playlistId);
    if (!playlist) return;
    const next = { ...playlist, trackIds: playlist.trackIds.filter((id) => id !== trackId) };
    await this.putPlaylist(next);
    this.playlistStore = this.playlistStore.map((item) => (item.id === playlistId ? next : item));
  }

  /* --------------------------------- статистика --------------------------------- */

  async stats(): Promise<Stats> {
    await this.init();
    const genres = new Map<string, number>();
    for (const track of this.trackStore) {
      if (track.genre) genres.set(track.genre, (genres.get(track.genre) ?? 0) + 1);
    }

    return {
      tracks: this.trackStore.length,
      plays: this.trackStore.reduce((sum, track) => sum + track.plays, 0),
      duration: this.trackStore.reduce((sum, track) => sum + track.duration, 0),
      liked: this.trackStore.filter((track) => track.liked).length,
      playlists: this.playlistStore.length,
      diskFreeMb: null,
      version: VERSION,
      genres: [...genres.entries()]
        .map(([genre, count]) => ({ genre, count }))
        .sort((a, b) => b.count - a.count),
    };
  }
}

export type { VisionClient };
