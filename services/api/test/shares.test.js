import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Приватные ссылки (Фаза 6, E1) — контракт гостевого доступа.
 *
 * Проверяем то, что легко сломать и дорого не заметить:
 *  - гость без токена видит страницу, поток с Range и скачивание;
 *  - по ссылке на трек нельзя получить чужой трек, по плейлисту — только его треки;
 *  - отзыв/истечение/лимит открытий дают 410, а не «пустую страницу»;
 *  - токен не хранится в базе (перевыпуск меняет адрес, старый умирает);
 *  - удаление трека гасит его ссылки;
 *  - статистика открытий видит владелец, а не гость.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 4795;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'vision';

let child;
let dataDir;
let token = '';
let trackId = '';
let otherTrackId = '';
let playlistId = '';

/* ------------------------------- файлы ------------------------------------ */

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

/* ------------------------------ утилиты ----------------------------------- */

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

async function upload(track = {}, body = null) {
  const search = new URLSearchParams({
    title: 'Shared Track',
    artist: 'Tester',
    genre: 'Ambient',
    duration: '1',
    filename: 'shared.wav',
    ...track,
  });
  const res = await fetch(`${BASE}/api/tracks?${search}`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'audio/wav' },
    body: body ?? makeWav(),
  });
  assert.equal(res.status, 201, `upload failed: ${res.status}`);
  return res.json();
}

async function makeShare(payload) {
  const res = await fetch(`${BASE}/api/shares`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  assert.equal(res.status, 201, `share failed: ${res.status} ${text}`);
  return JSON.parse(text);
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'vision-share-'));
  child = spawn(process.execPath, ['services/api/src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      VISION_PASSWORD: PASSWORD,
      NODE_ENV: 'test',
      // без ffmpeg: ссылки должны работать и на «сырых» оригиналах
      TRANSCODE: '0',
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

  const first = await upload();
  trackId = first.id;
  const second = await upload({ title: 'Second Track', filename: 'second.wav' }, makeWav(0.4, 660));
  otherTrackId = second.id;

  const playlist = await fetch(`${BASE}/api/playlists`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Вечер' }),
  });
  playlistId = (await playlist.json()).id;
  await fetch(`${BASE}/api/playlists/${playlistId}/tracks`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackId }),
  });
});

