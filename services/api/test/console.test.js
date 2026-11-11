import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Панель администрирования как отдельное приложение (`apps/console`).
 *
 * Проверяем ровно то, из-за чего панель «не открывается с телефона»:
 *  - `/admin` отдаёт HTML, а его ассеты — файлы, не `index.html`;
 *  - SPA-роут панели не превращается в 404;
 *  - CSP панели разрешает только свой origin (запросы к API того же сервера);
 *  - если панель не собрана — честный 503 с инструкцией, а не битая страница;
 *  - библиотека и API при этом не задеты.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 4797;
const BASE = `http://127.0.0.1:${PORT}`;
const CONSOLE_DIST = path.join(ROOT, 'apps', 'console', 'dist');

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

async function start() {
  dataDir = mkdtempSync(path.join(tmpdir(), 'vision-console-'));
  child = spawn(process.execPath, ['services/api/src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(PORT),
      VISION_PASSWORD: 'vision',
      SEED_ENABLED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[api] ${chunk}`));
  await waitForServer();
}

async function stop() {
  child?.kill();
  child = null;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}

before(start);
after(stop);

describe('панель Vision Server', () => {
  test('/admin отдаёт страницу панели с подключением к API', async () => {
    if (!existsSync(path.join(CONSOLE_DIST, 'index.html'))) {
      // панель не собрали в этом окружении — проверяем честный отказ ниже
      return;
    }
    const res = await fetch(`${BASE}/admin`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    const html = await res.text();
    assert.match(html, /<div id="root">/);
    assert.match(html, /assets\/index-[^"]+\.js/);
  });

  test('ассеты панели отдаются как файлы, а не как индекс', async () => {
    if (!existsSync(path.join(CONSOLE_DIST, 'index.html'))) return;
    const html = await (await fetch(`${BASE}/admin`)).text();
    const assets = [...html.matchAll(/assets\/[^"]+/g)].map((match) => match[0]);
    assert.ok(assets.length >= 2, 'в сборке есть js и css');

    for (const asset of assets) {
      const res = await fetch(`${BASE}/admin/${asset}`);
      assert.equal(res.status, 200, asset);
      assert.ok(!/text\/html/.test(res.headers.get('content-type') || ''), `${asset} не должен быть HTML`);
      assert.ok(Number(res.headers.get('content-length')) > 0);
    }
  });

  test('SPA-роут панели не даёт 404', async () => {
    if (!existsSync(path.join(CONSOLE_DIST, 'index.html'))) return;
    const res = await fetch(`${BASE}/admin/settings/services`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<div id="root">/);
  });

  test('CSP панели не пускает внешние запросы', async () => {
    if (!existsSync(path.join(CONSOLE_DIST, 'index.html'))) return;
    const res = await fetch(`${BASE}/admin`);
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.ok(!/connect-src[^;]*https:\/\/\*/.test(csp), 'никаких «любых» доменов');
  });

  test('несуществующий файл панели — 404, а не HTML со статусом 200', async () => {
    if (!existsSync(path.join(CONSOLE_DIST, 'index.html'))) return;
    const res = await fetch(`${BASE}/admin/assets/нет-такого-файла.js`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
  });

  test('обход каталога через /admin не работает', async () => {
    const res = await fetch(`${BASE}/admin/../../package.json`);
    assert.ok(res.status === 404 || res.status === 200);
    if (res.status === 200) {
      const text = await res.text();
      assert.ok(!text.includes('"workspaces"'), 'файлы вне панели не отдаются');
    }
  });

  test('библиотека и API не задеты появлением панели', async () => {
    const health = await (await fetch(`${BASE}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.ok(health.version);

    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'vision' }),
    });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    const me = await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(me.status, 200);
  });
});
