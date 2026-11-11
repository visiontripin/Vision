import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORGOTTEN_DAYS, FRESH_DAYS, RECENT_DAYS, buildSections, daySeed, emptyHint, greeting,
} from '../src/personal.js';

/**
 * Персональные подборки по истории (Фаза 5, J3).
 *
 * Логика проверяется на «сухих» данных с фиксированным `now`: подборка не должна
 * зависеть от календаря машины, на которой её считают. Затем — контракт API:
 * история прослушиваний реально влияет на выдачу, а пустая библиотека даёт
 * подсказку, а не пустой экран без объяснений.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-11T20:00:00Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

const track = (patch) => ({
  id: patch.id,
  title: patch.title ?? patch.id,
  artist: patch.artist ?? 'Vision Labs',
  plays: 0,
  liked: false,
  addedAt: null,
  listenedAt: null,
  progress: null,
  ...patch,
});

const keys = (sections) => sections.map((section) => section.key);
const ids = (section) => section?.tracks.map((item) => item.id) ?? [];

/* ------------------------------- логика ---------------------------------- */

describe('подборки: правила', () => {
  test('пустая библиотека — пустые подборки и подсказка', () => {
    assert.deepEqual(buildSections([], { now: NOW }), []);
    assert.match(emptyHint(false), /Библиотека пуста/);
    assert.match(emptyHint(true), /Послушайте пару треков/);
  });

  test('«Продолжить слушать»: только начатое и не доконченное', () => {
    const sections = buildSections(
      [
        track({ id: 'start', progress: 0.4, listenedAt: iso(0.01) }),
        track({ id: 'finished', progress: 1, listenedAt: iso(0.02) }),
        track({ id: 'barely', progress: 0.01, listenedAt: iso(0.03) }),
        track({ id: 'untouched' }),
      ],
      { now: NOW }
    );
    assert.deepEqual(ids(sections.find((section) => section.key === 'continue')), ['start']);
  });

  test('«Любимый жанр» — по прослушиваниям, а не по числу треков', () => {
    const sections = buildSections(
      [
        // Techno: три трека, но слушали их по разу — всего 3
        track({ id: 't1', genre: 'Techno', plays: 1, listenedAt: iso(20) }),
        track({ id: 't2', genre: 'Techno', plays: 1, listenedAt: iso(20) }),
        track({ id: 't3', genre: 'Techno', plays: 1, listenedAt: iso(20) }),
        // Ambient: один трек, но слушали его 40 раз
        track({ id: 'a1', genre: 'Ambient', plays: 40, listenedAt: iso(20) }),
      ],
      { now: NOW }
    );
    const top = sections.find((section) => section.key === 'top-genre');
    assert.equal(top?.title, 'Любимый жанр: Ambient');
    assert.deepEqual(ids(top), ['a1']);
  });

  test('в «любимом жанре» свежепрослушанное уходит в конец, но не исчезает', () => {
    const sections = buildSections(
      [
        track({ id: 'recent', genre: 'Ambient', plays: 10, listenedAt: iso(RECENT_DAYS - 1) }),
        track({ id: 'old', genre: 'Ambient', plays: 5, listenedAt: iso(RECENT_DAYS + 5) }),
        track({ id: 'never', genre: 'Ambient', plays: 0, addedAt: iso(100) }),
      ],
      { now: NOW }
    );
    const top = sections.find((section) => section.key === 'top-genre');
    // вчерашнее — последним: подборка не должна начинаться с того, что только что играло
    assert.equal(ids(top).at(-1), 'recent');
    assert.deepEqual(ids(top).slice(0, 2).sort(), ['never', 'old']);
  });

  test('«Забытое» и «новое» не пересекаются', () => {
    const sections = buildSections(
      [
        track({ id: 'fresh', genre: 'Techno', addedAt: iso(FRESH_DAYS - 2) }),
        track({ id: 'old', genre: 'Techno', addedAt: iso(FRESH_DAYS + 20) }),
        track({ id: 'ancient', genre: 'Techno', addedAt: iso(400), listenedAt: iso(FORGOTTEN_DAYS + 30) }),
      ],
      { now: NOW }
    );
    assert.deepEqual(ids(sections.find((section) => section.key === 'fresh')), ['fresh']);
    assert.deepEqual(ids(sections.find((section) => section.key === 'forgotten')).sort(), ['ancient', 'old']);
  });

  test('«Из любимого»: перемешано, но одинаково в пределах seed', () => {
    const liked = Array.from({ length: 8 }, (_, index) =>
      track({ id: `l${index}`, liked: true, addedAt: iso(50), listenedAt: iso(40) })
    );
    const first = buildSections(liked, { now: NOW, seed: 42 }).find((section) => section.key === 'liked-mix');
    const second = buildSections(liked, { now: NOW, seed: 42 }).find((section) => section.key === 'liked-mix');
    assert.deepEqual(ids(first), ids(second), 'тот же seed — тот же порядок');
    assert.equal(ids(first).length, 8);

    const other = buildSections(liked, { now: NOW, seed: 112 }).find((section) => section.key === 'liked-mix');
    assert.notDeepEqual(ids(first), ids(other), 'другой день — другой порядок');
    assert.deepEqual([...ids(first)].sort(), [...ids(other)].sort(), 'но тот же состав');
  });

  test('лимит ограничивает каждую подборку, порядок подборок фиксирован', () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      track({ id: `x${index}`, genre: 'Ambient', plays: 5, liked: true, addedAt: iso(60), listenedAt: iso(40) })
    );
    const sections = buildSections(many, { now: NOW, limit: 5 });
    for (const section of sections) assert.ok(section.tracks.length <= 5, section.key);
    assert.deepEqual(keys(sections), ['top-genre', 'forgotten', 'liked-mix']);
  });

  test('битые даты и отрицательные значения не роняют подборку', () => {
    const sections = buildSections(
      [
        track({ id: 'broken', genre: 'Ambient', plays: -5, addedAt: 'не дата', listenedAt: 'тоже' }),
        track({ id: 'no-genre', genre: null, plays: 3 }),
        null,
      ].filter(Boolean),
      { now: NOW }
    );
    assert.ok(Array.isArray(sections));
    // трек без жанра не участвует в «любимом жанре», но попадает в «забытое»
    assert.equal(ids(sections.find((section) => section.key === 'forgotten')).includes('no-genre'), true);
  });

  test('приветствие и seed зависят от времени, но не от машины', () => {
    assert.equal(greeting(Date.parse('2026-11-11T02:00:00Z')), 'Доброй ночи');
    assert.equal(greeting(Date.parse('2026-11-11T08:00:00Z')), 'Доброе утро');
    assert.equal(greeting(Date.parse('2026-11-11T14:00:00Z')), 'Добрый день');
    assert.equal(greeting(Date.parse('2026-11-11T20:00:00Z')), 'Добрый вечер');
    assert.equal(daySeed(NOW), daySeed(NOW + 1000), 'в пределах дня seed тот же');
    assert.equal(daySeed(NOW) + 1, daySeed(NOW + DAY));
  });
});

