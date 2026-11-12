import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Общая библиотека между устройствами — главный сценарий владельца:
 * «загрузил пять песен на одном телефоне, на другом сразу вижу их в ленте».
 *
 * Проверяем именно то, что нельзя увидеть в юнит-тестах: два устройства говорят
 * с реестром по сети, метаданные доходят, файл скачивается с поддержкой Range
 * (без неё не работает перемотка), а чужое устройство без токена ничего не видит.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 4812;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let dataDir;
let token = '';

/** Файл-фикстура: настоящий WAV, чтобы проверить и байты, и Range. */
function makeWav(seconds = 0.2) {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(dataSize, 40);
  const body = Buffer.alloc(dataSize);
  for (let index = 0; index < samples; index += 1) {
    body.writeInt16LE(Math.round(Math.sin((index / sampleRate) * 440 * 2 * Math.PI) * 8000), index * 2);
  }
  return Buffer.concat([header, body]);
}

const auth = () => ({ Authorization: `Bearer ${token}` });

async function declare(device, tracks) {
  const response = await fetch(`${BASE}/api/library`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ device, tracks }),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'vision-library-'));
  child = spawn(process.execPath, ['services/api/src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, VISION_PASSWORD: 'vision', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start')), 20000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('server started')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited: ${code}`)));
  });

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'vision' }),
  });
  token = (await login.json()).token;
});

after(() => {
  child?.kill('SIGTERM');
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test('устройство B видит треки устройства A сразу после загрузки', async () => {
  const deviceA = { id: 'dev-a', name: 'Телефон A', at: Date.now() };
  const tracks = [
    { id: 'track-1', title: 'Вечер', artist: 'Кто-то', duration: 200, mime: 'audio/mpeg', bytes: 1000, updatedAt: Date.now() },
    { id: 'track-2', title: 'Утро', artist: 'Другой', duration: 180, mime: 'audio/mpeg', bytes: 2000, updatedAt: Date.now() },
  ];

  const fromA = await declare(deviceA, tracks);
  assert.equal(fromA.status, 200);
  assert.equal(fromA.body.accepted, 2);
  assert.equal(fromA.body.rejected, 0);

  // Второе устройство отмечается и забирает снимок реестра
  const fromB = await declare({ id: 'dev-b', name: 'Телефон B', at: Date.now() }, []);
  assert.equal(fromB.status, 200);

  const seen = fromB.body.tracks.map((track) => track.id).sort();
  assert.deepEqual(seen, ['track-1', 'track-2']);
  assert.equal(fromB.body.devices.length, 2);
  // Файлов пока нет — треки видны, но не скачиваются, и это честно помечено
  assert.equal(fromB.body.tracks.every((track) => track.downloadable === false), true);
});

test('файл загружается один раз и скачивается с любого устройства, с Range', async () => {
  const wav = makeWav(0.2);

  const uploaded = await fetch(`${BASE}/api/library/track-1/file`, {
    method: 'PUT',
    headers: { ...auth(), 'Content-Type': 'audio/wav' },
    body: wav,
  });
  assert.equal(uploaded.status, 200);
  const body = await uploaded.json();
  assert.equal(body.bytes, wav.length);
  assert.match(body.checksum, /^[a-f0-9]{64}$/);

  // Снимок теперь говорит, что файл есть
  const snapshot = await fetch(`${BASE}/api/library`, { headers: auth() });
  const registry = await snapshot.json();
  assert.equal(registry.tracks.find((track) => track.id === 'track-1').downloadable, true);
  assert.equal(registry.published['track-1'], true);

  // Скачивание целиком
  const whole = await fetch(`${BASE}/api/library/track-1/file`, { headers: auth() });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  const downloaded = Buffer.from(await whole.arrayBuffer());
  assert.equal(downloaded.length, wav.length);
  assert.deepEqual(downloaded.subarray(0, 4), Buffer.from('RIFF', 'latin1'));

  // Частичное скачивание — без него не работает перемотка в плеере
  const partial = await fetch(`${BASE}/api/library/track-1/file`, {
    headers: { ...auth(), Range: 'bytes=0-99' },
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 0-99/${wav.length}`);
  assert.equal((await partial.arrayBuffer()).byteLength, 100);
});

test('multipart с телефона принимается так же, как тело-файл', async () => {
  const wav = makeWav(0.1);
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'track-2.wav');

  const response = await fetch(`${BASE}/api/library/track-2/file`, {
    method: 'PUT',
    headers: auth(),
    body: form,
  });
  assert.equal(response.status, 200);
  const saved = await response.json();
  // Метаданные multipart не должны попасть в файл: размер совпадает с исходным
  assert.equal(saved.bytes, wav.length);

  const again = await fetch(`${BASE}/api/library/track-2/file`, { headers: auth() });
  assert.equal((await again.arrayBuffer()).byteLength, wav.length);
});

test('без токена реестр закрыт: это личная библиотека, а не каталог в Wi-Fi', async () => {
  const anonymous = await fetch(`${BASE}/api/library`);
  assert.equal(anonymous.status, 401);

  const put = await fetch(`${BASE}/api/library/track-1/file`, { method: 'PUT', body: makeWav(0.1) });
  assert.equal(put.status, 401);

  const missing = await fetch(`${BASE}/api/library/нет-такого/file`, { headers: auth() });
  assert.equal(missing.status, 404);
});

test('битые записи не валят синхронизацию: считаем принятые и отклонённые', async () => {
  const result = await declare(
    { id: 'dev-c', name: 'Телефон C', at: Date.now() },
    [
      { id: 'ok-1', title: 'Норм', duration: 10, updatedAt: Date.now() },
      { id: '', title: 'Без id' },
      { id: 'no-title', title: '   ' },
    ]
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.accepted, 1);
  assert.equal(result.body.rejected, 2);
});
