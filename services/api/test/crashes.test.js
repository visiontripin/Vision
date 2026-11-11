import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Crash-репортинг (Фаза 3, H5).
 *
 * Проверяем не «отчёт записался», а свойства, из-за которых такая штука либо
 * полезна, либо вредна: одинаковые падения схлопываются, разные — нет; отчёт
 * принимается **без токена** (приложение падает и до входа); сломанный цикл не
 * забивает диск (лимит частоты); чтение — только владельцу.
 *
 * Юнит-часть работает в собственной временной базе: тесты не должны оставлять
 * отчёты в рабочей библиотеке.
 */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const PORT = 4805;
const BASE = `http://127.0.0.1:${PORT}`;

const UNIT_DIR = mkdtempSync(path.join(tmpdir(), 'vision-crash-unit-'));
process.env.DATA_DIR = UNIT_DIR;
delete process.env.CRASH_RATE_PER_HOUR;

const { db } = await import('../src/connection.js');
const { runMigrations } = await import('../src/migrations/index.js');
await runMigrations({ quiet: true });

const { crashSummary, fingerprintOf, listCrashes, parseReport, pruneCrashes, recordCrash } =
  await import('../src/crashes.js');

const NOW = Date.parse('2026-11-11T20:00:00Z');

/* -------------------------------- правила --------------------------------- */

describe('отчёты о падениях: правила', () => {
  test('подпись: одинаковые падения — одна подпись, разные кадры — разные', () => {
    const a = fingerprintOf({
      name: 'TypeError',
      message: 'undefined is not a function',
      stack: 'TypeError: …\n    at playTrack (player.tsx:245:12)',
    });
    const b = fingerprintOf({
      name: 'TypeError',
      message: 'undefined is not a function',
      // другой путь сборки — тот же баг: адреса файлов не должны влиять
      stack: 'TypeError: …\n    at playTrack (file:///tmp/build/player.tsx:245:12)',
    });
    assert.equal(a, b);

    const other = fingerprintOf({
      name: 'TypeError',
      message: 'undefined is not a function',
      stack: 'TypeError: …\n    at openPlaylist (LibraryScreen.tsx:96:3)',
    });
    assert.notEqual(a, other, 'другой кадр — другой баг');
  });

  test('разбор: типы приводим к строкам, мусор не пролезает', () => {
    const report = parseReport({
      app: 'smartfridge',
      version: 1,
      name: 'Error',
      message: 'x'.repeat(2000),
      stack: 'y'.repeat(10_000),
      context: { screen: 'library', queueLength: 3 },
      deviceId: 'dev-1',
    });
    assert.equal(report.app, 'mobile', 'неизвестное приложение — mobile по умолчанию');
    assert.equal(report.version, '1');
    assert.ok(report.message.length <= 500);
    assert.ok(report.stack.length <= 6000);
    assert.match(report.context, /"screen":"library"/);
  });

  test('схлопывание: второе такое же падение увеличивает счётчик, а не создаёт запись', () => {
    const before = listCrashes().total;
    const report = {
      name: 'RangeError',
      message: 'invalid array length',
      stack: 'RangeError\n    at buildQueue (queue.ts:42:9)',
      deviceId: 'dev-a',
    };
    const first = recordCrash(report, { now: NOW });
    assert.equal(first.duplicate, false);
    assert.equal(first.count, 1);

    const second = recordCrash({ ...report, deviceId: 'dev-b' }, { now: NOW + 60_000 });
    assert.equal(second.duplicate, true);
    assert.equal(second.count, 2);
    assert.equal(listCrashes().total, before + 1, 'запись одна, а падений два');
  });

  test('лимит частоты: сломанный цикл забивает базу только лимитом в час', () => {
    /*
     * Лимит считается по *разным* падениям за час: первые 60 записываются,
     * дальше — отказ. Иначе один цикл в рендере выбил бы квоту за минуту, и
     * настоящее, новое падение уже не сохранилось бы.
     */
    const many = [];
    for (let i = 0; i < 70; i += 1) {
      many.push(recordCrash(
        { name: `Loop${i}`, message: 'сломанный рендер', deviceId: 'dev-loop' },
        { now: NOW + i * 1000 }
      ));
    }
    const accepted = many.filter((item) => item.accepted).length;
    assert.equal(accepted, 60, 'не больше лимита в час на установку');
    assert.equal(many.at(-1).reason, 'rate_limited');
    assert.equal(listCrashes({ app: 'mobile', limit: 1 }).total >= 60, true, 'записанные лежат в базе');
  });

  test('повтор того же падения квоту не съедает: новое падение запишется', () => {
    // 70 повторов одного и того же — это одна строка со счётчиком...
    for (let i = 0; i < 70; i += 1) {
      recordCrash({ name: 'Repeat', message: 'то же самое', deviceId: 'dev-repeat' }, { now: NOW });
    }
    // ...и лимит на другую установку не влияет вовсе
    const fresh = recordCrash({ name: 'Fresh', message: 'новое', deviceId: 'dev-fresh' }, { now: NOW });
    assert.equal(fresh.accepted, true);
    assert.equal(fresh.duplicate, false);
  });

  test('сводка честная: события, установки, без выдуманного «crash-free»', () => {
    const summary = crashSummary({ days: 7, now: NOW + 3_600_000 });
    assert.ok(summary.events > 0);
    assert.ok(summary.groups > 0);
    assert.ok(summary.devices >= 1);
    assert.equal(summary.byApp.length > 0, true);
    assert.ok(summary.byVersion.some((row) => row.version !== null));
    assert.equal(summary.hint, null);
  });

  test('пустая сводка подсказывает проверить сборку, а не молчит', () => {
    const summary = crashSummary({ days: 1, now: Date.parse('2030-01-01T00:00:00Z') });
    assert.equal(summary.events, 0);
    assert.match(summary.hint, /Падений нет/);
  });

  test('чистка оставляет окно хранения', () => {
    const before = listCrashes().total;
    assert.ok(before > 0);
    const removed = pruneCrashes({ keepDays: 1, now: NOW + 10 * 86_400_000 });
    assert.equal(removed.removed, before);
    assert.equal(listCrashes().total, 0);
  });

  test('битое тело не роняет приём: отчёт без полей всё равно записывается', () => {
    const result = recordCrash({}, { now: NOW });
    assert.equal(result.accepted, true);
    const list = listCrashes({ limit: 5 });
    assert.equal(list.items[0].name, null);
    assert.equal(list.items[0].fingerprint, 'Error::');
  });
});

