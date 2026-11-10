import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 4789;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let dataDir;
let oembed;
let token = '';
let firstTrackId = '';

/* ------------------------------ генераторы файлов ------------------------------ */

/** Валидный WAV: 0.25 с, 8 кГц, моно, с чанком LIST/INFO. */
function makeWav({ seconds = 0.25, title = null, artist = null } = {}) {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;

  const infoEntries = [];
  if (title) infoEntries.push(['INAM', title]);
  if (artist) infoEntries.push(['IART', artist]);

  const infoBody = Buffer.concat([
    Buffer.from('INFO', 'latin1'),
    ...infoEntries.map(([id, value]) => {
      const payload = Buffer.from(`${value}\0`, 'latin1');
      const padded = payload.length % 2 ? Buffer.concat([payload, Buffer.from([0])]) : payload;
      const header = Buffer.alloc(8);
      header.write(id, 0, 'latin1');
      header.writeUInt32LE(payload.length, 4);
      return Buffer.concat([header, padded]);
    }),
  ]);
  const listChunk = Buffer.alloc(8);
  listChunk.write('LIST', 0, 'latin1');
  listChunk.writeUInt32LE(infoBody.length, 4);

  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);

  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'latin1');
  dataHeader.writeUInt32LE(dataSize, 4);

  const pcm = Buffer.alloc(dataSize);
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 440) * 0.4 * 32767), i * 2);
  }

  const parts = [fmt, listChunk, infoBody, dataHeader, pcm];
  const body = Buffer.concat(parts);

  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WAVE', 8, 'latin1');

  return Buffer.concat([header, body]);
}

const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC',
  'base64'
);

/** Минимальный MP3 с ID3v2.3: TIT2, TPE1, TALB, APIC. */
function makeMp3WithTags() {
  const frame = (id, payload) => {
    const header = Buffer.alloc(10);
    header.write(id, 0, 'latin1');
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };

  const textFrame = (id, value) => frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8')]));

  const apicPayload = Buffer.concat([
    Buffer.from([0]), // latin1
    Buffer.from('image/png\0', 'latin1'),
    Buffer.from([3]), // front cover
    Buffer.from('\0', 'latin1'),
    PNG_PIXEL,
  ]);

  const frames = Buffer.concat([
    textFrame('TIT2', 'Tagged Track'),
    textFrame('TPE1', 'Tagged Artist'),
    textFrame('TALB', 'Tagged Album'),
    textFrame('TCON', 'Techno'),
    frame('APIC', apicPayload),
  ]);

  const size = frames.length;
  const header = Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([3, 0, 0]),
    Buffer.from([
      (size >> 21) & 0x7f,
      (size >> 14) & 0x7f,
      (size >> 7) & 0x7f,
      size & 0x7f,
    ]),
  ]);

  // пара «пустых» MPEG-кадров, чтобы файл выглядел как mp3
  const audio = Buffer.alloc(417);
  audio[0] = 0xff;
  audio[1] = 0xfb;

  return Buffer.concat([header, frames, audio]);
}

const authed = (options = {}) => ({
  ...options,
  headers: {
    Authorization: `Bearer ${token}`,
    ...(options.headers || {}),
  },
});

async function upload(body, query = {}) {
  const search = new URLSearchParams(query);
  const res = await fetch(`${BASE}/api/tracks?${search}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/wav' },
    body,
  });
  return res;
}

/* --------------------------------- запуск --------------------------------- */

/** Фейковый oEmbed-эндпоинт: тесты не ходят в интернет. */
const OEMBED_FIXTURES = {
  'https://soundcloud.com/vision-labs/midnight-drive': {
    title: 'Midnight Drive (external)',
    author_name: 'Vision Labs',
    thumbnail_url: 'https://i1.sndcdn.com/artworks-test-t500x500.jpg',
    html: '<iframe width="100%" height="166" scrolling="no" frameborder="no" src="https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/1&color=%23ff5500"></iframe>',
  },
};

async function startOembed() {
  oembed = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const target = url.searchParams.get('url');
    const fixture = OEMBED_FIXTURES[target];
    if (!fixture) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...fixture, provider_name: 'SoundCloud' }));
  });

  await new Promise((resolve) => oembed.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${oembed.address().port}/oembed`;
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'vision-test-'));
  const oembedUrl = await startOembed();
  child = spawn(process.execPath, ['services/api/src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      VISION_PASSWORD: 'vision',
      NODE_ENV: 'test',
      SOUNDCLOUD_OEMBED_BASE: oembedUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start')), 15000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('server started') || chunk.toString().includes('Vision Audio API')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (/Error|error/i.test(text) && !text.includes('ExperimentalWarning')) {
        clearTimeout(timeout);
        reject(new Error(text));
      }
    });
  });
});

