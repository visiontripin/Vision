import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Встраивание (Фаза 6, E4): `/embed/:token` и `/api/oembed`.
 *
 * Контракт, который легко сломать и дорого не заметить:
 *  - виджет встраивается (`frame-ancestors *`, нет `X-Frame-Options`), играет и
 *    открывается ссылкой на полную страницу;
 *  - oEmbed отдаёт поля спецификации 1.0, уважает maxwidth/maxheight и не
 *    превращается в описание произвольного чужого адреса;
 *  - отозванная/истёкшая ссылка не «протекает» ни в виджете, ни в oEmbed;
 *  - вставка в блог не сжигает лимит открытий (виджет не растит `plays`),
 *    но прослушивание в нём видно владельцу.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 4794;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'vision';

let child;
let dataDir;
let token = '';
let trackId = '';
let playlistId = '';

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

async function upload(title, freq) {
  const search = new URLSearchParams({
    title,
    artist: 'Tester',
    genre: 'Ambient',
    duration: '1',
    filename: 'embed.wav',
  });
  const res = await fetch(`${BASE}/api/tracks?${search}`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'audio/wav' },
    body: makeWav(0.4, freq),
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
  dataDir = mkdtempSync(path.join(tmpdir(), 'vision-embed-'));
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

  const first = await upload('Embed Track', 440);
  trackId = first.id;
  const second = await upload('Second Embed', 660);

  const playlist = await fetch(`${BASE}/api/playlists`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Микс для блога' }),
  });
  playlistId = (await playlist.json()).id;
  for (const id of [trackId, second.id]) {
    await fetch(`${BASE}/api/playlists/${playlistId}/tracks`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId: id }),
    });
  }
});

