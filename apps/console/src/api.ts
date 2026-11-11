/**
 * Контракт панели Vision Server.
 *
 * Панель — отдельное приложение (Windows, Android, браузер). Оно не знает, где
 * живёт сервер: адрес вводится на экране подключения, а всё остальное — обычное
 * HTTP-API с Bearer-токеном владельца.
 *
 * Здесь же — форма ответа `/api/health` и разбор адресов так, как их понимает
 * человек: `192.168.1.10:4000` без схемы, с хвостовым слэшем, с `/api` на конце.
 */

export type Health = {
  ok: boolean;
  tracks: number;
  diskFreeMb: number | null;
  version: string;
  migrations: { applied: string[]; pending: number };
  ffmpeg: { available: boolean; version: string | null; path: string | null };
  runtime: { platform: string; arch: string; node: string; termux: boolean };
  transcode: Record<string, unknown>;
  storage: {
    mode: string;
    seedEnabled: boolean;
    deviceId: string;
    publicUrl: string | null;
  };
  tracker: {
    blobs: number;
    seeds: number;
    servableBlobs: number;
    noSource: number;
    ttlMs: number;
  };
};

export type LoginResult = {
  token: string;
  expiresAt?: string;
  ttlMs?: number;
};

const TOKEN_KEY = 'vision.console.token';
const BASE_KEY = 'vision.console.base';

/**
 * Приводит ввод человека к адресу API: `192.168.1.10:4000` → `http://192.168.1.10:4000`,
 * `host/api` → `host`, хвостовой слэш убираем. Пустая строка означает «тот же origin»
 * (панель, открытая самим сервером по `/admin`).
 */
export function normalizeBase(input: string): string {
  let value = String(input || '').trim();
  if (!value) return '';
  value = value.replace(/\/+$/, '');
  value = value.replace(/\/api(\/v1)?$/i, '');
  if (!/^https?:\/\//i.test(value)) {
    // порт без схемы — это локальная сеть по http; всё остальное тоже http,
    // потому что HTTPS-туннель человек обычно копирует целиком со схемой
    value = `http://${value}`;
  }
  return value.replace(/\/+$/, '');
}

/** Подсказка для экрана подключения: что именно вводить. */
export function baseHint(input: string): string | null {
  const value = normalizeBase(input);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!url.hostname) return 'Не похоже на адрес — нужен host или host:port.';
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'Не похоже на адрес — нужен host или host:port.';
  }
}

export function loadSession(): { base: string; token: string } {
  try {
    return {
      base: localStorage.getItem(BASE_KEY) || '',
      token: localStorage.getItem(TOKEN_KEY) || '',
    };
  } catch {
    return { base: '', token: '' };
  }
}

export function saveSession(base: string, token: string | null) {
  try {
    localStorage.setItem(BASE_KEY, base);
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* приватный режим — работаем без запоминания */
  }
}

export class ConsoleError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Клиент панели. Тонкий: только те вызовы, которые есть в панели, чтобы не
 * тянуть весь `VisionClient` в бандл APK и не расходиться с `apps/web`.
 */
export class ConsoleClient {
  base: string;
  token: string | null;

  constructor(base = '', token: string | null = null) {
    this.base = normalizeBase(base);
    this.token = token;
  }

  setBase(base: string) {
    this.base = normalizeBase(base);
  }

  setToken(token: string | null) {
    this.token = token;
  }

  private url(path: string): string {
    return `${this.base}${path}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    let response: Response;
    try {
      response = await fetch(this.url(path), { ...init, headers });
    } catch (error) {
      throw new ConsoleError(
        'network',
        `Сервер не отвечает по адресу ${this.base || 'этого окна'}. Проверьте адрес и Wi-Fi.`,
        0
      );
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ConsoleError(
        error?.code || `http_${response.status}`,
        error?.message || `Сервер ответил ${response.status}`,
        response.status
      );
    }

    return payload as T;
  }

  /** Проверка «сервер жив» — до входа, чтобы показать версию и платформу. */
  health() {
    return this.request<Health>('/api/health');
  }

  async login(password: string) {
    const result = await this.request<LoginResult>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    this.token = result.token;
    return result;
  }

  me() {
    return this.request<{ ok: boolean; role: string; version: string }>('/api/me');
  }

  stats() {
    return this.request<{
      tracks: number;
      plays: number;
      duration: number;
      liked: number;
      playlists: number;
      bytes: number;
      diskFreeMb: number | null;
      version: string;
      genres: { genre: string; count: number }[];
    }>('/api/stats');
  }

  tracker() {
    return this.request<{
      blobs: number;
      seeds: number;
      servableBlobs: number;
      noSource: number;
      ttlMs: number;
      devices: number;
      kinds: Record<string, number>;
    }>('/api/seeds');
  }

  shares() {
    return this.request<
      Array<{
        id: string;
        targetKind: 'track' | 'playlist';
        targetId: string;
        title: string | null;
        plays: number;
        maxPlays: number | null;
        expiresAt: string | null;
        revokedAt: string | null;
        comments?: number;
        active?: boolean;
        stats?: { hits: Record<string, number>; visitors: number; lastHitAt: string | null };
      }>
    >('/api/shares?includeRevoked=1');
  }

  revokeShare(id: string) {
    return this.request<void>(`/api/shares/${id}`, { method: 'DELETE' });
  }

  rotateShare(id: string) {
    return this.request<{ url: string; path: string }>(`/api/shares/${id}/rotate`, {
      method: 'POST',
      body: '{}',
    });
  }

  tracks(limit = 50) {
    return this.request<{ tracks: Array<{ id: string; title: string; artist: string }>; total: number }>(
      `/api/tracks?limit=${limit}`
    );
  }

  deleteTrack(id: string) {
    return this.request<{ id: string; deleted?: boolean }>(`/api/tracks/${id}`, { method: 'DELETE' });
  }
}
