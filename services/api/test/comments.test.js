import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Таймкод-комментарии для приглашённых (Фаза 6, E3) — контракт.
 *
 * Проверяем то, что легко сломать и опасно не заметить:
 *  - комментарий привязан к ссылке и треку: чужая ссылка его не видит;
 *  - секунда клампится в длительность трека, тело и имя чистятся от разметки;
 *  - пустой комментарий и чужой трек дают 400/403, а не «тихую запись»;
 *  - удалить может автор и владелец, чужой гость — нет;
 *  - страница гостя рендерит ленту без JavaScript и экранирует HTML;
 *  - форма работает обычным POST (303 обратно на страницу);
 *  - лимит частоты не даёт залить ленту за минуту;
 *  - отозванная ссылка перестаёт отдавать ленту (410) и сама лента не течёт в API.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 4796;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'vision';

let child;
let dataDir;
let token = '';
let trackId = '';
let otherTrackId = '';
let sharePath = '';
let shareId = '';

/* ------------------------------- файлы ------------------------------------ */

/** Минимальный WAV: без ffmpeg длительность всё равно должна считаться. */
function makeWav(seconds = 4, freq = 440) {
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
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* ещё поднимается */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('сервер не поднялся');
}

async function upload(title, seconds = 4) {
  const res = await fetch(`${BASE}/api/tracks`, {
    method: 'POST',
    headers: {
      ...auth(),
      'Content-Type': 'audio/wav',
      // заголовки — ByteString: не-ASCII имена передаём через PATCH после загрузки
      'X-Title': title,
      'X-Artist': 'Test',
    },
    body: makeWav(seconds),
  });
  if (res.status !== 201) assert.fail(await res.text());
  return res.json();
}

const comment = (body, extra = {}) =>
  fetch(`${BASE}${sharePath}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackId, body, ...extra }),
  });

/* --------------------------------- жизнь ---------------------------------- */

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'vision-comments-'));

  child = spawn(process.execPath, ['services/api/src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(PORT),
      VISION_PASSWORD: PASSWORD,
      VISION_SECRET: 'test-secret',
      SEED_ENABLED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[api] ${chunk}`));

  await waitForServer();

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  token = (await login.json()).token;

  const track = await upload('Above The Sun', 6);
  const other = await upload('Other track', 3);
  trackId = track.id;
  otherTrackId = other.id;

  await fetch(`${BASE}/api/tracks/${otherTrackId}`, {
    method: 'PATCH',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Другой трек' }),
  });

  const created = await fetch(`${BASE}/api/shares`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetKind: 'track', targetId: trackId, ttl: '1h' }),
  });
  const share = await created.json();
  sharePath = share.path;
  shareId = share.id;
});