/* ----------------------------- контракт API ------------------------------ */

let child;
let dataDir;
let token;

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/me`);
      if (res.status === 401 || res.status === 200) return;
    } catch {
      /* ещё поднимается */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('сервер не поднялся');
}

const auth = () => ({ Authorization: `Bearer ${token}`, 'content-type': 'application/json' });

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'vision-crash-api-'));
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
      BACKUP_EVERY_HOURS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  await waitForServer();

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'vision' }),
  });
  token = (await login.json()).token;
});

after(() => {
  child?.kill('SIGTERM');
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  rmSync(UNIT_DIR, { recursive: true, force: true });
});

describe('API отчётов о падениях', () => {
  test('приём БЕЗ токена: приложение падает и до входа', async () => {
    const res = await fetch(`${BASE}/api/crashes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        app: 'mobile',
        version: '0.5.0',
        platform: 'android',
        name: 'TypeError',
        message: 'undefined is not a function',
        stack: 'TypeError\n    at playTrack (player.tsx:245:12)',
        deviceId: 'phone-1',
        context: { screen: 'library' },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.accepted, true);
    assert.equal(body.duplicate, false);
  });

  test('повтор схлопывается, а не плодит записи', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${BASE}/api/crashes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'TypeError',
          message: 'undefined is not a function',
          stack: 'TypeError\n    at playTrack (player.tsx:245:12)',
          deviceId: `phone-${i}`,
        }),
      });
      assert.equal(res.status, 200);
    }
    const list = await (await fetch(`${BASE}/api/crashes`, { headers: auth() })).json();
    assert.equal(list.total, 1, 'одна группа падений');
    assert.equal(list.items[0].count, 4, 'одно + три повтора');
    assert.deepEqual(list.items[0].context, { screen: 'library' });
  });

  test('лента и сводка — только владельцу', async () => {
    assert.equal((await fetch(`${BASE}/api/crashes`)).status, 401);
    assert.equal((await fetch(`${BASE}/api/crashes/summary`)).status, 401);
    const summary = await (await fetch(`${BASE}/api/crashes/summary?days=7`, { headers: auth() })).json();
    assert.equal(summary.events, 4);
    assert.equal(summary.groups, 1);
    assert.equal(summary.hint, null);
  });

  test('фильтры по приложению и версии', async () => {
    const other = await fetch(`${BASE}/api/crashes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'web', version: '0.25.0', name: 'Error', message: 'в вебе' }),
    });
    assert.equal(other.status, 200);

    const onlyWeb = await (await fetch(`${BASE}/api/crashes?app=web`, { headers: auth() })).json();
    assert.equal(onlyWeb.total, 1);
    assert.equal(onlyWeb.items[0].app, 'web');

    const byVersion = await (await fetch(`${BASE}/api/crashes?version=0.5.0`, { headers: auth() })).json();
    assert.equal(byVersion.total, 1);
  });

  test('тело больше 16 КБ отвергается: отчёт — не способ забить диск', async () => {
    const res = await fetch(`${BASE}/api/crashes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Big', message: 'x'.repeat(64 * 1024), deviceId: 'flood' }),
    });
    // парсер тела режет по потолку — отвечаем 400, а не 500
    assert.ok([400, 413].includes(res.status), `статус ${res.status}`);
  });

  test('битый JSON — 400, не-GET/POST — 405, чистка — 200', async () => {
    const bad = await fetch(`${BASE}/api/crashes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{не json',
    });
    assert.equal(bad.status, 400);

    const put = await fetch(`${BASE}/api/crashes`, { method: 'PUT', headers: auth() });
    assert.equal(put.status, 405);

    const prune = await fetch(`${BASE}/api/crashes?keepDays=1`, { method: 'DELETE', headers: auth() });
    assert.equal(prune.status, 200);
    assert.ok((await prune.json()).removed >= 0);
  });

  test('чистка попадает в журнал действий', async () => {
    const audit = await (await fetch(`${BASE}/api/audit?action=crashes.prune`, { headers: auth() })).json();
    assert.ok(audit.entries.length >= 1);
    assert.match(audit.entries[0].label, /отчёты о падениях/);
  });
});
