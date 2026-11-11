import { createClient } from '@vision/shared';
import { guessMeta, fileNameOf, mimeForFile } from './lib/upload';
import { loadBase, loadToken } from './config';

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

/**
 * Отправка файла по адресу (`file://…`/`content://…`) — загрузка с телефона (H4).
 
 * Сервер ждёт **тело-файл** (`Content-Type: audio/*`), а не multipart: так
 * работает загрузка из веба, и второй способ означал бы второй контракт. В
 * React Native отправить файл с диска, не читая его в память, можно только
 * через `fetch` с `FormData({uri, name, type})` — это и есть multipart. Поэтому
 * обойтись без него нельзя, и сервер принимает *оба* вида: `handleUpload`
 * вытаскивает единственную часть из `multipart/form-data`, а байты считает по
 * факту (см. `services/api/src/server.js`). Тест на это — в api.test.js.
 */
export async function uploadFileFromDevice(
  uri: string,
  meta: { title: string; artist?: string | null; album?: string | null; genre?: string | null; duration?: number | null },
  options: { mime?: string; onProgress?: (percent: number) => void } = {}
): Promise<{ status: number; payload: unknown }> {
  const token = await loadToken();
  // Имя файла — запасной источник метаданных: у диктофона тегов нет вовсе,
  // а `title` из «Artist - Title.m4a» лучше, чем «Без названия».
  const guessed = guessMeta(fileNameOf({ uri, name: null }));
  const metaTitle = String(meta.title ?? '').trim() || guessed.title;
  const metaArtist = String(meta.artist ?? '').trim() || guessed.artist || '';

  const params = new URLSearchParams();
  params.set('title', metaTitle);
  if (metaArtist) params.set('artist', metaArtist);
  for (const key of ['album', 'genre'] as const) {
    const value = String(meta[key] ?? '').trim();
    if (value) params.set(key, value);
  }
  const duration = Number(meta.duration ?? 0);
  if (Number.isFinite(duration) && duration > 0) params.set('duration', String(Math.round(duration)));

  const url = `${api.baseUrl}/api/tracks?${params.toString()}`;
  const type = options.mime && options.mime !== 'application/octet-stream'
    ? options.mime
    : mimeForFile({ uri, name: null }) === 'application/octet-stream'
      ? 'audio/mpeg'
      : mimeForFile({ uri, name: null });

  /*
   * XHR, а не fetch: только у XHR есть `upload.onprogress`, а прогресс 300-МБ
   * файла на мобильной сети — единственное, что отличает «грузится» от «зависло».
   */
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    // FormData с одним файлом: RN сам подставит multipart-границу. Сервер берёт
    // из multipart единственную часть и дальше читает её как обычное тело.
    const body = new FormData();
    body.append('file', { uri, name: metaTitle || 'upload', type } as unknown as Blob);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && options.onProgress) {
        options.onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onload = () => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        payload = null;
      }
      resolve({ status: xhr.status, payload });
    };
    xhr.onerror = () => reject(new Error('Сеть недоступна'));
    xhr.ontimeout = () => reject(new Error('Сервер не ответил'));
    xhr.send(body);
  });
}
