import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Версия попадает в сборку: по ней в отчётах о падениях видно, какая сборка падает
const appVersion = JSON.parse(readFileSync(path.resolve(dirname, 'package.json'), 'utf8')).version;

export default defineConfig({
  // Для GitHub Pages: BASE_PATH=/Vision/ (имя репозитория)
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      '@vision/shared': path.resolve(dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: false,
      },
    },
  },
  build: {
    // OUT_DIR нужен, чтобы статическая сборка для GitHub Pages не перетирала dist,
    // который отдаёт self-hosted API.
    outDir: process.env.OUT_DIR || 'dist',
    emptyOutDir: true,
  },
});