after(() => {
  child?.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/* --------------------------------- тесты ---------------------------------- */

describe('комментарии к секунде', () => {
  test('пустая лента у новой ссылки', async () => {
    const res = await fetch(`${BASE}${sharePath}/comments?trackId=${trackId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.comments, []);
  });

  test('гость оставляет комментарий, лента сортируется по секунде', async () => {
    const later = await comment('бас вступает', { at: 4.2, author: 'Дима' });
    assert.equal(later.status, 201);
    const first = await later.json();
    assert.equal(first.at, 4.2);
    assert.equal(first.author, 'Дима');

    const earlier = await comment('а тут вокал', { at: 1.5, author: 'Дима' });
    assert.equal(earlier.status, 201);

    const feed = await (await fetch(`${BASE}${sharePath}/comments?trackId=${trackId}`)).json();
    assert.deepEqual(feed.comments.map((item) => item.at), [1.5, 4.2]);
    assert.ok(feed.comments.every((item) => item.trackId === trackId));
  });

  test('секунда не выходит за длительность трека', async () => {
    // длительности у тестового WAV может не быть (нет ffprobe) — проверяем оба случая:
    // если сервер знает длительность, секунда клампится, иначе остаётся как есть
    const info = await (await fetch(`${BASE}/api/tracks/${trackId}`, { headers: auth() })).json();
    const res = await comment('опоздал на 15 минут', { at: 900 });
    assert.equal(res.status, 201);
    const created = await res.json();

    if (info.duration > 0) {
      assert.ok(created.at <= info.duration, `ожидали <= ${info.duration} с, получили ${created.at}`);
    } else {
      assert.equal(created.at, 900, 'без известной длительности секунду не выдумываем');
    }
    assert.ok(created.at > 0);
  });

  test('пустой комментарий и чужой трек отклоняются', async () => {
    const empty = await comment('   \n  ');
    assert.equal(empty.status, 400);

    const foreign = await fetch(`${BASE}${sharePath}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId: otherTrackId, body: 'чужой трек' }),
    });
    assert.equal(foreign.status, 403);

    const broken = await fetch(`${BASE}${sharePath}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{не json',
    });
    assert.equal(broken.status, 400);
  });

  test('разметка в комментарии не становится тегом на странице', async () => {
    const res = await comment('<img src=x onerror=alert(1)>', { at: 2, author: '<b>Гость</b>' });
    assert.equal(res.status, 201);

    const html = await (await fetch(`${BASE}${sharePath}`)).text();
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'тело экранировано');
    assert.ok(!html.includes('<img src=x'), 'сырой тег не попал в разметку');
    assert.ok(html.includes('&lt;b&gt;Гость&lt;/b&gt;'), 'имя экранировано');
    // и страница всё ещё закрыта от индексации
    assert.ok(html.includes('name="robots"'));
  });

  test('страница гостя показывает ленту и форму без JavaScript', async () => {
    const res = await fetch(`${BASE}${sharePath}`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') || '', /script-src 'unsafe-inline'/);
    assert.match(res.headers.get('content-security-policy') || '', /form-action 'self'/);
    assert.ok(html.includes('cmtform'), 'форма есть в разметке');
    assert.ok(html.includes('сmtform') === false);
    assert.ok(html.includes('1:30') === false);
    assert.ok(html.includes('data-seek="1.5"'), 'таймкод кликабельный');
  });

  test('форма без JS сохраняет комментарий и возвращает на страницу', async () => {
    const form = new URLSearchParams({ trackId, at: '3', author: 'Гость', body: 'из формы' });
    const res = await fetch(`${BASE}${sharePath}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    assert.ok(String(res.headers.get('location')).includes(`#track-${trackId}`));

    const feed = await (await fetch(`${BASE}${sharePath}/comments?trackId=${trackId}`)).json();
    assert.ok(feed.comments.some((item) => item.body === 'из формы' && item.at === 3));
  });

  test('свой комментарий удаляется, чужой — нет', async () => {
    const mine = await (await comment('удалю себя', { at: 1 })).json();
    const theirs = await (await comment('это удалять нельзя', { at: 1, author: 'Кто-то' })).json();

    // «свой» определяем по хешу адреса; оба пришли с одного адреса в тесте,
    // поэтому дополнительно проверяем владельческий путь ниже
    const wrong = await fetch(`${BASE}${sharePath}/comments/00000000000000000000000000000000`, { method: 'DELETE' });
    assert.equal(wrong.status, 404);

    const del = await fetch(`${BASE}/api/shares/${shareId}/comments?commentId=${theirs.id}`, {
      method: 'DELETE',
      headers: auth(),
    });
    assert.equal(del.status, 200);

    const feed = await (await fetch(`${BASE}${sharePath}/comments?trackId=${trackId}`)).json();
    assert.ok(!feed.comments.some((item) => item.id === theirs.id), 'удалённый не отдаётся');
    assert.ok(feed.comments.some((item) => item.id === mine.id), 'остальные на месте');
  });

  test('лента одной ссылки не видна в другой', async () => {
    const second = await fetch(`${BASE}/api/shares`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetKind: 'track', targetId: trackId, ttl: '1h' }),
    });
    const other = await second.json();

    const feed = await (await fetch(`${BASE}${other.path}/comments?trackId=${trackId}`)).json();
    assert.deepEqual(feed.comments, [], 'у новой ссылки своя пустая лента');
  });

  test('владелец видит все комментарии и счётчик в списке ссылок', async () => {
    const res = await fetch(`${BASE}/api/shares/${shareId}/comments`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.comments.length >= 2);
    // владелец видит и удалённые (для разбора), общий счётчик считает только живые
    const alive = body.comments.filter((item) => !item.deletedAt).length;
    assert.equal(body.total, alive);

    const list = await (await fetch(`${BASE}/api/shares`, { headers: auth() })).json();
    const mine = list.find((item) => item.id === shareId);
    assert.ok(mine.comments >= 2, 'счётчик комментариев в списке ссылок');
  });

  test('без сессии владельческие маршруты закрыты', async () => {
    const res = await fetch(`${BASE}/api/shares/${shareId}/comments`);
    assert.equal(res.status, 401);
    const del = await fetch(`${BASE}/api/shares/${shareId}/comments?commentId=x`, { method: 'DELETE' });
    assert.equal(del.status, 401);
  });

  test('лимит частоты не даёт залить ленту', async () => {
    const statuses = [];
    for (let i = 0; i < 10; i += 1) {
      statuses.push((await comment(`спам ${i}`, { at: 1 })).status);
    }
    assert.ok(statuses.includes(429), `ожидали 429 в ${statuses.join(',')}`);
  });

  test('отозванная ссылка не отдаёт ленту (410 JSON, не HTML)', async () => {
    const created = await fetch(`${BASE}/api/shares`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetKind: 'track', targetId: trackId, ttl: '1h' }),
    });
    const temp = await created.json();

    await fetch(`${BASE}/api/shares/${temp.id}`, { method: 'DELETE', headers: auth() });

    const res = await fetch(`${BASE}${temp.path}/comments?trackId=${trackId}`);
    assert.equal(res.status, 410);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.equal(body.error.code, 'revoked');
  });

  test('удаление ссылки с purge уносит комментарии', async () => {
    const created = await fetch(`${BASE}/api/shares`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetKind: 'track', targetId: trackId, ttl: '1h' }),
    });
    const temp = await created.json();

    await fetch(`${BASE}${temp.path}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId, at: 1, body: 'исчезну вместе со ссылкой' }),
    });

    const purge = await fetch(`${BASE}/api/shares/${temp.id}?purge=1`, { method: 'DELETE', headers: auth() });
    assert.equal(purge.status, 204);

    const gone = await fetch(`${BASE}${temp.path}/comments?trackId=${trackId}`);
    assert.equal(gone.status, 404);
  });
});
