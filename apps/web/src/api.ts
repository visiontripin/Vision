import { createClient } from '@vision/shared';

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

export const api = createClient({ token: storedToken(), baseUrl: storedBase() });

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
  return Boolean(api.getToken());
}

export function apiBase(): string {
  return api.baseUrl;
}
