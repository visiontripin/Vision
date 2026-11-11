import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { apiBase } from './api';
import { createCrashReporter } from '@vision/shared';
import './styles.css';

/*
 * Отчёты о падениях (Фаза 3, H5).
 *
 * Ставим до рендера: если React не смонтируется, `window.onerror` — единственное
 * место, откуда об этом узнает хоть кто-то. Ошибки внутри репортера гасятся им
 * самим, поэтому «добавить наблюдателя» здесь безопасно.
 */
const crashes = createCrashReporter(() => apiBase(), {
  app: 'web',
  version: __APP_VERSION__,
  platform: navigator.userAgent.includes('Win') ? 'windows' : navigator.platform || 'web',
  release: navigator.userAgent,
  // установка — тот же идентификатор, что у трекера реплик, но без адресов
  deviceId: localStorage.getItem('vision.device') ?? undefined,
  context: () => ({ path: location.pathname, mode: import.meta.env.MODE }),
});

window.addEventListener('error', (event) => crashes.capture(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => crashes.capture(event.reason));

// PWA: оболочка и список треков открываются офлайн.
// На http://<ip> (например, Termux в домашней сети) браузер SW не даёт —
// тогда просто работаем как обычный сайт, без ошибок в консоли.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
