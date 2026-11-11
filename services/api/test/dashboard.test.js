import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/*
 * Юнит-часть пишет события в базу, поэтому у неё **своя** временная база, а не
 * `data/vision.db` репозитория: тест не должен оставлять мусор в рабочей
 * библиотеке (и не должен зависеть от того, что в ней уже накопилось).
 * `DATA_DIR` выставляется до динамического импорта — статический импорт открыл бы
 * базу раньше, чем мы успели бы это сделать.
 */
const UNIT_DIR = mkdtempSync(path.join(tmpdir(), 'vision-dashboard-unit-'));
process.env.DATA_DIR = UNIT_DIR;

const { PLAY_DEDUPE_MS, dashboard, logPlayback } = await import('../src/dashboard.js');

/**
 * Дашборд владельца (Фаза 5, D1).
 *
 * Правила проверяются на прямых вызовах с фиксированным `now` — иначе тест
 * зависел бы от календаря машины и от часового пояса. Контракт API проверяется
 * отдельно, живыми прослушиваниями: важен не только агрегат, но и то, что
 * прослушивание попадает в дашборд **один** раз, а не на каждом тике плеера.
 */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const PORT = 4797;
const BASE = `http://127.0.0.1:${PORT}`;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-11T20:00:00Z');

/* ------------------------ модульные проверки ------------------------------ */

describe('дашборд: правила', () => {
  test('пустой журнал — нули и подсказка, а не пустой объект', () => {
    const data = dashboard({ now: NOW, days: 7 });
    assert.equal(data.totals.plays, 0);
    assert.equal(data.totals.listeners, 0);
    assert.deepEqual(data.topTracks, []);
    assert.match(data.hint, /Прослушиваний пока нет/);
    // дни заполнены нулями: график не должен «склеивать» паузы
    assert.ok(data.byDay.length >= 7, `дней: ${data.byDay.length}`);
    assert.ok(data.byDay.every((day) => day.plays === 0));
  });

  test('дедупликация: повтор в окне 30 минут не накручивает график', () => {
    const at = new Date(NOW - 2 * 3600_000).toISOString();
    const first = logPlayback({ trackId: 'dedupe', at });
    assert.equal(first.recorded, true);

    const again = logPlayback({
      trackId: 'dedupe',
      at: new Date(Date.parse(at) + PLAY_DEDUPE_MS - 60_000).toISOString(),
    });
    assert.equal(again.recorded, false);
    assert.equal(again.reason, 'duplicate');

    // после окна — снова считается
    const later = logPlayback({
      trackId: 'dedupe',
      at: new Date(Date.parse(at) + PLAY_DEDUPE_MS + 60_000).toISOString(),
    });
    assert.equal(later.recorded, true);

    // `complete` не дедуплицируется: «дослушал» — факт, а не повтор
    assert.equal(logPlayback({ trackId: 'dedupe', kind: 'complete', at }).recorded, true);
  });

  test('дни группируются по локальному смещению', () => {
    // 23:30 UTC 10 ноября — в Амстердаме это уже 11-е (UTC+1)
    const late = '2026-11-10T23:30:00Z';
    logPlayback({ trackId: 'tz', at: late });
    const utc = dashboard({ now: NOW, days: 3, tz: 0 });
    const ams = dashboard({ now: NOW, days: 3, tz: 60 });
    const pick = (data, day) => data.byDay.find((item) => item.day === day)?.plays ?? 0;
    assert.equal(pick(utc, '2026-11-10'), 1);
    assert.equal(pick(ams, '2026-11-11') >= 1, true);
    assert.equal(pick(utc, '2026-11-11') != pick(ams, '2026-11-11'), true);
  });

  test('топ-треки и источники разделены', () => {
    logPlayback({ trackId: 'owner-a', at: '2026-11-09T10:00:00Z' });
    logPlayback({ trackId: 'owner-a', at: '2026-11-09T12:00:00Z' });
    logPlayback({ trackId: 'share-a', source: 'share', at: '2026-11-09T13:00:00Z' });

    const data = dashboard({ now: NOW, days: 30, tz: 0 });
    const top = data.topTracks.find((item) => item.id === 'owner-a');
    assert.equal(top.plays, 2);
    // трека нет в библиотеке — в топе он помечен удалённым, но не выброшен
    assert.equal(top.deleted, true);
    assert.equal(data.sources.share >= 1, true);
    assert.equal(data.totals.sharedPlays >= 1, true);
  });

  test('событие без адреса не считается слушателем', () => {
    const before = dashboard({ now: NOW, days: 30, tz: 0 }).totals.listeners;
    logPlayback({ trackId: 'no-ip', at: '2026-11-08T10:00:00Z' });
    const after = dashboard({ now: NOW, days: 30, tz: 0 }).totals.listeners;
    assert.equal(after, before);
  });

  test('битые входы не пишутся в журнал', () => {
    assert.equal(logPlayback({}).recorded, false);
    assert.equal(logPlayback({ trackId: 'x', at: 'не дата' }).recorded, false);
  });
});

