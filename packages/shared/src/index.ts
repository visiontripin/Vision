/**
 * Общий контракт Vision Audio для web, Android/iOS (React Native) и desktop (Tauri).
 * Никаких зависимостей от браузера, кроме XMLHttpRequest при загрузке с прогрессом.
 */

export type Track = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  genre: string | null;
  description: string | null;
  mime: string;
  size: number;
  duration: number;
  peaks: number[] | null;
  cover: boolean;
  plays: number;
  liked: boolean;
  createdAt: string;
};

export type Playlist = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  trackCount: number;
  duration: number;
};

export type Stats = {
  tracks: number;
  plays: number;
  duration: number;
  liked: number;
  playlists: number;
  diskFreeMb: number | null;
  version: string;
  genres: { genre: string; count: number }[];
};

export type TrackQuery = {
  q?: string;
  genre?: string;
  liked?: boolean;
  sort?: 'recent' | 'oldest' | 'title' | 'plays' | 'duration';
  limit?: number;
};

export type UploadMeta = {
  title: string;
  artist?: string;
  album?: string;
  genre?: string;
  description?: string;
  duration?: number;
  peaks?: number[];
  filename?: string;
};

export type ApiError = { status: number; code: string; message: string };

export class VisionError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'VisionError';
    this.status = status;
    this.code = code;
  }
}

export type ClientOptions = {
  baseUrl?: string;
  token?: string | null;
};

const isBrowser = typeof window !== 'undefined';

export function createClient(options: ClientOptions = {}) {
  let baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  let token: string | null = options.token ?? null;

  if (!baseUrl && isBrowser) baseUrl = ''; // same-origin: web / preview / Tauri

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('Content-Type') && typeof init.body === 'string') {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    if (response.status === 204) return undefined as T;

    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      const err = (payload as any)?.error ?? {};
      throw new VisionError(response.status, err.code || 'http_error', err.message || `HTTP ${response.status}`);
    }
    return payload as T;
  }

  const qs = (params: Record<string, unknown>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === false || value === '') continue;
      search.set(key, value === true ? '1' : String(value));
    }
    const str = search.toString();
    return str ? `?${str}` : '';
  };

  return {
    get baseUrl() {
      return baseUrl;
    },
    setBaseUrl(url: string) {
      baseUrl = url.replace(/\/$/, '');
    },
    getToken: () => token,
    setToken(value: string | null) {
      token = value;
    },

    /* auth */
    login(password: string) {
      return request<{ token: string; expiresAt: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
    },
    me() {
      return request<{ ok: boolean; role: string; version: string }>('/api/me');
    },

    /* tracks */
    tracks(query: TrackQuery = {}) {
      return request<Track[]>(`/api/tracks${qs({ ...query, liked: query.liked ? 1 : undefined } as any)}`);
    },
    track(id: string) {
      return request<Track>(`/api/tracks/${id}`);
    },
    updateTrack(id: string, patch: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'genre' | 'description' | 'liked'>>) {
      return request<Track>(`/api/tracks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    },
    deleteTrack(id: string) {
      return request<void>(`/api/tracks/${id}`, { method: 'DELETE' });
    },
    setLiked(id: string, liked: boolean) {
      return request<Track>(`/api/tracks/${id}`, { method: 'PATCH', body: JSON.stringify({ liked }) });
    },
    registerPlay(id: string) {
      return request<void>(`/api/tracks/${id}/play`, { method: 'POST' });
    },

    streamUrl(id: string) {
      return `${baseUrl}/api/tracks/${id}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    },
    coverUrl(id: string) {
      return `${baseUrl}/api/tracks/${id}/cover${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    },

    /**
     * Загрузка с прогрессом. Использует XHR (работает и в браузере, и в React Native).
     */
    uploadTrack(blob: Blob, meta: UploadMeta, onProgress?: (percent: number) => void): Promise<Track> {
      const query = qs({
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        genre: meta.genre,
        description: meta.description,
        duration: meta.duration,
        filename: meta.filename,
        peaks: meta.peaks?.length ? JSON.stringify(meta.peaks) : undefined,
      });

      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${baseUrl}/api/tracks${query}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch {
              reject(new VisionError(500, 'invalid_response', 'Сервер вернул некорректный ответ.'));
            }
          } else {
            let code = 'upload_failed';
            let message = `Не удалось загрузить файл (${xhr.status}).`;
            try {
              const payload = JSON.parse(xhr.responseText);
              code = payload?.error?.code || code;
              message = payload?.error?.message || message;
            } catch { /* not json */ }
            reject(new VisionError(xhr.status, code, message));
          }
        };
        xhr.onerror = () => reject(new VisionError(0, 'network_error', 'Сеть недоступна.'));
        xhr.send(blob);
      });
    },

    /* playlists */
    playlists() {
      return request<Playlist[]>('/api/playlists');
    },
    createPlaylist(name: string, description?: string) {
      return request<Playlist>('/api/playlists', { method: 'POST', body: JSON.stringify({ name, description }) });
    },
    updatePlaylist(id: string, patch: { name?: string; description?: string }) {
      return request<Playlist>(`/api/playlists/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    },
    deletePlaylist(id: string) {
      return request<void>(`/api/playlists/${id}`, { method: 'DELETE' });
    },
    playlistTracks(id: string) {
      return request<Track[]>(`/api/playlists/${id}/tracks`);
    },
    addToPlaylist(playlistId: string, trackId: string) {
      return request<void>(`/api/playlists/${playlistId}/tracks`, {
        method: 'POST',
        body: JSON.stringify({ trackId }),
      });
    },
    removeFromPlaylist(playlistId: string, trackId: string) {
      return request<void>(`/api/playlists/${playlistId}/tracks/${trackId}`, { method: 'DELETE' });
    },

    stats() {
      return request<Stats>('/api/stats');
    },
  };
}

export type VisionClient = ReturnType<typeof createClient>;

/* ------------------------------- утилиты ------------------------------- */

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Детерминированная «псевдо-волна» по строке — для треков без peaks. */
export function pseudoPeaks(seed: string, count = 120): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    const wave = Math.abs(Math.sin(i / 3.1) * 0.55 + Math.sin(i / 11.7) * 0.3);
    out.push(Math.max(0.08, Math.min(1, ((h >>> 0) % 1000) / 1000 * 0.6 + wave)));
  }
  return out;
}
