import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 4789;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let dataDir;
let token = '';

/** Минимальный валидный WAV: 0.25 с, 8 кГц, моно. */
function makeWav(seconds = 0.25) {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.sin((i / sampleRate) * 2 * Math.PI * 440) * 0.4;
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return buffer;
}

const authed = (options = {}) => ({
  ...options,
  headers: {
    Authorization: `Bearer ${token}`,
    ...(options.headers || {}),
  },
});

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'vision-test-'));
  child = spawn(process.execPath, ['services/api/src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      VISION_PASSWORD: 'vision',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start')), 10000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Vision Audio API')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('Error')) {
        clearTimeout(timeout);
        reject(new Error(text));
      }
    });
  });
});

after(() => {
  child?.kill('SIGTERM');
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test('health отвечает без авторизации', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, 'string');
});

test('закрытые маршруты требуют токен', async () => {
  const res = await fetch(`${BASE}/api/tracks`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, 'unauthorized');
});

test('вход: неверный и верный пароль', async () => {
  const bad = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  assert.equal(bad.status, 401);

  const good = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'vision' }),
  });
  assert.equal(good.status, 200);
  const body = await good.json();
  assert.ok(body.token.length > 20);
  token = body.token;
});

test('загрузка аудио: метаданные, peaks, отказ не-аудио', async () => {
  const peaks = JSON.stringify([0.1, 0.5, 0.9, 0.3]);
  const query = new URLSearchParams({
    title: 'Test Tone',
    artist: 'Unit Test',
    genre: 'Test',
    duration: '0.25',
    peaks,
  });

  const res = await fetch(`${BASE}/api/tracks?${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/wav' },
    body: makeWav(),
  });
  assert.equal(res.status, 201);
  const track = await res.json();
  assert.equal(track.title, 'Test Tone');
  assert.equal(track.mime, 'audio/wav');
  assert.deepEqual(track.peaks, [0.1, 0.5, 0.9, 0.3]);

  const bad = await fetch(`${BASE}/api/tracks?title=Bad`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/mpeg' },
    body: Buffer.from('это точно не аудио, а обычный текст'.repeat(20)),
  });
  assert.equal(bad.status, 415);
  assert.equal((await bad.json()).error.code, 'unsupported_type');
});

test('список и детали трека', async () => {
  const list = await fetch(`${BASE}/api/tracks`, { headers: { Authorization: `Bearer ${token}` } });
  const tracks = await list.json();
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].peaks, null, 'в списке peaks не отдаются');

  const detail = await fetch(`${BASE}/api/tracks/${tracks[0].id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const track = await detail.json();
  assert.equal(track.peaks.length, 4);
});

test('стриминг поддерживает Range и требует авторизацию', async () => {
  const list = await (await fetch(`${BASE}/api/tracks`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const id = list[0].id;
  const full = makeWav();

  const unauthorized = await fetch(`${BASE}/api/tracks/${id}/stream`);
  assert.equal(unauthorized.status, 401);

  const range = await fetch(`${BASE}/api/tracks/${id}/stream`, {
    headers: { Authorization: `Bearer ${token}`, Range: 'bytes=100-199' },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 100-199/${full.length}`);
  const chunk = Buffer.from(await range.arrayBuffer());
  assert.equal(chunk.length, 100);
  assert.deepEqual(chunk, full.subarray(100, 200));

  const invalid = await fetch(`${BASE}/api/tracks/${id}/stream`, {
    headers: { Authorization: `Bearer ${token}`, Range: `bytes=${full.length + 10}-` },
  });
  assert.equal(invalid.status, 416);

  // токен в query — для <audio>/<img>, которые не умеют заголовки
  const queryAuth = await fetch(`${BASE}/api/tracks/${id}/stream?token=${encodeURIComponent(token)}`, {
    headers: { Range: 'bytes=0-9' },
  });
  assert.equal(queryAuth.status, 206);
});

test('лайк и счётчик прослушиваний', async () => {
  const [track] = await (await fetch(`${BASE}/api/tracks`, { headers: { Authorization: `Bearer ${token}` } })).json();

  const patched = await fetch(`${BASE}/api/tracks/${track.id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ liked: true }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).liked, true);

  const play = await fetch(`${BASE}/api/tracks/${track.id}/play`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(play.status, 204);

  const stats = await (await fetch(`${BASE}/api/stats`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(stats.plays, 1);
  assert.equal(stats.liked, 1);
});

test('плейлисты: создание, добавление, удаление', async () => {
  const [track] = await (await fetch(`${BASE}/api/tracks`, { headers: { Authorization: `Bearer ${token}` } })).json();

  const created = await fetch(`${BASE}/api/playlists`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Вечер' }),
  });
  assert.equal(created.status, 201);
  const playlist = await created.json();

  const add = await fetch(`${BASE}/api/playlists/${playlist.id}/tracks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackId: track.id }),
  });
  assert.equal(add.status, 204);

  const list = await (await fetch(`${BASE}/api/playlists`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(list[0].trackCount, 1);

  const tracks = await (
    await fetch(`${BASE}/api/playlists/${playlist.id}/tracks`, { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  assert.equal(tracks.length, 1);

  const remove = await fetch(`${BASE}/api/playlists/${playlist.id}/tracks/${track.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(remove.status, 204);

  const removePlaylist = await fetch(`${BASE}/api/playlists/${playlist.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(removePlaylist.status, 204);
});

test('удаление трека убирает файл и запись', async () => {
  const [track] = await (await fetch(`${BASE}/api/tracks`, { headers: { Authorization: `Bearer ${token}` } })).json();

  const removed = await fetch(`${BASE}/api/tracks/${track.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(removed.status, 204);

  const missing = await fetch(`${BASE}/api/tracks/${track.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(missing.status, 404);
});
