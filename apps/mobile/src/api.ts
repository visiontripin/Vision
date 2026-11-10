import { createClient } from '@vision/shared';
import { loadBase } from './config';

/**
 * Тот же клиент, что в вебе (`@vision/shared`) — контракт один, ошибки одного
 * формата (`VisionError`). Здесь только инициализация адреса сервера.
 */
export const api = createClient({});

let ready: Promise<string> | null = null;

/** Загружает адрес сервера из хранилища (идемпотентно). */
export function initApi(): Promise<string> {
  if (!ready) {
    ready = loadBase().then((base) => {
      api.setBaseUrl(base);
      return base;
    });
  }
  return ready;
}

/** Смена адреса на лету (экран настроек). */
export function setApiBase(base: string) {
  api.setBaseUrl(base);
  ready = Promise.resolve(base);
}

export function apiBase(): string {
  return api.baseUrl;
}
