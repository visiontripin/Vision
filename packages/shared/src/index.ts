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
  /** sha256 содержимого — адрес блоба в распределённом хранилище */
  checksum?: string | null;
  /** кто и как может отдать файл (трекер реплик) */
  sources?: TrackSources;
  /** можно ли воспроизвести: файл локально или есть живой сид */
  available?: boolean;
  createdAt: string;
};

/**
 * Реплики трека по данным трекера.
 * `servable` — устройства, которые реально отдадут файл по HTTP;
 * `replicas` — копии, которые есть, но раздавать не умеют (браузер, телефон);
 * `local` — файл лежит на узле, к которому обращается клиент.
 */
export type TrackSources = {
  hash: string | null;
  local: boolean;
  servable: number;
  replicas: number;
  devices: number;
  kinds: Record<string, number>;
};

export type Playlist = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  trackCount: number;
  duration: number;
};

/**
 * Правило умного плейлиста (C7). Состав такого плейлиста не хранится: он
 * пересчитывается из правил при каждом открытии.
 */
export type SmartRule = {
  field:
    | 'genre' | 'artist' | 'album' | 'title' | 'liked'
    | 'year' | 'plays' | 'duration' | 'addedDays' | 'notPlayedDays';
  op: 'is' | 'contains' | 'gte' | 'lte' | 'eq' | 'empty' | 'any';
  value?: string | number | boolean;
};

export type SmartRules = {
  /** `all` — все правила (И), `any` — любое (ИЛИ). По умолчанию `all`. */
  match?: 'all' | 'any';
  rules: SmartRule[];
  sort?: 'recent' | 'oldest' | 'title' | 'artist' | 'plays' | 'duration' | 'random' | `field:${string}`;
  /** Лимит — часть правила: «Топ-40» перестаёт быть топ-40 без него. */
  limit?: number;
};