/* --------------------------- контракт API -------------------------------- */

function wav({ seconds = 0.2, seed = 1 } = {}) {
  const rate = 8000;
  const samples = Math.max(1, Math.floor(rate * seconds));
  const data = samples * 2;
  const buffer = Buffer.alloc(44 + data);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(36 + data, 4);
  buffer.write('WAVE', 8, 'latin1');
  buffer.write('fmt ', 12, 'latin1');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'latin1');
  buffer.writeUInt32LE(data, 40);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE((Math.sin((i * (1 + (seed % 5))) / 20) * 8000) | 0, 44 + i * 2);
  }
  return buffer;
}

let child;
let dataDir;
let token;

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/me`);
      if (res.status === 401 || res.status === 200) return;
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('сервер не поднялся');
}

const auth = () => ({ Authorization: `Bearer ${token}`, 'content-type': 'application/json' });

async function upload(track, seed) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(track)) query.set(key, String(value));
  const res = await fetch(`${BASE}/api/tracks?${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/wav' },
    body: wav({ seconds: 0.2, seed }),
  });
  if (res.status !== 201) throw new Error(`upload ${res.status}: ${await res.text()}`);
  return res.json();
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'vision-dashboard-'));
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

describe('API дашборда', () => {
  test('пустая библиотека: нули, подсказка, дни без дыр', async () => {
    const res = await fetch(`${BASE}/api/dashboard?days=7`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.totals.plays, 0);
    assert.match(body.hint, /Прослушиваний пока нет/);
    assert.equal(body.days, 7);
    assert.equal(body.byDay.length, 8, 'семь дней окна + сегодня');
  });

  test('прослушивание попадает в дашборд один раз', async () => {
    const track = await upload({ title: 'Slow Tide', artist: 'Vision Labs', genre: 'Ambient', duration: 300 }, 1);
    for (const position of [10, 20, 30]) {
      const res = await fetch(`${BASE}/api/tracks/${track.id}/listen`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ position, duration: 300, completed: false }),
      });
      assert.equal(res.status, 204);
    }

    const body = await (await fetch(`${BASE}/api/dashboard`, { headers: auth() })).json();
    assert.equal(body.totals.plays, 1, 'три тика плеера — одно прослушивание');
    assert.equal(body.totals.tracks, 1);
    const top = body.topTracks[0];
    assert.equal(top.id, track.id);
    assert.equal(top.title, 'Slow Tide');
    assert.equal(top.plays, 1);
    assert.equal(body.sources.owner, 1);
  });

  test('дослушанный трек считается отдельно', async () => {
    const all = await (await fetch(`${BASE}/api/tracks?limit=10`, { headers: auth() })).json();
    const track = all.find((item) => item.title === 'Slow Tide');
    // сдвигаем окно дедупликации: перематываем событие в прошлое
    await fetch(`${BASE}/api/tracks/${track.id}/listen`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ position: 300, duration: 300, completed: true }),
    });
    const body = await (await fetch(`${BASE}/api/dashboard`, { headers: auth() })).json();
    assert.equal(body.totals.completed, 1);
    assert.equal(body.topTracks[0].completed, 1);
  });

  test('гостю дашборд недоступен, не-GET — 405', async () => {
    assert.equal((await fetch(`${BASE}/api/dashboard`)).status, 401);
    const res = await fetch(`${BASE}/api/dashboard`, { method: 'DELETE', headers: auth() });
    assert.equal(res.status, 405);
  });

  test('days ограничен: 1…365, мусор не ломает', async () => {
    const one = await (await fetch(`${BASE}/api/dashboard?days=1`, { headers: auth() })).json();
    assert.equal(one.days, 1);
    const huge = await (await fetch(`${BASE}/api/dashboard?days=9999`, { headers: auth() })).json();
    assert.equal(huge.days, 365);
    const junk = await (await fetch(`${BASE}/api/dashboard?days=abc`, { headers: auth() })).json();
    assert.equal(junk.days, 30);
  });
});