after(() => {
  child?.kill('SIGTERM');
  oembed?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/* ---------------------------------- тесты ---------------------------------- */

test('health: схема БД и версия', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, 'string');
  assert.equal(body.migrations.pending, 0);
});

test('закрытые маршруты требуют токен', async () => {
  const res = await fetch(`${BASE}/api/tracks`);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'unauthorized');
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
  token = (await good.json()).token;
  assert.ok(token.length > 20);
});

test('загрузка: теги из файла, обложка, peaks', async () => {
  const peaks = JSON.stringify([0.1, 0.5, 0.9, 0.3]);
  const res = await upload(makeMp3WithTags(), {
    title: 'track',
    filename: 'track.mp3',
    duration: '3',
    peaks,
  });

  assert.equal(res.status, 201);
  const track = await res.json();
  // клиентское «track» выглядит как имя файла → сервер предпочёл теги
  assert.equal(track.title, 'Tagged Track');
  assert.equal(track.artist, 'Tagged Artist');
  assert.equal(track.album, 'Tagged Album');
  assert.equal(track.genre, 'Techno');
  assert.equal(track.cover, true);
  assert.deepEqual(track.peaks, [0.1, 0.5, 0.9, 0.3]);
  firstTrackId = track.id;
});

test('дедупликация: повторная загрузка отклоняется', async () => {
  const res = await upload(makeMp3WithTags(), { title: 'copy', filename: 'copy.mp3' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, 'duplicate');
  assert.equal(body.existing.id, firstTrackId);
});

test('отказ не-аудио по magic bytes', async () => {
  const res = await fetch(`${BASE}/api/tracks?title=Bad`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/mpeg' },
    body: Buffer.from('это точно не аудио, а обычный текст'.repeat(20)),
  });
  assert.equal(res.status, 415);
  assert.equal((await res.json()).error.code, 'unsupported_type');
});

test('подписанные ссылки на медиа: выпуск, стриминг, обложка', async () => {
  const media = await fetch(`${BASE}/api/media?ids=${firstTrackId}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(media.status, 200);
  const payload = await media.json();
  const item = payload.items[firstTrackId];
  assert.ok(item.stream.includes('exp=') && item.stream.includes('sig='));
  assert.ok(item.cover && item.cover.includes('sig='));

  // без заголовков, как это делает <audio>
  const range = await fetch(`${BASE}${item.stream}`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 10);

  const cover = await fetch(`${BASE}${item.cover}`);
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get('content-type'), 'image/png');

  // подпись нельзя подделать
  const tampered = item.stream.replace(/sig=([^&]+)/, 'sig=deadbeef');
  const denied = await fetch(`${BASE}${tampered}`);
  assert.equal(denied.status, 401);
});

test('старый способ ?token= больше не работает для медиа', async () => {
  const res = await fetch(`${BASE}/api/tracks/${firstTrackId}/stream?token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 401);
});