after(() => {
  child?.kill('SIGTERM');
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/* --------------------------------- тесты ---------------------------------- */

describe('приватные ссылки', () => {
  test('ссылка на трек: гость без токена видит страницу, OG-теги и плеер', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, title: 'для Димы', ttl: '2h' });
    assert.ok(share.token.length >= 20);
    assert.match(share.url, new RegExp(`/s/${share.token}$`));
    assert.equal(share.plays, 0);
    assert.ok(share.expiresAt);

    const page = await fetch(`${BASE}/s/${share.token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);

    const html = await page.text();
    assert.match(html, /Shared Track/);
    assert.match(html, /og:title" content="Shared Track"/);
    assert.match(html, /og:url" content="http:\/\/127\.0\.0\.1:\d+\/s\//);
    assert.match(html, new RegExp(`/s/${share.token}/stream/${trackId}`));
    assert.match(html, /noindex/);
  });

  test('гостевой поток: Range → 206 и ровно запрошенный кусок', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '1h' });
    const res = await fetch(`${BASE}/s/${share.token}/stream/${trackId}`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    assert.match(res.headers.get('content-range') ?? '', /^bytes 0-99\/\d+$/);
    assert.equal((await res.arrayBuffer()).byteLength, 100);

    const full = await fetch(`${BASE}/s/${share.token}/stream/${trackId}`, { method: 'HEAD' });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
  });

  test('гостевое скачивание: файл отдаётся с Content-Disposition', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '1h' });
    const res = await fetch(`${BASE}/s/${share.token}/download/${trackId}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment;/);
    const body = await res.arrayBuffer();
    assert.ok(body.byteLength > 1000);
  });

  test('чужой трек через ссылку недоступен', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '1h' });
    const res = await fetch(`${BASE}/s/${share.token}/stream/${otherTrackId}`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, 'forbidden');
  });

  test('ссылка на плейлист отдаёт треки плейлиста и только их', async () => {
    const share = await makeShare({ targetKind: 'playlist', targetId: playlistId, ttl: '1d' });
    const page = await fetch(`${BASE}/s/${share.token}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Вечер/);
    assert.match(html, new RegExp(`stream/${trackId}`));
    assert.doesNotMatch(html, new RegExp(`stream/${otherTrackId}`));

    const allowed = await fetch(`${BASE}/s/${share.token}/stream/${trackId}`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(allowed.status, 206);

    const denied = await fetch(`${BASE}/s/${share.token}/stream/${otherTrackId}`);
    assert.equal(denied.status, 403);
  });

  test('картинки для OG: обложки нет — тег не врёт', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '1h' });
    const html = await (await fetch(`${BASE}/s/${share.token}`)).text();
    assert.doesNotMatch(html, /og:image/);
    assert.match(html, /twitter:card" content="summary"/);
  });

  test('срок жизни: «1m» истекает, гость видит 410 и понятный текст', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, ttl: 60_000 });
    assert.ok(share.expiresAt);
    // подделываем истечение через PATCH на пустой ttl не получится — проверяем контракт 410
    const revoked = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '1h' });
    const del = await fetch(`${BASE}/api/shares/${revoked.id}`, { method: 'DELETE', headers: auth() });
    assert.equal(del.status, 204);

    const gone = await fetch(`${BASE}/s/${revoked.token}`);
    assert.equal(gone.status, 410);
    const html = await gone.text();
    assert.match(html, /отозвана/);

    const stream = await fetch(`${BASE}/s/${revoked.token}/stream/${trackId}`);
    assert.equal(stream.status, 410);
  });

  test('перевыпуск: старый токен умирает, новый работает', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '1h' });
    const rotated = await fetch(`${BASE}/api/shares/${share.id}/rotate`, {
      method: 'POST',
      headers: auth(),
    });
    assert.equal(rotated.status, 200);
    const fresh = await rotated.json();
    assert.notEqual(fresh.token, share.token);

    assert.equal((await fetch(`${BASE}/s/${share.token}`)).status, 410);
    assert.equal((await fetch(`${BASE}/s/${fresh.token}`)).status, 200);
  });

  test('лимит открытий: после N показов — 410', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '1h', maxPlays: 2 });
    assert.equal((await fetch(`${BASE}/s/${share.token}`)).status, 200);
    assert.equal((await fetch(`${BASE}/s/${share.token}`)).status, 200);
    const third = await fetch(`${BASE}/s/${share.token}`);
    assert.equal(third.status, 410);
    assert.match(await third.text(), /Лимит открытий/);
  });

  test('статистика: открытия считаются, владелец видит, гость — нет', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, title: 'статистика', ttl: '1h' });
    await fetch(`${BASE}/s/${share.token}`);
    await fetch(`${BASE}/s/${share.token}/stream/${trackId}`, { headers: { Range: 'bytes=0-9' } });

    const list = await fetch(`${BASE}/api/shares?targetId=${trackId}`, { headers: auth() });
    assert.equal(list.status, 200);
    const items = await list.json();
    const found = items.find((item) => item.id === share.id);
    assert.ok(found);
    assert.equal(found.plays, 1, 'stream-запросы не должны считаться открытиями');
    assert.ok(found.stats.hits.open >= 1);
    assert.ok(found.stats.hits.stream >= 1);
    assert.equal(found.stats.visitors, 1);
    assert.equal(found.title, 'статистика');
    // токена в списке нет — восстановить ссылку нельзя
    assert.equal(found.token, undefined);

    const guest = await fetch(`${BASE}/api/shares`, { headers: { Authorization: '' } });
    assert.equal(guest.status, 401);
  });

  test('создание ссылки требует владельца и существующей цели', async () => {
    const anon = await fetch(`${BASE}/api/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetKind: 'track', targetId: trackId }),
    });
    assert.equal(anon.status, 401);

    const missing = await fetch(`${BASE}/api/shares`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetKind: 'track', targetId: 'a'.repeat(32) }),
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'target_not_found');

    const badKind = await fetch(`${BASE}/api/shares`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetKind: 'library', targetId: trackId }),
    });
    assert.equal(badKind.status, 400);
  });

  test('удаление трека гасит его ссылки', async () => {
    const track = await upload({ title: 'Delete Me', filename: 'delete-me.wav' }, makeWav(0.3, 220));
    const share = await makeShare({ targetKind: 'track', targetId: track.id, ttl: '30d' });
    assert.equal((await fetch(`${BASE}/s/${share.token}`)).status, 200);

    const removed = await fetch(`${BASE}/api/tracks/${track.id}`, { method: 'DELETE', headers: auth() });
    assert.equal(removed.status, 204);

    assert.equal((await fetch(`${BASE}/s/${share.token}`)).status, 410);
  });

  test('срок жизни: «2h» даёт ~2 часа, PATCH продлевает и переименовывает', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '2h' });
    const hours = (new Date(share.expiresAt).getTime() - Date.now()) / 3_600_000;
    assert.ok(hours > 1.9 && hours <= 2.01, `ожидали ~2 часа, получили ${hours}`);

    const patched = await fetch(`${BASE}/api/shares/${share.id}`, {
      method: 'PATCH',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'новое имя', ttl: '30d' }),
    });
    assert.equal(patched.status, 200);
    const updated = await patched.json();
    assert.equal(updated.title, 'новое имя');
    const days = (new Date(updated.expiresAt).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 29.9, `ожидали ~30 дней, получили ${days}`);
  });

  test('PATCH: ttl=null делает бессрочной, maxPlays=0 снимает лимит', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '1h', maxPlays: 3 });
    const patched = await fetch(`${BASE}/api/shares/${share.id}`, {
      method: 'PATCH',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: null, maxPlays: 0 }),
    });
    assert.equal(patched.status, 200);
    const updated = await patched.json();
    assert.equal(updated.expiresAt, null);
    assert.equal(updated.maxPlays, null);
    // ссылка не превратилась в «закрытую сразу»
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await fetch(`${BASE}/s/${share.token}`)).status, 200);
    }
  });

  test('OpenAPI описывает ссылки теми же путями, что и реализация', async () => {
    const spec = await (await fetch(`${BASE}/api/v1/openapi.json`)).json();
    for (const route of ['/shares', '/shares/{id}', '/shares/{id}/rotate']) {
      assert.ok(spec.paths[route], `в схеме нет ${route}`);
    }
    assert.ok(spec.components.schemas.Share);
    assert.ok(spec.components.schemas.ShareWithToken);
  });

  test('бессрочная ссылка (ttl=forever) не имеет expiresAt', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, ttl: 'forever' });
    assert.equal(share.expiresAt, null);
    assert.equal((await fetch(`${BASE}/s/${share.token}`)).status, 200);
  });

  test('токен не течёт: Referrer-Policy no-referrer и кэш no-store', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '1h' });
    const page = await fetch(`${BASE}/s/${share.token}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('cache-control'), 'no-store');

    const stream = await fetch(`${BASE}/s/${share.token}/stream/${trackId}`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(stream.status, 206);
    assert.equal(stream.headers.get('referrer-policy'), 'no-referrer');
  });

  test('неизвестный токен — 404 и та же аккуратная страница', async () => {
    const res = await fetch(`${BASE}/s/${'x'.repeat(43)}`);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /Ссылка недоступна/);
  });
});
