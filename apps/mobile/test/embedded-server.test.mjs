/**
 * Проверка встроенного сервера как процесса: запускаем `bootstrap.mjs` так же,
 * как его запустит Node-рантайм на телефоне, и стучимся по HTTP.
 *
 * Почему процессом, а не функциями: самое хрупкое место встроенного сервера —
 * именно запуск (порт, `state.json`, обработка падения), а не разбор запросов.
 * Тест ловит `EADDRINUSE`, зависание на старте и «сервер жив, но не отвечает».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = path.join(HERE, '..', 'nodejs', 'embedded', 'bootstrap.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Свободный порт спрашиваем у системы: случайный диапазон рано или поздно
 * совпадёт с занятым портом (соседний тест, прошлый прогон) и тест начнёт мигать.
 */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'нет ответа';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.message ?? String(error);
    }
    await sleep(50);
  }
  throw new Error(`сервер не ответил за ${timeoutMs} мс: ${url} (${lastError})`);
}

/**
 * Ждёт нужную фазу в `state.json`.
 *
 * Фиксированные `sleep` в таких тестах — источник «морганий» на медленном
 * раннере: процесс успевает, а таймер нет. Ждём по состоянию, а не по времени.
 */
async function waitForState(dir, phase, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
      if (last.phase === phase) return last;
    } catch {
      /* файла ещё нет */
    }
    await sleep(50);
  }
  throw new Error(`state.json не дошёл до ${phase}: ${JSON.stringify(last)}`);
}

/** Ждёт выхода процесса (или таймаута) и возвращает код/строку 'timeout'. */
async function waitForExit(child, timeoutMs = 15000) {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code) => resolve(code))),
    sleep(timeoutMs).then(() => 'timeout'),
  ]);
}

function start(dir, port, extra = []) {
  const child = spawn(process.execPath, [BOOTSTRAP, '--data', dir, '--port', String(port), ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  return { child, log: () => output };
}

test('встроенный сервер поднимается, отдаёт health и state.json', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vision-emb-'));
  const port = await freePort();
  const { child } = start(dir, port);
  try {
    const health = await (await waitFor(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.embedded, true);
    assert.match(health.platform, /\w+\/\w+/);

    const state = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(state.phase, 'running');
    assert.equal(state.port, port);
    assert.equal(state.url, `http://127.0.0.1:${port}`);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    // после остановки состояние должно стать stopped — иначе приложение будет
    // считать сервер живым и показывать нерабочую ссылку
    const state = await waitForState(dir, 'stopped');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('загрузка файла, раздача с Range и удаление', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vision-emb-file-'));
  const port = await freePort();
  const { child } = start(dir, port);
  try {
    await waitFor(`http://127.0.0.1:${port}/api/health`);
    const body = Buffer.from('ID3-demo-audio-bytes');

    const put = await fetch(`http://127.0.0.1:${port}/api/files/library/demo.mp3`, { method: 'PUT', body });
    assert.equal(put.status, 201);
    assert.equal((await put.json()).size, body.length);

    // файл вне `library/` встроенный сервер не принимает
    const denied = await fetch(`http://127.0.0.1:${port}/api/files/escape.mp3`, { method: 'PUT', body });
    assert.equal(denied.status, 403);

    const list = await (await fetch(`http://127.0.0.1:${port}/api/files`)).json();
    assert.deepEqual(list.files.map((f) => f.name), ['library/demo.mp3']);

    const ranged = await fetch(`http://127.0.0.1:${port}/files/library/demo.mp3`, {
      headers: { Range: 'bytes=0-2' },
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 0-2/${body.length}`);
    assert.equal(await ranged.text(), 'ID3');

    const whole = await fetch(`http://127.0.0.1:${port}/files/library/demo.mp3`);
    assert.equal(await whole.text(), body.toString());

    // за пределами каталога данных ничего не отдаём
    const traversal = await fetch(`http://127.0.0.1:${port}/files/..%2F..%2Fetc%2Fpasswd`);
    assert.equal(traversal.status, 404);

    const del = await fetch(`http://127.0.0.1:${port}/api/files/library/demo.mp3`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(existsSync(path.join(dir, 'library', 'demo.mp3')), false);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('токен закрывает доступ, кроме health', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vision-emb-auth-'));
  const port = await freePort();
  const { child } = start(dir, port, ['--auth', 'secret-token']);
  try {
    // health открыт: по нему приложение понимает, что сервер жив
    const health = await (await waitFor(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.auth, true);

    assert.equal((await fetch(`http://127.0.0.1:${port}/api/files`)).status, 401);
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/api/files`, { headers: { Authorization: 'Bearer secret-token' } })).status,
      200,
    );
    // токен можно передать в ссылке — так удобнее открывать в браузере/WebView
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/files?token=secret-token`)).status, 200);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/shutdown останавливает сервер и пишет stopped', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vision-emb-stop-'));
  const port = await freePort();
  const { child } = start(dir, port);

  try {
    await waitFor(`http://127.0.0.1:${port}/api/health`);
    const response = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).stop, true);

    // процесс должен реально завершиться, иначе порт останется занятым
    const code = await waitForExit(child, 10000);
    assert.notEqual(code, 'timeout', 'сервер не завершился после /api/shutdown');
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')).phase, 'stopped');
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      /* уже остановлен */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('занятый порт даёт понятную ошибку, а не молчание', async () => {
  const dirA = mkdtempSync(path.join(tmpdir(), 'vision-emb-a-'));
  const dirB = mkdtempSync(path.join(tmpdir(), 'vision-emb-b-'));
  const port = await freePort();
  const first = start(dirA, port);
  let second;
  try {
    // Сначала дожидаемся, что первый сервер **уже слушает**, и только потом
    // запускаем второй. Иначе под нагрузкой гонка решается в пользу второго, он
    // занимает порт, а падает первый — и тест проверяет не то, что задумано.
    await waitForState(dirA, 'running');
    await waitFor(`http://127.0.0.1:${port}/api/health`);
    second = start(dirB, port);
    const state = await waitForState(dirB, 'failed');
    assert.equal(state.phase, 'failed');
    assert.match(state.error, /EADDRINUSE|address already in use/i);
  } finally {
    first.child.kill('SIGTERM');
    if (second) {
      try {
        second.child.kill('SIGTERM');
      } catch {
        /* второй процесс уже завершился сам */
      }
    }
    await Promise.all([waitForExit(first.child), second ? waitForExit(second.child) : Promise.resolve()]);
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});
