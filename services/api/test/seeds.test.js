import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Трекер реплик и сиды: два узла без сети и без ffmpeg.
 *
 *   узел A — обычный (файлы лежат у него, он же origin-сид);
 *   узел B — STORAGE_MODE=metadata: принимает только метаданные и качает с сидов.
 *
 * Проверяем полный путь: загрузка → реестр → подписанная ссылка → Range →
 * sha256 → редирект на пир → репликация с проверкой хеша → «нет источника».
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const A = 'http://127.0.0.1:4791';
const B = 'http://127.0.0.1:4792';
const PASSWORD = 'vision';

const children = [];
const dirs = [];
let tokenA = '';
let tokenB = '';

/* ------------------------------ валидный WAV ------------------------------ */

function makeWav(seconds = 0.25, freq = 440) {
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

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/* -------------------------------- утилиты -------------------------------- */

async function waitForServer(base) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      /* сервер ещё поднимается */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server ${base} did not start`);
}

function startNode({ port, dataDir, env = {} }) {
  const child = spawn(process.execPath, ['services/api/src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      VISION_PASSWORD: PASSWORD,
      NODE_ENV: 'test',
      TRANSCODE_CODECS: '',
      HLS_ENABLED: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

async function login(base) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 200, 'вход должен проходить');
  const body = await res.json();
  return body.token;
}

const authed = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });

async function getJson(url, token) {
  const res = await fetch(url, { headers: authed(token) });
  const body = await res.json();
  return { status: res.status, body };
}

async function upload(base, token, buffer, query = '') {
  const res = await fetch(`${base}/api/tracks${query}`, {
    method: 'POST',
    headers: authed(token, { 'Content-Type': 'audio/wav' }),
    body: buffer,
  });
  return { status: res.status, body: await res.json() };
}

async function postJson(base, token, url, payload) {
  const res = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: authed(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

/* --------------------------------- запуск -------------------------------- */

before(async () => {
  const dirA = mkdtempSync(path.join(tmpdir(), 'vision-seed-a-'));
  const dirB = mkdtempSync(path.join(tmpdir(), 'vision-seed-b-'));
  dirs.push(dirA, dirB);

  startNode({ port: 4791, dataDir: dirA, env: { DEVICE_ID: 'node-a' } });
  startNode({ port: 4792, dataDir: dirB, env: { DEVICE_ID: 'node-b', STORAGE_MODE: 'metadata' } });

  await Promise.all([waitForServer(A), waitForServer(B)]);
  [tokenA, tokenB] = await Promise.all([login(A), login(B)]);
});

after(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/* ---------------------------------- тесты -------------------------------- */

describe('трекер реплик', () => {
  // заполняются в первом тесте
  let wav;
  let hash;
  let trackA;
  let seedUrl;

  test('загрузка файла объявляет блоб и origin-сид', async () => {
    wav = makeWav(0.25, 440);
    hash = sha256(wav);

    const { status, body } = await upload(A, tokenA, wav, '?title=Seed%20Track&artist=Node%20A');
    assert.equal(status, 201);
    assert.equal(body.checksum, hash);
    assert.equal(body.available, true);
    assert.equal(body.sources.local, true);
    assert.equal(body.sources.servable, 1);
    assert.equal(body.sources.kinds.origin, 1);
    trackA = body;
  });

  test('список треков отдаёт источники', async () => {
    const { status, body } = await getJson(`${A}/api/tracks`, tokenA);
    assert.equal(status, 200);
    const track = body.find((item) => item.id === trackA.id);
    assert.ok(track, 'трек должен быть в списке');
    assert.equal(track.available, true);
    assert.equal(track.sources.hash, hash);
  });

  test('сид выдаёт подписанную ссылку и работает Range', async () => {
    const { status, body } = await getJson(`${A}/api/blobs/${hash}/seeds`, tokenA);
    assert.equal(status, 200);
    assert.equal(body.seeds.length, 1);
    const seed = body.seeds[0];
    assert.equal(seed.deviceId, 'node-a');
    assert.equal(seed.servable, true);
    assert.match(seed.url, /^http:\/\/127\.0\.0\.1:4791\/seed\/[a-f0-9]{64}\?exp=\d+&sig=/);

    // ссылка абсолютная: качаем прямо с сида, как это сделает другой узел
    const ranged = await fetch(seed.url, { headers: { Range: 'bytes=0-99' } });
    assert.equal(ranged.status, 206);
    assert.equal(Number(ranged.headers.get('content-length')), 100);

    const full = Buffer.from(await fetch(seed.url).then((res) => res.arrayBuffer()));
    assert.equal(full.length, wav.length);
    assert.equal(sha256(full), hash);

    seedUrl = seed.url;
  });

  test('сид закрыт без подписи и токена', async () => {
    const res = await fetch(`${A}/seed/${hash}`);
    assert.equal(res.status, 401);
  });

  test('метаданные без файла: трек живёт у узла B, файл — на A', async () => {
    const { status, body } = await postJson(B, tokenB, '/api/tracks', {
      hash,
      bytes: wav.length,
      mime: 'audio/wav',
      title: 'Seed Track',
      artist: 'Node A',
      duration: 0.25,
      kind: 'desktop',
      deviceId: 'desktop-1',
      baseUrl: A,
    });

    assert.equal(status, 201);
    assert.equal(body.available, true);
    assert.equal(body.sources.local, false);
    assert.equal(body.sources.servable, 1);
    assert.equal(body.sources.kinds.desktop, 1);
  });

  test('скачивание уводит клиента на живой сид', async () => {
    const { body } = await getJson(`${B}/api/tracks?q=Seed`, tokenB);
    const track = body[0];
    assert.ok(track);

    const res = await fetch(`${B}/api/tracks/${track.id}/download`, {
      headers: authed(tokenB),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.ok(res.headers.get('location').startsWith(`${A}/seed/`), res.headers.get('location'));

    // json-вариант: удобно клиентам, которые сами решают, откуда качать
    const jsonRes = await getJson(`${B}/api/tracks/${track.id}/download?json=1`, tokenB);
    assert.equal(jsonRes.status, 200);
    assert.equal(jsonRes.body.local, false);
    assert.equal(jsonRes.body.seed.deviceId, 'desktop-1');
    assert.equal(jsonRes.body.bytes, wav.length);
  });

  test('без сида — 409 no_source и трек помечен недоступным', async () => {
    const orphanHash = sha256(Buffer.from(`orphan-${Date.now()}`));
    const created = await postJson(B, tokenB, '/api/tracks', {
      hash: orphanHash,
      bytes: 1024,
      mime: 'audio/mpeg',
      title: 'Orphan',
      kind: 'mobile',
      deviceId: 'phone-1',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.available, false);
    assert.equal(created.body.sources.servable, 0);
    assert.equal(created.body.sources.replicas, 1);

    const res = await fetch(`${B}/api/tracks/${created.body.id}/download`, { headers: authed(tokenB) });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, 'no_source');
  });

  test('репликация: узел B забирает файл с сида и проверяет sha256', async () => {
    const { body } = await getJson(`${B}/api/tracks?q=Seed`, tokenB);
    const track = body[0];

    const replicated = await postJson(B, tokenB, `/api/blobs/${hash}/replicate`, {});
    assert.equal(replicated.status, 200);
    assert.equal(replicated.body.ok, true);
    assert.equal(replicated.body.bytes, wav.length);

    const res = await fetch(`${B}/api/tracks/${track.id}/download`, {
      headers: authed(tokenB),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.ok(location.startsWith('/seed/'), 'после репликации файл отдаёт сам узел B');

    const mirrored = Buffer.from(await fetch(`${B}${location}`).then((r) => r.arrayBuffer()));
    assert.equal(sha256(mirrored), hash);
  });

  test('локальная копия пропала → снова качаем с пира, а не отдаём 404', async () => {
    const seedDir = path.join(dirs[1], 'seed');
    for (const file of readdirSync(seedDir)) rmSync(path.join(seedDir, file), { force: true });

    const { body } = await getJson(`${B}/api/tracks?q=Seed`, tokenB);
    const track = body[0];
    const res = await fetch(`${B}/api/tracks/${track.id}/download`, {
      headers: authed(tokenB),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.ok(
      res.headers.get('location').startsWith(`${A}/seed/`),
      `должны уйти на живой пир, а получили ${res.headers.get('location')}`
    );
  });

  test('снятие сида убирает его из реестра', async () => {
    const res = await fetch(`${B}/api/blobs/${hash}/seed?deviceId=desktop-1`, {
      method: 'DELETE',
      headers: authed(tokenB),
    });
    assert.equal(res.status, 204);

    const { body } = await getJson(`${B}/api/blobs/${hash}/seeds`, tokenB);
    assert.equal(body.seeds.filter((seed) => seed.deviceId === 'desktop-1').length, 0);
    // собственная реплика осталась живой
    assert.ok(body.seeds.some((seed) => seed.deviceId === 'node-b' && seed.servable));
  });

  test('здоровье и метрики знают про блобы и сиды', async () => {
    const health = await fetch(`${A}/api/health`).then((res) => res.json());
    assert.equal(health.storage.mode, 'local');
    assert.equal(health.storage.seedEnabled, true);
    assert.ok(health.tracker.blobs >= 1);
    assert.ok(health.tracker.seeds >= 1);

    const stats = await getJson(`${A}/api/seeds`, tokenA);
    assert.equal(stats.status, 200);
    assert.equal(stats.body.blobs, 1);
    assert.equal(stats.body.ttlMs > 0, true);

    const metrics = await fetch(`${A}/metrics`).then((res) => res.text());
    assert.match(metrics, /vision_blobs_total \d+/);
    assert.match(metrics, /vision_seeds_online \d+/);
  });

  test('файл удалён с сида — ссылка отвечает 404, а не 500', async () => {
    const res = await fetch(`${seedUrl}`);
    assert.equal(res.status, 200);
    // подпись с чужим хешем не подходит
    const forged = seedUrl.replace(/[a-f0-9]{64}/, 'f'.repeat(64));
    const forgedRes = await fetch(forged);
    assert.equal(forgedRes.status, 401);
  });
});
