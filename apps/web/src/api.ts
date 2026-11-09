import { createClient, type VisionClient } from '@vision/shared';
import { LocalClient } from './local/client';

/**
 * Два режима работы:
 *  - обычный: запросы к API (self-hosted);
 *  - локальный (VITE_LOCAL_MODE=1): вся библиотека в IndexedDB браузера,
 *    поэтому сайт можно открыть как статику (GitHub Pages) без сервера.
 */
export const IS_LOCAL_MODE = import.meta.env.VITE_LOCAL_MODE === '1';

const TOKEN_KEY = 'vision.token';
const BASE_KEY = 'vision.apiBase';

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Для Tauri/React Native база задаётся явно; в браузере — тот же origin. */
function storedBase(): string {
  try {
    return localStorage.getItem(BASE_KEY) || '';
  } catch {
    return '';
  }
}

const remote = createClient({ token: storedToken(), baseUrl: storedBase() });
const local = new LocalClient();

export const api = (IS_LOCAL_MODE ? local : remote) as unknown as VisionClient;

export function saveToken(token: string | null) {
  api.setToken(token);
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* приватный режим */
  }
}

export function saveApiBase(base: string) {
  api.setBaseUrl(base);
  try {
    if (base) localStorage.setItem(BASE_KEY, base);
    else localStorage.removeItem(BASE_KEY);
  } catch {
    /* noop */
  }
}

export function hasToken(): boolean {
  return IS_LOCAL_MODE || Boolean(api.getToken());
}

export function apiBase(): string {
  return api.baseUrl;
}
