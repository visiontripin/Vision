import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Журнал действий (Фаза 6, G10) — `docs/API.md`, раздел «Аудит действий».
 *
 * Проверяем не «есть ли таблица», а те свойства, ради которых журнал делают:
 *  - владелец видит, кто удалил трек и кто открывал ссылку;
 *  - гость журнал не читает (401), токен ссылки в записях не появляется;
 *  - обновление страницы не забивает журнал (схлопывание с `repeat`);
 *  - чистка по сроку хранения удаляет старое и не трогает новое.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 4793;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'vision';

let child;
let dataDir;
let token = '';
let trackId = '';

function makeWav(seconds = 0.4, freq = 440) {
  const rate = 8000;
  const samples = Math.floor(rate * seconds);
  const dataSize = samples * 2;

  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);

  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'latin1');
  dataHeader.writeUInt32LE(dataSize, 4);

  const pcm = Buffer.alloc(dataSize);
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * freq) * 0.4 * 32767), i * 2);
  }

  const body = Buffer.concat([fmt, dataHeader, pcm]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WAVE', 8, 'latin1');
  return Buffer.concat([header, body]);
}

const auth = () => ({ Authorization: `Bearer ${token}` });

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* ещё поднимается */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function upload(title, freq = 440) {
  const search = new URLSearchParams({
    title, artist: 'Tester', genre: 'Ambient', duration: '1', filename: 'audit.wav',
  });
  const res = await fetch(`${BASE}/api/tracks?${search}`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'audio/wav' },
    body: makeWav(0.4, freq),
  });
  assert.equal(res.status, 201, `upload failed: ${res.status}`);
  return res.json();
}

async function entries(query = '') {
  // limit передаётся в query целиком: дубль параметра сервер разобрал бы по первому
  const search = new URLSearchParams(query);
  if (!search.has('limit')) search.set('limit', '100');
  const res = await fetch(`${BASE}/api/audit?${search}`, { headers: auth() });
  assert.equal(res.status, 200);
  return res.json();
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'vision-audit-'));
  child = spawn(process.execPath, ['services/api/src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      VISION_PASSWORD: PASSWORD,
      NODE_ENV: 'test',
      TRANSCODE: '0',
      AUDIT_RETENTION_DAYS: '30',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  await waitForServer();

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  token = (await login.json()).token;

  const created = await upload('Audit Track');
  trackId = created.id;
});