export type SmartPlaylist = {
  id: string;
  name: string;
  description: string | null;
  rules: SmartRules | null;
  smart: true;
  /** Сколько треков подходит под правила **сейчас**. */
  trackCount: number;
  /** Подписи правил по-русски — чтобы не дублировать словарь в каждом клиенте. */
  summary: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Подборка «Для вас» (J3). Это подсказка, а не обязательство: в ней 0–5 секций,
 * каждая — со своей причиной, чтобы человек понимал, почему трек здесь.
 */
export type PersonalSection = {
  key: 'continue' | 'top-genre' | 'forgotten' | 'fresh' | 'liked-mix';
  title: string;
  reason: string;
  tracks: Track[];
};

export type PersonalFeed = {
  greeting: string;
  generatedAt: string;
  /** Фиксирует перемешивание: одна и та же подборка до конца дня. */
  seed: number;
  sections: PersonalSection[];
  libraryTracks: number;
  /** Заполнено, когда подборок нет: что сделать, чтобы они появились. */
  hint: string | null;
};

/**
 * Резервная копия (D5). Важна не ссылка на архив, а ответ на вопрос «из этого
 * можно восстановиться?» — поэтому рядом с именем всегда есть результат проверки.
 */
export type BackupArchive = {
  name: string;
  bytes: number;
  createdAt: string;
};

export type BackupStatus = {
  dir: string;
  count: number;
  totalBytes: number;
  last: BackupArchive | null;
  ageDays: number | null;
  keep: number;
  level: 'ok' | 'warn';
  hint: string | null;
  backups: BackupArchive[];
  schedule: { hours: number; running: boolean; lastRun: { at: string; ok: boolean } | null };
};

export type BackupResult = {
  ok: boolean;
  name: string;
  archive: string;
  bytes: number;
  createdAt: string;
  verification: {
    ok: boolean;
    problems: string[];
    counts: Record<string, number | null>;
    checkedFiles: number;
    missingFiles: string[];
  };
  pruned: string[];
};

/** День графика дашборда (D1): нули тоже приходят, чтобы не было «дыр». */
export type DashboardDay = {
  day: string;
  plays: number;
  completed: number;
  shared: number;
};

export type DashboardTopTrack = {
  id: string;
  title: string | null;
  artist: string | null;
  /** Трек удалён из библиотеки, но история прослушиваний сохранена. */
  deleted: boolean;
  plays: number;
  completed: number;
};

export type Dashboard = {
  since: string;
  until: string;
  days: number;
  /** Смещение сервера в минутах: «день» здесь — день человека. */
  tz: number;
  totals: {
    plays: number;
    completed: number;
    tracks: number;
    listeners: number;
    sharedPlays: number;
  };
  sources: { owner: number; share: number };
  byDay: DashboardDay[];
  topTracks: DashboardTopTrack[];
  /** Отпечатки адресов, а не сами адреса: «слушают из одного места или из десяти». */
  listeners: { id: string; plays: number; tracks: number; firstSeen: string; lastSeen: string }[];
  hint: string | null;
};

export type Stats = {
  tracks: number;
  plays: number;
  duration: number;
  liked: number;
  playlists: number;
  bytes: number;
  diskFreeMb: number | null;
  version: string;
  genres: { genre: string; count: number }[];
};

/** Сид блоба: устройство, которое раздаёт конкретный файл. */
export type BlobSeed = {
  deviceId: string;
  kind: 'origin' | 'node' | 'desktop' | 'mobile' | 'browser' | string;
  baseUrl: string | null;
  servable: boolean;
  onlineAt: string;
  ageMs: number;
  /** подписанная ссылка на файл (только для раздающих) */
  url?: string | null;
};

export type BlobInfo = {
  hash: string;
  bytes: number;
  mime: string;
  createdAt: string;
};

export type SeedStats = {
  servable: number;
  replicas: number;
  devices: number;
  kinds: Record<string, number>;
};

export type SeedAnnouncement = {
  hash: string;
  deviceId?: string;
  kind?: 'origin' | 'node' | 'desktop' | 'mobile' | 'browser' | string;
  baseUrl?: string | null;
};

export type BlobState = {
  blob: BlobInfo;
  /** файл есть на этом узле (медиатека или каталог сида) */
  local: boolean;
  /** файл лежит именно в каталоге сида, то есть это реплика — её можно удалить */
  seeded?: boolean;
  /** идентификатор этого узла в реестре */
  deviceId?: string;
  seeds: BlobSeed[];
  stats: SeedStats;
};

export type SeedList = {
  hash: string;
  ttlMs: number;
  stats: SeedStats;
  local: boolean;
  seeds: BlobSeed[];
};

export type TrackerStats = {
  mode: 'local' | 'metadata';
  seedEnabled: boolean;
  deviceId: string;
  publicUrl: string | null;
  seedDir: string;
  ttlMs: number;
  blobs: number;
  seeds: number;
  replicas: number;
  servableBlobs: number;
  localBlobs: number;
  noSource: number;
};

/** Куда идти за файлом: свой узел или конкретный сид. */
export type DownloadTarget = {
  url: string;
  local: boolean;
  seed: BlobSeed | null;
  hash: string;
  bytes?: number;
  mime?: string;
  seeds?: BlobSeed[];
};

export type TrackPage = {
  items: Track[];
  total: number;
};

/** Короткоживущие подписанные ссылки на медиа (HMAC, ~30 минут). */
export type MediaItem = {
  /** лучший доступный вариант (сервер подставляет opus/aac, если они готовы) */
  stream: string;
  /** варианты по кодекам: original, opus, aac */
  streams?: Record<string, string>;
  /** HLS-плейлист, если нарезка готова */
  hls?: string | null;
  cover: string | null;
  expiresAt: string;
};

export type MediaMap = {
  ttlMs: number;
  items: Record<string, MediaItem>;
};

/**
 * Ссылка на трек во внешнем сервисе. Аудио у нас не хранится: воспроизведение
 * идёт через официальный встроенный плеер источника.
 */
export type ExternalTrack = {
  id: string;
  source: 'soundcloud' | string;
  permalink: string;
  title: string;
  artist: string | null;
  artwork: string | null;
  embedUrl: string;
  duration: number;
  note: string | null;
  createdAt: string;
};

export type ImportResult = {
  added: (ExternalTrack & { created: boolean })[];
  failed: { url: string; code: string; message: string }[];
};

export type HistoryEntry = {
  track: Track;
  position: number;
  duration: number;
  completed: boolean;
  plays: number;
  listenedAt: string;
};

/**
 * Приватная ссылка на трек или плейлист (Фаза 6, E1).
 *
 * Токен показывается **один раз** при создании: в базе лежит только его sha256.
 * Поэтому `token`/`url` есть в ответе `createShare`, но не в `share(id)` и не в
 * списке — восстановить ссылку можно только перевыпуском (`rotateShare`).
 */
export type Share = {
  id: string;
  targetKind: 'track' | 'playlist';
  targetId: string;
  title: string | null;
  expiresAt: string | null;
  maxPlays: number | null;
  plays: number;
  revokedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  active?: boolean;
  stats?: {
    hits: Record<string, number>;
    visitors: number;
    lastHitAt: string | null;
  };
  baseUrl?: string;
  /** сколько комментариев оставлено по ссылке (видит только владелец) */
  comments?: number;
};

/** Комментарий к секунде трека внутри конкретной приватной ссылки (E3). */
export type ShareComment = {
  id: string;
  trackId: string;
  /** секунда, к которой привязан комментарий (0..длительность) */
  at: number;
  author: string;
  body: string;
  createdAt: string;
  deletedAt?: string | null;
};

export type ShareCommentInput = {
  trackId: string;
  at: number;
  author?: string;
  body: string;
};

export type ShareWithToken = Share & {
  /** одноразово: сохраните, второй раз сервер его не покажет */
  token: string;
  /** абсолютный URL, готовый к отправке в мессенджер */
  url: string;
  path: string;
};

export type ShareInput = {
  targetKind: 'track' | 'playlist';
  targetId: string;
  title?: string | null;
  /** «30m», «12h», «7d», «forever» или null — бессрочно */
  ttl?: string | number | null;
  maxPlays?: number | null;
};

export type TrackQuery = {
  q?: string;
  genre?: string;
  liked?: boolean;
  sort?: 'relevance' | 'recent' | 'oldest' | 'title' | 'plays' | 'duration';
  limit?: number;
  offset?: number;
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

  /**
   * `authless` — запрос, которому токен не нужен и который не должен ломаться,
   * если токена нет: отчёт о падении уходит и до входа (H5).
   */
  async function request<T>(path: string, init: RequestInit = {}, { authless = false } = {}): Promise<T> {
    const headers = new Headers(init.headers || {});
    if (token && !authless) headers.set('Authorization', `Bearer ${token}`);
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
    /** То же, но с общим количеством записей из заголовка X-Total-Count. */
    async tracksPage(query: TrackQuery = {}) {
      const headers = new Headers();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      const response = await fetch(
        `${baseUrl}/api/tracks${qs({ ...query, liked: query.liked ? 1 : undefined } as any)}`,
        { headers }
      );
      const items = (await response.json()) as Track[];
      if (!response.ok) {
        const err = (items as any)?.error ?? {};
        throw new VisionError(response.status, err.code || 'http_error', err.message || `HTTP ${response.status}`);
      }
      const total = Number(response.headers.get('x-total-count') ?? items.length);
      return { items, total: Number.isFinite(total) ? total : items.length } satisfies TrackPage;
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
    /** Прогресс прослушивания — питает «Продолжить слушать». */
    listen(id: string, payload: { position: number; duration?: number; completed?: boolean }) {
      return request<void>(`/api/tracks/${id}/listen`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    /* внешние источники — только метаданные и официальный виджет */
    external(limit = 200) {
      return request<ExternalTrack[]>(`/api/external?limit=${limit}`);
    },
    importExternal(urls: string[]) {
      return request<ImportResult>('/api/external', {
        method: 'POST',
        body: JSON.stringify({ urls }),
      });
    },
    updateExternal(id: string, note: string | null) {
      return request<ExternalTrack>(`/api/external/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ note }),
      });
    },
    deleteExternal(id: string) {
      return request<void>(`/api/external/${id}`, { method: 'DELETE' });
    },

    /* ---------------- приватные ссылки (Фаза 6, E1) ---------------- */

    createShare(input: ShareInput) {
      return request<ShareWithToken>('/api/shares', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
    shares(params: { targetKind?: string; targetId?: string; includeRevoked?: boolean } = {}) {
      const q = qs({
        targetKind: params.targetKind,
        targetId: params.targetId,
        includeRevoked: params.includeRevoked ? 1 : undefined,
      });
      return request<Share[]>(`/api/shares${q}`);
    },
    share(id: string) {
      return request<Share>(`/api/shares/${id}`);
    },
    updateShare(id: string, patch: { title?: string | null; ttl?: string | number | null; maxPlays?: number | null }) {
      return request<Share>(`/api/shares/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    },
    /** Отзыв (по умолчанию) или полное удаление записи о ссылке. */
    deleteShare(id: string, purge = false) {
      return request<void>(`/api/shares/${id}${purge ? '?purge=1' : ''}`, { method: 'DELETE' });
    },
    /** Новая ссылка вместо скомпрометированной: старая перестаёт работать сразу. */
    rotateShare(id: string) {
      return request<ShareWithToken>(`/api/shares/${id}/rotate`, { method: 'POST', body: '{}' });
    },

    /* ---------------- комментарии к секунде (Фаза 6, E3) ---------------- */

    /** Владелец видит все комментарии своих ссылок, включая удалённые. */
    shareComments(id: string, trackId?: string) {
      const q = trackId ? qs({ trackId }) : '';
      return request<{ comments: ShareComment[]; total: number }>(`/api/shares/${id}/comments${q}`);
    },
    /** Владелец тоже может отметить секунду: комментарий появится в гостевой ленте. */
    addShareComment(id: string, input: ShareCommentInput) {
      return request<ShareComment>(`/api/shares/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
    deleteShareComment(id: string, commentId: string) {
      return request<{ id: string; deleted: boolean }>(
        `/api/shares/${id}/comments${qs({ commentId })}`,
        { method: 'DELETE' }
      );
    },

    history(limit = 12) {
      return request<HistoryEntry[]>(`/api/history?limit=${limit}`);
    },
    clearHistory() {
      return request<void>('/api/history', { method: 'DELETE' });
    },

    /**
     * Подписанные ссылки на поток и обложку. Токен в URL не передаём:
     * <audio>/<img> не умеют слать заголовки, поэтому сервер выдаёт HMAC-подпись
     * с коротким сроком жизни.
     */
    async media(ids: string[]): Promise<MediaMap> {
      const unique = Array.from(new Set(ids.filter(Boolean))).slice(0, 200);
      if (!unique.length) return { ttlMs: 0, items: {} };
      const payload = await request<MediaMap>(`/api/media?ids=${unique.join(',')}`);
      const items: Record<string, MediaItem> = {};
      for (const [id, item] of Object.entries(payload.items)) {
        const absolute = (path: string | null | undefined) =>
          !path ? null : path.startsWith('/') ? `${baseUrl}${path}` : path;

        const streams: Record<string, string> = {};
        for (const [kind, path] of Object.entries(item.streams ?? {})) {
          const url = absolute(path);
          if (url) streams[kind] = url;
        }

        items[id] = {
          stream: absolute(item.stream) ?? '',
          streams,
          hls: absolute(item.hls ?? null),
          cover: absolute(item.cover),
          expiresAt: item.expiresAt,
        };
      }
      return { ttlMs: payload.ttlMs, items };
    },

    /* ---------------- трекер реплик: блобы и сиды ---------------- */

    /** Сводка трекера этого узла: сколько блобов, сидов и треков без источника. */
    tracker() {
      return request<TrackerStats>('/api/seeds');
    },

    /** Состояние блоба: размер, mime, живые сиды. */
    blob(hash: string) {
      return request<BlobState>(`/api/blobs/${hash}`);
    },

    /** Сиды блоба с подписанными ссылками (30 минут). */
    blobSeeds(hash: string) {
      return request<SeedList>(`/api/blobs/${hash}/seeds`);
    },

    /**
     * Объявить себя сидом (heartbeat). Для браузера/телефона — `kind: 'browser'`
     * без baseUrl: это «у меня есть копия», раздавать по HTTP они не умеют.
     */
    announceSeed(seed: SeedAnnouncement) {
      return request<BlobSeed & { stats: SeedStats }>(`/api/blobs/${seed.hash}/seed`, {
        method: 'POST',
        body: JSON.stringify({
          deviceId: seed.deviceId,
          kind: seed.kind,
          baseUrl: seed.baseUrl ?? undefined,
        }),
      });
    },

    /** Убрать себя из реестра (удалили копию). */
    withdrawSeed(hash: string, deviceId: string) {
      return request<void>(`/api/blobs/${hash}/seed?deviceId=${encodeURIComponent(deviceId)}`, {
        method: 'DELETE',
      });
    },

    /** Удалить реплику с этого узла (origin-файлы не трогает). */
    removeReplica(hash: string) {
      return request<void>(`/api/blobs/${hash}/replica`, { method: 'DELETE' });
    },

    /** Забрать файл с живого сида на этот узел (с проверкой sha256). */
    replicateBlob(hash: string) {
      return request<{ ok: boolean; bytes?: number; already?: boolean; from?: string; stats: SeedStats }>(
        `/api/blobs/${hash}/replicate`,
        { method: 'POST', body: '{}' }
      );
    },

    /**
     * Куда идти за файлом: локальный стрим, живой сид или «нет источника» (409).
     * Возвращает абсолютную подписанную ссылку.
     */
    async downloadTarget(trackId: string): Promise<DownloadTarget> {
      const target = await request<DownloadTarget>(`/api/tracks/${trackId}/download?json=1`);
      return { ...target, url: target.url.startsWith('/') ? `${baseUrl}${target.url}` : target.url };
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

    /** Подборки по истории прослушиваний (J3). */
    personal() {
      return request<PersonalFeed>('/api/personal');
    },

    /* умные плейлисты (C7) */
    smartPlaylists() {
      return request<SmartPlaylist[]>('/api/smart-playlists');
    },
    smartPlaylist(id: string) {
      return request<SmartPlaylist>(`/api/smart-playlists/${id}`);
    },
    createSmartPlaylist(input: { name: string; description?: string; rules: SmartRules }) {
      return request<SmartPlaylist>('/api/smart-playlists', { method: 'POST', body: JSON.stringify(input) });
    },
    updateSmartPlaylist(id: string, patch: { name?: string; description?: string; rules?: SmartRules }) {
      return request<SmartPlaylist>(`/api/smart-playlists/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    },
    deleteSmartPlaylist(id: string) {
      return request<void>(`/api/smart-playlists/${id}`, { method: 'DELETE' });
    },
    smartPlaylistTracks(id: string) {
      return request<Track[]>(`/api/smart-playlists/${id}/tracks`);
    },

    stats() {
      return request<Stats>('/api/stats');
    },

    /**
     * Отчёт о падении (H5). Без токена осознанно: падение до входа — тоже нужное,
     * а просроченный токен не должен мешать отчёту дойти.
     */
    reportCrash(report: CrashReport) {
      return request<{ accepted: boolean; duplicate: boolean; count: number }>(
        '/api/crashes',
        { method: 'POST', body: JSON.stringify(report) },
        { authless: true }
      );
    },

    /** Отчёты о падениях для панели (H5). */
    listCrashes(params: { limit?: number; offset?: number; app?: string; version?: string } = {}) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== '') query.set(key, String(value));
      }
      const suffix = query.toString() ? `?${query}` : '';
      return request<CrashPage>(`/api/crashes${suffix}`);
    },

    crashSummary(days = 7) {
      return request<CrashSummary>(`/api/crashes/summary?days=${days}`);
    },

    pruneCrashes(keepDays?: number) {
      const suffix = keepDays === undefined ? '' : `?keepDays=${keepDays}`;
      return request<{ removed: number; before: string }>(`/api/crashes${suffix}`, { method: 'DELETE' });
    },

    /** Резервные копии: статус и создание (D5). */
    backups() {
      return request<BackupStatus>('/api/backups');
    },

    createBackup() {
      return request<BackupResult>('/api/backups', { method: 'POST' });
    },

    verifyBackup(name?: string) {
      return request<BackupResult['verification'] & { archive: string; checkedAt: string }>(
        '/api/backups/verify',
        { method: 'POST', body: JSON.stringify({ name }) }
      );
    },

    /** Дашборд владельца (D1): прослушивания по дням, топ, источники. */
    dashboard(days = 30) {
      return request<Dashboard>(`/api/dashboard?days=${encodeURIComponent(String(days))}`);
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

/**
 * Код для вставки приватной ссылки (E4). Токен живёт только в том ответе, где
 * его выдали, поэтому embed-код строится из уже известного `url`: из адреса
 * вырезается `/s/<токен>` и превращается в `/embed/<токен>`.
 *
 * Возвращает `null`, если адрес не наш — тогда честнее показать «нет кода»,
 * чем вставить в блог чужую ссылку.
 */
export function embedCode(url: string, kind: 'track' | 'playlist' = 'track'): string | null {
  const match = /^(.+?)\/(?:s|embed)\/([A-Za-z0-9_-]{20,128})\/?$/.exec(String(url || '').trim());
  if (!match) return null;
  const [, base, token] = match;
  const height = kind === 'playlist' ? 320 : 180;
  return `<iframe src="${base}/embed/${token}" width="480" height="${height}" style="border:0;max-width:100%" title="Vision Audio" loading="lazy" allow="autoplay"></iframe>`;
}

/** oEmbed-адрес для того же токена — его понимают CMS без ручного кода. */
export function oembedUrl(url: string): string | null {
  const match = /^(.+?)\/(?:s|embed)\/([A-Za-z0-9_-]{20,128})\/?$/.exec(String(url || '').trim());
  if (!match) return null;
  const [, base, token] = match;
  return `${base}/api/oembed?url=${encodeURIComponent(`${base}/s/${token}`)}`;
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

/* --------------------------- crash-репортинг (H5) ------------------------- */

export type CrashReport = {
  app?: 'mobile' | 'web' | 'desktop' | 'console';
  version?: string;
  platform?: string;
  release?: string;
  name?: string;
  message?: string;
  stack?: string;
  context?: Record<string, unknown> | string;
  deviceId?: string;
};

export type CrashItem = {
  id: number;
  app: string;
  version: string | null;
  platform: string | null;
  release: string | null;
  name: string | null;
  message: string | null;
  stack: string | null;
  context: Record<string, unknown> | string | null;
  deviceId: string | null;
  count: number;
  firstAt: string;
  lastAt: string;
  fingerprint: string;
};

export type CrashPage = { total: number; limit: number; offset: number; items: CrashItem[] };

export type CrashSummary = {
  since: string;
  days: number;
  groups: number;
  events: number;
  devices: number;
  byApp: { app: string; groups: number; events: number }[];
  byVersion: { version: string; groups: number; events: number }[];
  hint: string | null;
};

export type CrashReporterOptions = {
  app: CrashReport['app'];
  version?: string;
  platform?: string;
  release?: string;
  deviceId?: string;
  /** Что сейчас открыто: попадает в `context`, помогает повторить сценарий. */
  context?: () => Record<string, unknown>;
  /** Сколько отчётов держим в памяти до отправки (по умолчанию 5). */
  queueLimit?: number;
};

/**
 * Отправка отчётов о падениях (H5).
 *
 * Требования, которые важнее «чтобы был Sentry»:
 *  - **ничего не должно сломать**: любая ошибка внутри репортера гасится, иначе
 *    обработчик падений сам станет источником падений;
 *  - **не в цикле**: одинаковые падения в очереди схлопываются по подписи, а
 *    лимит частоты стоит на сервере (60 в час на установку);
 *  - **без токена**: падение до входа — самый нужный отчёт, поэтому запрос идёт
 *    без авторизации (сервер это разрешает осознанно, см. `docs/API.md`);
 *  - **офлайн — не теряем**: если сети нет, отчёт остаётся в очереди и уходит
 *    со следующей ошибкой или при явном `flush()`.
 */
export function createCrashReporter(getBaseUrl: () => string, options: CrashReporterOptions) {
  const queue: CrashReport[] = [];
  const limit = Math.max(1, options.queueLimit ?? 5);
  let sending = false;

  const fingerprint = (report: CrashReport) =>
    `${report.name ?? ''}|${report.message ?? ''}|${String(report.stack ?? '').split('\n')[1] ?? ''}`;

  const enqueue = (report: CrashReport) => {
    const key = fingerprint(report);
    if (queue.some((item) => fingerprint(item) === key)) return; // тот же баг уже в очереди
    queue.push({ ...report, app: report.app ?? options.app });
    while (queue.length > limit) queue.shift();
  };

  const flush = async (): Promise<number> => {
    if (sending || !queue.length) return 0;
    sending = true;
    let sent = 0;
    try {
      while (queue.length) {
        const report = queue[0];
        try {
          const base = getBaseUrl();
          if (!base) break;
          const response = await fetch(`${base}/api/crashes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(report),
          });
          // 429 — это «слишком часто», повторять бессмысленно; 4xx — отчёт плохой
          if (response.ok || (response.status >= 400 && response.status < 500)) {
            queue.shift();
            sent += 1;
          } else {
            break; // 5xx: сервер болен, оставляем на потом
          }
        } catch {
          break; // сети нет — очередь переживёт
        }
      }
    } finally {
      sending = false;
    }
    return sent;
  };

  const describe = (error: unknown): CrashReport => {
    const value = error as { name?: string; message?: string; stack?: string } | null;
    let context: Record<string, unknown> = {};
    try {
      context = options.context?.() ?? {};
    } catch {
      context = {};
    }
    return {
      app: options.app,
      version: options.version,
      platform: options.platform,
      release: options.release,
      deviceId: options.deviceId,
      name: value?.name ?? 'Error',
      message: value?.message ?? String(error ?? 'Неизвестная ошибка'),
      stack: value?.stack,
      context,
    };
  };

  return {
    /** Запомнить ошибку и попробовать отправить (не ждём результата). */
    capture(error: unknown) {
      try {
        enqueue(describe(error));
        void flush();
      } catch {
        /* репортер не имеет права падать */
      }
    },
    /** Явная отправка: например, при возврате приложения на передний план. */
    flush,
    queued: () => queue.length,
  };
}
