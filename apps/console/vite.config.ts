import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Панель Vision Server — отдельное приложение (Windows и Android через Tauri 2).
 *
 * Сборка — обычная статика: тот же бандл умеет работать в браузере (сервер отдаёт
 * его по `/admin` и `redirect_url` для мини-аппа Telegram), в окне Windows и в
 * APK. Адрес API вводится на экране подключения и запоминается.
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@vision/shared': path.resolve(dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5180,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