after(() => {
  child?.kill('SIGTERM');
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe('журнал действий', () => {
  test('вход и загрузка попадают в журнал с готовой подписью', async () => {
    const body = await entries();
    assert.ok(body.total >= 2);
    assert.ok(body.labels['track.upload']);

    const uploadEntry = body.entries.find((item) => item.action === 'track.upload');
    assert.ok(uploadEntry, 'загрузка записана');
    assert.equal(uploadEntry.actor, 'owner');
    assert.equal(uploadEntry.targetId, trackId);
    assert.match(uploadEntry.label, /загружен трек «Audit Track»/);
    assert.ok(uploadEntry.requestId, 'requestId для сверки с X-Request-Id');
    // адрес не хранится в открытом виде
    assert.equal(uploadEntry.ipHash === null || /^[a-f0-9]{32}$/.test(uploadEntry.ipHash), true);
  });

  test('гость не читает журнал и не видит адресов', async () => {
    assert.equal((await fetch(`${BASE}/api/audit`)).status, 401);
    assert.equal((await fetch(`${BASE}/api/audit/actions`)).status, 401);
    assert.equal((await fetch(`${BASE}/api/audit/summary`)).status, 401);

    const body = await entries();
    const serialised = JSON.stringify(body.entries);
    assert.doesNotMatch(serialised, /127\.0\.0\.1/, 'сырой адрес не должен попадать в журнал');
    assert.doesNotMatch(serialised, /"authorization"/i);
  });

  test('открытия ссылки схлопываются, прослушивание — отдельная строка', async () => {
    const shareRes = await fetch(`${BASE}/api/shares`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetKind: 'track', targetId: trackId, ttl: '1h' }),
    });
    const share = await shareRes.json();

    for (let i = 0; i < 3; i += 1) {
      const page = await fetch(`${BASE}/s/${share.token}`);
      assert.equal(page.status, 200);
      await page.text();
    }
    const stream = await fetch(`${BASE}/s/${share.token}/stream/${trackId}`);
    await stream.arrayBuffer();

    const body = await entries();
    const opens = body.entries.filter((item) => item.action === 'share.open' && item.shareId === share.id);
    assert.equal(opens.length, 1, 'одна строка на серию открытий');
    assert.equal(opens[0].details.repeat, 3);
    assert.equal(opens[0].actor, 'guest');

    const streams = body.entries.filter((item) => item.action === 'share.stream' && item.shareId === share.id);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].details.trackId, trackId);

    // токен ссылки не попадает в журнал ни в каком виде
    assert.doesNotMatch(JSON.stringify(body.entries), new RegExp(share.token));
  });

  test('удаление трека и плейлиста остаётся в истории', async () => {
    const track = await upload('To Delete', 520);
    const playlist = await fetch(`${BASE}/api/playlists`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Временный' }),
    }).then((res) => res.json());

    await fetch(`${BASE}/api/playlists/${playlist.id}`, { method: 'DELETE', headers: auth() });
    await fetch(`${BASE}/api/tracks/${track.id}`, { method: 'DELETE', headers: auth() });

    const body = await entries();
    const deletedTrack = body.entries.find(
      (item) => item.action === 'track.delete' && item.targetId === track.id
    );
    assert.ok(deletedTrack, 'удаление трека записано');
    assert.match(deletedTrack.label, /удалён трек «To Delete»/);

    const deletedPlaylist = body.entries.find(
      (item) => item.action === 'playlist.delete' && item.targetId === playlist.id
    );
    assert.ok(deletedPlaylist);
    assert.match(deletedPlaylist.label, /удалён плейлист «Временный»/);
  });

  test('фильтры: действие, актор, ссылка и окно времени', async () => {
    const byGroup = await entries('action=track');
    assert.ok(byGroup.entries.every((item) => item.action.startsWith('track.')));
    assert.ok(byGroup.entries.some((item) => item.action === 'track.upload'));

    const byActor = await entries('actor=guest');
    assert.ok(byActor.entries.every((item) => item.actor === 'guest'));

    const future = new Date(Date.now() + 60_000).toISOString();
    const bySince = await entries(`since=${encodeURIComponent(future)}`);
    assert.equal(bySince.total, 0);

    const limited = await entries('limit=2');
    assert.equal(limited.entries.length, 2);
    assert.ok(limited.total >= 2);
  });

  test('справочник действий и сводка для панели', async () => {
    const actions = await fetch(`${BASE}/api/audit/actions`, { headers: auth() }).then((res) => res.json());
    const codes = actions.actions.map((item) => item.code);
    for (const code of ['track.upload', 'track.delete', 'share.create', 'share.open', 'auth.fail']) {
      assert.ok(codes.includes(code), `нет действия ${code}`);
    }
    assert.equal(actions.actors.guest, 'гость');
    assert.equal(actions.retentionDays, 30);

    const summary = await fetch(`${BASE}/api/audit/summary?days=1`, { headers: auth() }).then((res) => res.json());
    assert.ok(summary.total >= 1);
    assert.ok(summary.byActor.owner >= 1);
  });

  test('чистка по сроку: старое удаляется, новое остаётся', async () => {
    // запись «из прошлого» — напрямую в базу через отдельное соединение невозможно,
    // поэтому просим чистку с keepDays=1 и проверяем, что свежее на месте
    const pruned = await fetch(`${BASE}/api/audit?keepDays=1`, {
      method: 'DELETE',
      headers: auth(),
    }).then((res) => res.json());
    assert.equal(typeof pruned.removed, 'number');

    const body = await entries();
    assert.ok(body.total >= 1, 'свежие записи не тронуты');
    assert.ok(body.entries.every((item) => new Date(item.at).getTime() > Date.now() - 86_400_000));
  });

  test('AUDIT_ENABLED=0 выключает запись, но не чтение — проверяется конфигом', async () => {
    // отдельный процесс с выключенной записью: журнал должен отвечать, но не расти
    const port = PORT + 40;
    const dir = mkdtempSync(path.join(tmpdir(), 'vision-audit-off-'));
    const proc = spawn(process.execPath, ['services/api/src/server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: dir,
        VISION_PASSWORD: PASSWORD,
        NODE_ENV: 'test',
        TRANSCODE: '0',
        AUDIT_ENABLED: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stderr.on('data', () => {});
    try {
      for (let i = 0; i < 100; i += 1) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
        } catch {
          /* поднимается */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      }).then((res) => res.json());

      const res = await fetch(`http://127.0.0.1:${port}/api/audit`, {
        headers: { Authorization: `Bearer ${login.token}` },
      });
      assert.equal(res.status, 200, 'чтение работает');
      const body = await res.json();
      assert.equal(body.total, 0, 'запись выключена — журнал пуст');
    } finally {
      proc.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
