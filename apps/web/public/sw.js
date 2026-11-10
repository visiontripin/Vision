/* Vision Audio — service worker.
 *
 * Задачи простые и намеренно без «магии»:
 *   1. оболочка приложения открывается офлайн (index.html + иконки + манифест);
 *   2. хэшированные ассеты (`/assets/*`) — cache-first, они неизменяемы;
 *   3. ответы API, от которых зависит список треков, — network-first с фолбэком
 *      на кэш, чтобы библиотека открывалась без сети;
 *   4. аудио и обложки воркер не трогает: у них Range-запросы и подписанные URL,
 *      а офлайн-копии хранит само приложение (Cache Storage, кэш `vision-media-v1`).
 *
 * Файл лежит в public/ и копируется в dist как есть — без бандлера, потому что
 * service worker не должен зависеть от хэшей сборки.
 */

const VERSION = 'v1';
const SHELL_CACHE = `vision-shell-${VERSION}`;
const API_CACHE = `vision-api-${VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

// Эндпоинты, которые имеет смысл держать в офлайн-копии (только GET).
const API_CACHEABLE = [/\/api\/tracks(\?|$)/, /\/api\/playlists(\?|$)/, /\/api\/history(\?|$)/, /\/api\/stats(\?|$)/, /\/api\/me(\?|$)/];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // по одному: один недоступный файл не должен ломать установку
      await Promise.all(SHELL_ASSETS.map((asset) => cache.add(asset).catch(() => {})));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          // `vision-media-v1` принадлежит приложению — его не трогаем никогда
          .filter((name) => name.startsWith('vision-') && name !== SHELL_CACHE && name !== API_CACHE && !name.startsWith('vision-media'))
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') void self.skipWaiting();
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

async function navigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put('./index.html', response.clone());
    return response;
  } catch {
    const cached = (await cache.match('./index.html')) || (await cache.match('./'));
    if (cached) return cached;
    return new Response('<h1>Нет сети</h1><p>Оболочка приложения не закэширована.</p>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Range-запросы (аудио, seek) и подписанные медиа отдаём браузеру как есть
  if (request.headers.has('range')) return;
  if (/\/api\/tracks\/[a-f0-9]{32}\/(stream|cover|hls)/.test(url.pathname)) return;
  if (/\/api\/media(\?|$)/.test(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigation(request));
    return;
  }

  if (/\/assets\//.test(url.pathname)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  if (API_CACHEABLE.some((pattern) => pattern.test(url.pathname))) {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }

  if (url.pathname.endsWith('/manifest.webmanifest') || /\/icon-(192|512|maskable-512)\.png$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});