test('Range: 206, корректный Content-Range и 416', async () => {
  const full = makeMp3WithTags().length;
  const range = await fetch(`${BASE}/api/tracks/${firstTrackId}/stream`, {
    headers: { Authorization: `Bearer ${token}`, Range: 'bytes=100-199' },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 100-199/${full}`);
  assert.equal((await range.arrayBuffer()).byteLength, 100);

  const invalid = await fetch(`${BASE}/api/tracks/${firstTrackId}/stream`, {
    headers: { Authorization: `Bearer ${token}`, Range: `bytes=${full + 10}-` },
  });
  assert.equal(invalid.status, 416);
});

test('поиск FTS5, пагинация и X-Total-Count', async () => {
  await upload(makeWav({ title: 'Evening Rain', artist: 'North Loop' }), {
    title: 'morning',
    filename: 'morning.wav',
    genre: 'Ambient',
  });

  const found = await fetch(`${BASE}/api/tracks?q=evening`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(found.status, 200);
  const results = await found.json();
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Evening Rain');
  assert.equal(results[0].artist, 'North Loop');

  const byPrefix = await fetch(`${BASE}/api/tracks?q=tagged`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await byPrefix.json()).length, 1, 'префиксный поиск по слову');

  const page = await fetch(`${BASE}/api/tracks?limit=1&offset=1`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(page.status, 200);
  assert.equal((await page.json()).length, 1);
  assert.equal(page.headers.get('x-total-count'), '2');
});

test('лайк, прослушивание и история', async () => {
  const patched = await fetch(`${BASE}/api/tracks/${firstTrackId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ liked: true }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).liked, true);

  const listen = await fetch(`${BASE}/api/tracks/${firstTrackId}/listen`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ position: 42.5, duration: 180 }),
  });
  assert.equal(listen.status, 204);

  const history = await (await fetch(`${BASE}/api/history`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(history.length, 1);
  assert.equal(history[0].track.id, firstTrackId);
  assert.equal(history[0].position, 42.5);
  assert.equal(history[0].completed, false);

  const stats = await (await fetch(`${BASE}/api/stats`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(stats.liked, 1);
  assert.equal(stats.tracks, 2);
});

test('плейлисты: создание, добавление, удаление', async () => {
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
    body: JSON.stringify({ trackId: firstTrackId }),
  });
  assert.equal(add.status, 204);

  const tracks = await (
    await fetch(`${BASE}/api/playlists/${playlist.id}/tracks`, { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].id, firstTrackId);

  const remove = await fetch(`${BASE}/api/playlists/${playlist.id}/tracks/${firstTrackId}`, {
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

test('удаление трека убирает файл, историю и поисковый индекс', async () => {
  const removed = await fetch(`${BASE}/api/tracks/${firstTrackId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(removed.status, 204);

  const missing = await fetch(`${BASE}/api/tracks/${firstTrackId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(missing.status, 404);

  const found = await (await fetch(`${BASE}/api/tracks?q=tagged`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(found.length, 0, 'индекс очищен');

  const history = await (await fetch(`${BASE}/api/history`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(history.length, 0, 'история очищена каскадом');
});

test('OpenAPI-схема отдаётся без токена и совпадает с версией', async () => {
  const res = await fetch(`${BASE}/api/openapi.json`);
  assert.equal(res.status, 200);
  const spec = await res.json();
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.paths['/tracks'].get);
  assert.ok(spec.components.schemas.Track);

  const v1 = await fetch(`${BASE}/api/v1/openapi.json`);
  assert.equal(v1.status, 200);

  const health = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(spec.info.version, health.version);
});

test('/api/v1 — алиас контракта с тем же поведением', async () => {
  const denied = await fetch(`${BASE}/api/v1/tracks`);
  assert.equal(denied.status, 401);

  const ok = await fetch(`${BASE}/api/v1/tracks?limit=1&sort=title`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.get('x-total-count'));
  const items = await ok.json();
  assert.ok(Array.isArray(items));

  const health = await (await fetch(`${BASE}/api/v1/health`)).json();
  assert.equal(health.ok, true);
});

test('импорт внешних ссылок: только метаданные, без скачивания аудио', async () => {
  const created = await fetch(`${BASE}/api/external`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: ['https://soundcloud.com/vision-labs/midnight-drive?si=abc123'] }),
  });
  assert.equal(created.status, 201);
  const payload = await created.json();
  assert.equal(payload.added.length, 1);
  assert.equal(payload.failed.length, 0);

  const item = payload.added[0];
  assert.equal(item.title, 'Midnight Drive (external)');
  assert.equal(item.artist, 'Vision Labs');
  assert.equal(item.permalink, 'https://soundcloud.com/vision-labs/midnight-drive');
  assert.match(item.embedUrl, /^https:\/\/w\.soundcloud\.com\/player\//);
  assert.equal(item.duration, 0, 'аудио не скачивается, длительность не выдумываем');

  // повторный импорт не создаёт дубль
  const again = await fetch(`${BASE}/api/external`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: ['https://soundcloud.com/vision-labs/midnight-drive'] }),
  });
  const second = await again.json();
  assert.equal(second.added[0].created, false);
  assert.equal(second.added[0].id, item.id);

  const list = await (await fetch(`${BASE}/api/external`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(list.length, 1);

  const removed = await fetch(`${BASE}/api/external/${item.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(removed.status, 204);
});

test('импорт отклоняет чужие домены и несуществующие треки', async () => {
  const foreign = await fetch(`${BASE}/api/external`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: ['https://evil.example.com/track'] }),
  });
  assert.equal(foreign.status, 400);
  const foreignBody = await foreign.json();
  assert.equal(foreignBody.failed[0].code, 'unsupported_host');

  const missing = await fetch(`${BASE}/api/external`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: ['https://soundcloud.com/nobody/nothing'] }),
  });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).failed[0].code, 'not_found');

  const empty = await fetch(`${BASE}/api/external`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: [] }),
  });
  assert.equal(empty.status, 400);
});

test('метрики Prometheus и заголовки безопасности', async () => {
  const metrics = await fetch(`${BASE}/metrics`);
  assert.equal(metrics.status, 200);
  const text = await metrics.text();
  assert.match(text, /vision_tracks_total \d+/);
  assert.match(text, /vision_http_requests_total/);
  assert.match(text, /vision_http_request_duration_seconds_bucket/);

  const page = await fetch(`${BASE}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('referrer-policy') || '', /strict-origin/);
});

test('транскодинг: opus/aac/HLS появляются, если доступен ffmpeg', async () => {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(typeof health.transcode.enabled, 'boolean');
  assert.equal(typeof health.ffmpeg.available, 'boolean');

  if (!health.ffmpeg.available) {
    // без ffmpeg сервис обязан работать: отдаём оригинал, вариантов нет
    const created = await upload(makeWav({ title: 'No Ffmpeg', artist: 'Test' }), {
      title: 'No Ffmpeg',
      filename: 'no-ffmpeg.wav',
    });
    assert.equal(created.status, 201);
    const track = await created.json();
    const media = await (
      await fetch(`${BASE}/api/media?ids=${track.id}`, { headers: { Authorization: `Bearer ${token}` } })
    ).json();
    assert.deepEqual(Object.keys(media.items[track.id].streams), ['original']);
    assert.equal(media.items[track.id].hls, null);
    return;
  }

  const created = await upload(makeWav({ seconds: 2, title: 'Transcoded', artist: 'Test' }), {
    title: 'Transcoded',
    filename: 'transcoded.wav',
    duration: '2',
  });
  assert.equal(created.status, 201);
  const track = await created.json();

  let item = null;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const media = await (
      await fetch(`${BASE}/api/media?ids=${track.id}`, { headers: { Authorization: `Bearer ${token}` } })
    ).json();
    item = media.items[track.id];
    if (item.streams.opus && item.streams.aac && item.hls) break;
  }

  assert.ok(item.streams.opus, 'opus-вариант готов');
  assert.ok(item.streams.aac, 'aac-вариант готов');
  assert.ok(item.hls, 'HLS-плейлист готов');

  const opus = await fetch(`${BASE}${item.streams.opus}`, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(opus.status, 206);
  assert.match(opus.headers.get('content-type'), /audio\/ogg/);

  const aac = await fetch(`${BASE}${item.streams.aac}`, { headers: { Range: 'bytes=0-511' } });
  assert.equal(aac.status, 206);
  assert.match(aac.headers.get('content-type'), /audio\/mp4/);

  const tampered = item.streams.opus.replace(/sig=[^&]+/, 'sig=deadbeef');
  const denied = await fetch(`${BASE}${tampered}`);
  assert.equal(denied.status, 401, 'подпись варианта защищена');

  const detail = await (
    await fetch(`${BASE}/api/tracks/${track.id}`, { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  const kinds = detail.variants.map((variant) => variant.kind).sort();
  assert.deepEqual(kinds, ['aac', 'hls', 'opus']);

  const playlist = await fetch(`${BASE}${item.hls}`);
  assert.equal(playlist.status, 200);
  const body = await playlist.text();
  assert.match(body, /#EXTM3U/);

  const segmentLine = body.split('\n').find((line) => line.includes('/hls/seg-'));
  assert.ok(segmentLine, 'в плейлисте есть сегменты с подписью');
  assert.match(segmentLine, /exp=\d+&sig=/);

  const segment = await fetch(`${BASE}${segmentLine}`);
  assert.equal(segment.status, 200);
  assert.match(segment.headers.get('content-type'), /video\/mp2t/);

  await fetch(`${BASE}/api/tracks/${track.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
});