after(() => {
  child?.kill('SIGTERM');
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe('встраивание: виджет /embed/:token', () => {
  test('виджет встраивается, играет и ведёт на полную страницу', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '2h' });

    const res = await fetch(`${BASE}/embed/${share.token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    // встраивание — смысл маршрута
    assert.equal(res.headers.get('x-frame-options'), null);
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors \*/);
    assert.match(res.headers.get('referrer-policy') ?? '', /no-referrer/);

    const html = await res.text();
    assert.match(html, /<audio/);
    assert.match(html, new RegExp(`/s/${share.token}/stream/${trackId}`));
    assert.match(html, new RegExp(`href="http://127\\.0\\.0\\.1:${PORT}/s/${share.token}"`));
    assert.match(html, /Embed Track/);
    assert.match(html, /Открыть в Vision Audio/);
  });

  test('светлая тема по ?theme=light, тёмная по умолчанию', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '2h' });
    const dark = await (await fetch(`${BASE}/embed/${share.token}`)).text();
    const light = await (await fetch(`${BASE}/embed/${share.token}?theme=light`)).text();
    assert.match(dark, /data-theme="dark"/);
    assert.match(light, /data-theme="light"/);
  });

  test('стили виджета отдаются как CSS и кэшируются', async () => {
    const res = await fetch(`${BASE}/embed/widget.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/css/);
    assert.match(res.headers.get('cache-control') ?? '', /max-age/);
    assert.match(await res.text(), /--accent:\s*#ff5a1f/);
  });

  test('плейлист в виджете: первый трек играет, остальные — списком', async () => {
    const share = await makeShare({ targetKind: 'playlist', targetId: playlistId, ttl: '2h' });
    const html = await (await fetch(`${BASE}/embed/${share.token}`)).text();
    assert.match(html, /Микс для блога/);
    assert.match(html, /2 трека|2 треков/);
    assert.match(html, /class="list"/);
    assert.match(html, /Second Embed/);
  });

  test('виджет не сжигает лимит открытий, прослушивание — учитывается', async () => {
    const share = await makeShare({
      targetKind: 'track',
      targetId: trackId,
      ttl: '2h',
      maxPlays: 1,
    });

    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${BASE}/embed/${share.token}`);
      assert.equal(res.status, 200, 'встраивание остаётся доступным');
    }

    const list = await (await fetch(`${BASE}/api/shares?includeRevoked=1&targetKind=track&targetId=${trackId}`, {
      headers: auth(),
    })).json();
    const mine = list.find((item) => item.id === share.id);
    assert.equal(mine.plays, 0, 'открытия виджета не считаются открытиями ссылки');

    const stream = await fetch(`${BASE}/embed/${share.token}`).then((res) => res.text())
      .then(() => fetch(`${BASE}/s/${share.token}/stream/${trackId}`));
    assert.equal(stream.status, 200);
    await stream.arrayBuffer();

    const after = await (await fetch(`${BASE}/api/shares?includeRevoked=1&targetKind=track&targetId=${trackId}`, {
      headers: auth(),
    })).json();
    const updated = after.find((item) => item.id === share.id);
    assert.equal(updated.stats.hits.stream, 1, 'прослушивание из виджета видно владельцу');
    assert.equal(updated.plays, 0);
  });

  test('отозванная и истёкшая ссылка в виджете — короткая страница ошибки', async () => {
    const revoked = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '1h' });
    await fetch(`${BASE}/api/shares/${revoked.id}`, { method: 'DELETE', headers: auth() });
    const dead = await fetch(`${BASE}/embed/${revoked.token}`);
    assert.equal(dead.status, 410);
    const html = await dead.text();
    assert.match(html, /отозвана/i);
    assert.doesNotMatch(html, new RegExp(revoked.token));

    assert.equal((await fetch(`${BASE}/embed/${'a'.repeat(43)}`)).status, 404);
    assert.equal((await fetch(`${BASE}/embed/короткий`)).status, 404);
  });
});

describe('встраивание: oEmbed', () => {
  test('JSON по спецификации 1.0 с рабочим html-кодом', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, title: 'для блога', ttl: '2h' });
    const res = await fetch(`${BASE}/api/oembed?url=${encodeURIComponent(`${BASE}/s/${share.token}`)}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');

    const body = await res.json();
    assert.equal(body.version, '1.0');
    assert.equal(body.type, 'rich');
    assert.equal(body.provider_name, 'Vision Audio');
    assert.equal(body.title, 'Embed Track');
    assert.equal(body.width, 480);
    assert.equal(body.height, 180);
    assert.match(body.html, new RegExp(`<iframe src="${BASE}/embed/${share.token}"`));
    assert.match(body.html, /width="480"/);
    assert.equal(body.vision.kind, 'track');
    assert.equal(body.vision.tracks, 1);
  });

  test('адрес принимается и для /embed/:token, и с хвостовым слэшем', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '2h' });
    const viaEmbed = await fetch(`${BASE}/api/oembed?url=${encodeURIComponent(`${BASE}/embed/${share.token}`)}`);
    assert.equal(viaEmbed.status, 200);
    const withSlash = await fetch(`${BASE}/api/oembed?url=${encodeURIComponent(`${BASE}/s/${share.token}/`)}`);
    assert.equal(withSlash.status, 200);
    assert.equal((await withSlash.json()).width, 480);
  });

  test('maxwidth/maxheight уменьшают iframe пропорционально', async () => {
    const share = await makeShare({ targetKind: 'playlist', targetId: playlistId, ttl: '2h' });
    const url = `${BASE}/api/oembed?url=${encodeURIComponent(`${BASE}/s/${share.token}`)}`;

    const wide = await (await fetch(`${url}&maxwidth=320`)).json();
    assert.equal(wide.width, 320);
    assert.ok(wide.height < 320 && wide.height > 180, `height=${wide.height}`);

    const tall = await (await fetch(`${url}&maxheight=200`)).json();
    assert.equal(tall.height, 200);
    assert.ok(tall.width <= 480, `width=${tall.width}`);
  });

  test('XML-вариант для агрегаторов', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '2h' });
    const res = await fetch(`${BASE}/api/oembed?format=xml&url=${encodeURIComponent(`${BASE}/s/${share.token}`)}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /xml/);
    const xml = await res.text();
    assert.match(xml, /^<\?xml/);
    assert.match(xml, /<provider_name>Vision Audio<\/provider_name>/);
    assert.match(xml, /<type>rich<\/type>/);
  });

  test('чужие адреса и мёртвые ссылки отклоняются', async () => {
    const alien = await fetch(`${BASE}/api/oembed?url=${encodeURIComponent('https://soundcloud.com/artist/track')}`);
    assert.equal(alien.status, 400);
    assert.equal((await alien.json()).error.code, 'invalid_url');

    assert.equal((await fetch(`${BASE}/api/oembed`)).status, 400);

    const badFormat = await fetch(`${BASE}/api/oembed?format=yaml&url=${encodeURIComponent(`${BASE}/s/${'b'.repeat(43)}`)}`);
    assert.equal(badFormat.status, 400);
    assert.equal((await badFormat.json()).error.code, 'invalid_format');

    const badToken = await fetch(`${BASE}/api/oembed?url=${encodeURIComponent(`${BASE}/s/${'b'.repeat(43)}`)}`);
    assert.equal(badToken.status, 404);
    assert.equal((await badToken.json()).error.code, 'not_found');

    const revoked = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '1h' });
    await fetch(`${BASE}/api/shares/${revoked.id}`, { method: 'DELETE', headers: auth() });
    const dead = await fetch(`${BASE}/api/oembed?url=${encodeURIComponent(`${BASE}/s/${revoked.token}`)}`);
    assert.equal(dead.status, 404);
  });

  test('/api/v1/oembed — тот же ответ (версионированный контракт)', async () => {
    const share = await makeShare({ targetKind: 'track', targetId: trackId, ttl: '2h' });
    const res = await fetch(`${BASE}/api/v1/oembed?url=${encodeURIComponent(`${BASE}/s/${share.token}`)}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).provider_name, 'Vision Audio');
  });
});
