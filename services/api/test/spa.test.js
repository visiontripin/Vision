import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SPA-маршруты (F1/F5): `/share` и хэш-ссылки должны открываться у гостя.
 *
 * Share target из манифеста PWA ведёт на `/share?url=…`. Если сервер ответит
 * 404 или редиректом на вход, системное «Поделиться» приведёт человека на
 * пустую страницу — а заметить это в браузере на своём устройстве почти
 * невозможно. Поэтому проверяем контракт сервера: маршрут отдаёт оболочку
 * приложения (тот же `index.html`), без авторизации и без редиректов.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 4792;
const BASE = `http://127.0.0.1:${PORT}`;
const WEB_DIST = path.join(ROOT, 'apps', 'web', 'dist');

let child;
let dataDir;

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* ещё поднимается */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('сервер не поднялся');
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'vision-spa-'));
  child = spawn(process.execPath, ['services/api/src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      VISION_PASSWORD: 'vision',
      NODE_ENV: 'test',
      TRANSCODE: '0',
      SEED_ENABLED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  await waitForServer();
});

after(() => {
  child?.kill('SIGTERM');
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe('SPA-маршруты для входящих ссылок', () => {
  test('/share из системного меню «Поделиться» отдаёт оболочку без входа', async () => {
    if (!existsSync(path.join(WEB_DIST, 'index.html'))) return; // сборки нет — сервер сам скажет об этом
    const res = await fetch(`${BASE}/share?url=${encodeURIComponent('https://x.com/a.mp3')}&title=Song`, {
      redirect: 'manual',
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.match(html, /<div id="root">|<script/);
    // это оболочка, а не «страница не найдена»
    assert.doesNotMatch(html, /404|не найдена/i);
  });

  test('манифест объявляет share_target и ярлыки', async () => {
    if (!existsSync(path.join(WEB_DIST, 'manifest.webmanifest'))) return;
    const res = await fetch(`${BASE}/manifest.webmanifest`);
    assert.equal(res.status, 200);
    const manifest = await res.json();
    assert.equal(manifest.share_target.action, '/share');
    assert.equal(manifest.share_target.method, 'GET');
    assert.deepEqual(manifest.share_target.params, { title: 'title', text: 'text', url: 'url' });
    assert.ok(Array.isArray(manifest.shortcuts) && manifest.shortcuts.length > 0);
  });

  test('хэш-ссылка на трек открывается по обычному адресу', async () => {
    if (!existsSync(path.join(WEB_DIST, 'index.html'))) return;
    const res = await fetch(`${BASE}/#/track/8a02bbc67c18ea75f552118edcd688b4`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
  });

  test('несуществующий путь не превращается в 500', async () => {
    const res = await fetch(`${BASE}/совсем-не-наш-путь`);
    assert.ok([200, 404].includes(res.status), `статус ${res.status}`);
  });
});