/* --------------------------------- API ----------------------------------- */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 4799;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let dataDir;
let token;

function wav({ seconds = 0.2, seed = 0 } = {}) {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
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
    pcm.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * (200 + seed * 30)) * 0.4 * 32767), i * 2);
  }
  const body = Buffer.concat([fmt, dataHeader, pcm]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WAVE', 8, 'latin1');
  return Buffer.concat([header, body]);
}

async function waitForServer() {
  for (let i = 0; i < 150; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* поднимается */
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
  dataDir = mkdtempSync(path.join(tmpdir(), 'vision-personal-'));
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
});

describe('API «Для вас»', () => {
  test('пустая библиотека: подборок нет, но есть причина', async () => {
    const res = await fetch(`${BASE}/api/personal`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.sections, []);
    assert.equal(body.libraryTracks, 0);
    assert.match(body.hint, /Библиотека пуста/);
    assert.ok(body.greeting);
    assert.equal(typeof body.seed, 'number');
  });

  test('история прослушиваний меняет подборки', async () => {
    const ambientA = await upload({ title: 'Slow Tide', artist: 'Vision Labs', genre: 'Ambient', duration: 300 }, 1);
    const ambientB = await upload({ title: 'Deep Focus', artist: 'Kite', genre: 'Ambient', duration: 600 }, 2);
    const techno = await upload({ title: 'Night Bus', artist: 'Kite', genre: 'Techno', duration: 200 }, 3);

    // слушаем эмбиент — он становится любимым жанром
    for (const track of [ambientA, ambientB]) {
      const res = await fetch(`${BASE}/api/tracks/${track.id}/listen`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ position: 30, duration: 300, completed: false }),
      });
      assert.ok([200, 204].includes(res.status), await res.text());
    }
    // техно — один раз и до конца
    const done = await fetch(`${BASE}/api/tracks/${techno.id}/listen`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ position: 200, duration: 200, completed: true }),
    });
    assert.ok([200, 204].includes(done.status), await done.text());

    const res = await fetch(`${BASE}/api/personal`, { headers: auth() });
    const body = await res.json();
    assert.equal(body.libraryTracks, 3);
    assert.equal(body.hint, null);

    const top = body.sections.find((section) => section.key === 'top-genre');
    assert.ok(top, 'есть подборка по любимому жанру');
    assert.equal(top.title, 'Любимый жанр: Ambient');
    assert.ok(top.tracks.every((track) => track.genre === 'Ambient'));

    // Записи в подборке — обычные треки: с id, названием и ссылками на поток.
    const one = top.tracks[0];
    assert.equal(typeof one.id, 'string');
    assert.equal(typeof one.title, 'string');
    assert.ok(one.stream || one.sources, 'есть ссылка на поток или реплики');
  });

  test('«Продолжить слушать» знает незаконченный трек', async () => {
    const all = await (await fetch(`${BASE}/api/tracks?limit=10`, { headers: auth() })).json();
    const target = all.find((track) => track.title === 'Deep Focus');
    await fetch(`${BASE}/api/tracks/${target.id}/listen`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ position: 240, duration: 600, completed: false }),
    });

    const body = await (await fetch(`${BASE}/api/personal`, { headers: auth() })).json();
    const section = body.sections.find((item) => item.key === 'continue');
    assert.ok(section, 'подборка появилась');
    assert.equal(section.tracks[0].id, target.id);
    assert.match(section.reason, /остановились/);
  });

  test('seed фиксирует перемешивание, limit ограничивает', async () => {
    const one = await (await fetch(`${BASE}/api/personal?seed=7`, { headers: auth() })).json();
    const two = await (await fetch(`${BASE}/api/personal?seed=7`, { headers: auth() })).json();
    assert.deepEqual(
      one.sections.map((section) => section.tracks.map((track) => track.id)),
      two.sections.map((section) => section.tracks.map((track) => track.id))
    );
    const small = await (await fetch(`${BASE}/api/personal?limit=1`, { headers: auth() })).json();
    for (const section of small.sections) assert.ok(section.tracks.length <= 1);
  });

  test('гость подборок не получает', async () => {
    const res = await fetch(`${BASE}/api/personal`);
    assert.equal(res.status, 401);
  });
});
