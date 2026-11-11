import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LIMIT, MAX_LIMIT, RuleError, buildSmartQuery, describeRules, escapeLike, normalizeRules,
} from '../src/smart.js';

/**
 * Умные плейлисты по правилам (Фаза 5, C7).
 *
 * Две группы проверок:
 *  1. разбор правил — что человек увидит при опечатке и что нельзя подставить
 *     в SQL (правила приходят из JSON, то есть из пользовательского ввода);
 *  2. контракт API — состав пересчитывается сам, лимит и сортировка — часть
 *     правил, ошибки правил дают 400 с кодом, битые правила в базе — 422.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 4798;
const BASE = `http://127.0.0.1:${PORT}`;

/* ------------------------------ разбор правил ----------------------------- */

describe('правила: разбор и отказ', () => {
  test('правильное правило разбирается в канонический вид', () => {
    const rules = normalizeRules({
      match: 'any',
      rules: [
        { field: 'genre', op: 'is', value: 'Ambient' },
        { field: 'duration', op: 'gte', value: '300' },
        { field: 'liked', op: 'is', value: 'true' },
      ],
      sort: 'plays',
      limit: 40,
    });
    assert.equal(rules.match, 'any');
    assert.deepEqual(rules.rules[0], { field: 'genre', op: 'is', value: 'Ambient' });
    assert.equal(rules.rules[1].value, 300, 'число приводится из строки');
    assert.equal(rules.rules[2].value, true, 'лайк — булево, а не строка');
    assert.equal(rules.sort, 'plays');
    assert.equal(rules.limit, 40);
  });

  test('умолчания: «все правила», свежие, лимит по умолчанию', () => {
    const rules = normalizeRules({ rules: [{ field: 'liked', op: 'is', value: false }] });
    assert.equal(rules.match, 'all');
    assert.equal(rules.sort, 'recent');
    assert.equal(rules.limit, DEFAULT_LIMIT);
    assert.equal(normalizeRules({ rules: [{ field: 'genre', op: 'any' }] }).rules[0].op, 'any');
  });

  test('лимит зажимается, а не отклоняется', () => {
    const rules = normalizeRules({ rules: [{ field: 'liked', op: 'is', value: true }], limit: 99999 });
    assert.equal(rules.limit, MAX_LIMIT, 'лимит сверху ограничен');
    assert.equal(normalizeRules({ rules: [{ field: 'liked', op: 'is', value: true }], limit: -5 }).limit, DEFAULT_LIMIT);
  });

  test('ошибки правил объясняют, что не так, и не раскрывают SQL', () => {
    const cases = [
      [{ rules: [] }, /хотя бы одно правило/],
      [{ rules: [{ field: 'bpm', op: 'gte', value: 1 }] }, /неизвестное поле «bpm»/],
      [{ rules: [{ field: 'genre', op: 'gte', value: 1 }] }, /не подходит для поля «genre»/],
      [{ rules: [{ field: 'plays', op: 'gte', value: 'много' }] }, /нужно число/],
      [{ rules: [{ field: 'genre', op: 'is', value: '   ' }] }, /нужно значение/],
      [{ rules: [{ field: 'liked', op: 'is', value: 'может быть' }] }, /true или false/],
      [{}, /хотя бы одно правило/],
      [null, /Нужны правила/],
    ];
    for (const [input, pattern] of cases) {
      assert.throws(() => normalizeRules(input), (error) => {
        assert.ok(error instanceof RuleError, 'ожидалась RuleError');
        assert.match(error.message, pattern);
        assert.doesNotMatch(error.message, /SELECT|WHERE|t\.genre/, 'в тексте нет SQL');
        return true;
      });
    }
  });

  test('слишком много правил — отказ, а не тихое усечение', () => {
    const many = Array.from({ length: 13 }, () => ({ field: 'genre', op: 'any' }));
    assert.throws(() => normalizeRules({ rules: many }), /Не больше 12 правил/);
  });

  test('неизвестная сортировка не ломает запрос', () => {
    const rules = normalizeRules({ rules: [{ field: 'genre', op: 'any' }], sort: 'по-алфавиту' });
    assert.equal(buildSmartQuery(rules).order, 't.created_at DESC');
    // сортировка по вычисляемому полю (дни) не имеет смысла — откат на дату
    assert.equal(
      buildSmartQuery(normalizeRules({ rules: [{ field: 'genre', op: 'any' }], sort: 'field:notPlayedDays' })).order,
      't.created_at DESC'
    );
  });
});

/* --------------------------------- SQL ----------------------------------- */

describe('правила: SQL', () => {
  test('значения всегда параметры, в тексте запроса — только колонки', () => {
    const query = buildSmartQuery(
      normalizeRules({
        rules: [
          { field: 'genre', op: 'is', value: "Ambient'; DROP TABLE tracks; --" },
          { field: 'artist', op: 'contains', value: "50%_off" },
        ],
      })
    );
    assert.doesNotMatch(query.where, /DROP|Ambient/);
    assert.equal(query.params.length, 2);
    assert.equal(query.params[0], "Ambient'; DROP TABLE tracks; --");
    assert.equal(query.params[1], '%50\\%\\_off%', 'LIKE-шаблон экранирует % и _');
    assert.match(query.where, /LIKE \? ESCAPE/);
  });

  test('«любое из» и «все» дают разную склейку', () => {
    const rules = [
      { field: 'genre', op: 'is', value: 'Ambient' },
      { field: 'liked', op: 'is', value: true },
    ];
    assert.match(buildSmartQuery(normalizeRules({ match: 'all', rules })).where, /AND/);
    assert.match(buildSmartQuery(normalizeRules({ match: 'any', rules })).where, /OR/);
  });

  test('«забытые» подключают историю, остальные правила — нет', () => {
    const plain = buildSmartQuery(normalizeRules({ rules: [{ field: 'genre', op: 'any' }] }));
    assert.equal(plain.from, 'FROM tracks t');

    const forgotten = buildSmartQuery(normalizeRules({ rules: [{ field: 'notPlayedDays', op: 'gte', value: 30 }] }));
    assert.match(forgotten.from, /LEFT JOIN listens/);
    assert.match(forgotten.where, /1000000/, 'никогда не слушали — тоже «забытые»');
    assert.equal(forgotten.params[0], 30);
  });

  test('пустой жанр и «заполненный» — разные правила', () => {
    assert.match(buildSmartQuery(normalizeRules({ rules: [{ field: 'genre', op: 'empty' }] })).where, /IS NULL/);
    assert.match(buildSmartQuery(normalizeRules({ rules: [{ field: 'genre', op: 'any' }] })).where, /<> ''/);
  });

  test('escapeLike не удваивает экранирование', () => {
    assert.equal(escapeLike('a%b_c\\d'), 'a\\%b\\_c\\\\d');
    assert.equal(escapeLike('просто'), 'просто');
  });

  test('описание правил читается человеком', () => {
    const rules = normalizeRules({
      rules: [
        { field: 'genre', op: 'is', value: 'Ambient' },
        { field: 'duration', op: 'gte', value: 300 },
        { field: 'liked', op: 'is', value: false },
      ],
    });
    assert.equal(describeRules(rules), 'жанр = Ambient и длительность ≥ 300 и без лайка');
  });
});

/* ------------------------------ API целиком ------------------------------- */

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
    pcm.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * (220 + seed * 20)) * 0.4 * 32767), i * 2);
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
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* поднимается */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('сервер не поднялся');
}

const auth = () => ({ Authorization: `Bearer ${token}`, 'content-type': 'application/json' });

async function upload(track) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(track)) query.set(key, String(value));
  const res = await fetch(`${BASE}/api/tracks?${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/wav' },
    body: wav({ seconds: 0.2 + Math.random() * 0.1, seed: Math.round(Math.random() * 9) }),
  });
  if (res.status !== 201) throw new Error(`upload ${res.status}: ${await res.text()}`);
  return res.json();
}

async function call(method, requestPath, body) {
  const res = await fetch(`${BASE}${requestPath}`, {
    method,
    headers: auth(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, total: res.headers.get('x-total-count'), data: text ? JSON.parse(text) : null };
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'vision-smart-'));
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

  await upload({ title: 'Midnight Drive', artist: 'Vision Labs', genre: 'Synthwave', duration: 200 });
  await upload({ title: 'Slow Tide', artist: 'Vision Labs', genre: 'Ambient', duration: 400 });
  await upload({ title: 'Deep Focus', artist: 'Kite', genre: 'Ambient', duration: 600 });
  await upload({ title: 'Night Bus', artist: 'Kite', genre: 'Techno', duration: 300 });
});

after(() => {
  child?.kill('SIGTERM');
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe('API умных плейлистов', () => {
  test('плейлист хранит правила, а состав пересчитывается сам', async () => {
    const created = await call('POST', '/api/smart-playlists', {
      name: 'Вечерний эмбиент',
      rules: {
        match: 'all',
        rules: [{ field: 'genre', op: 'is', value: 'Ambient' }],
        sort: 'duration',
        limit: 10,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.smart, true);
    assert.equal(created.data.trackCount, 2);
    assert.equal(created.data.summary, 'жанр = Ambient', 'правила объяснены по-русски');
    assert.deepEqual(created.data.rules.rules[0], { field: 'genre', op: 'is', value: 'Ambient' });

    const id = created.data.id;
    const tracks = await call('GET', `/api/smart-playlists/${id}/tracks`);
    assert.equal(tracks.status, 200);
    assert.equal(tracks.total, '2');
    assert.deepEqual(tracks.data.map((track) => track.title), ['Deep Focus', 'Slow Tide'], 'сортировка по длительности');

    // Новый трек подходящего жанра попадает в плейлист без правки правил.
    await upload({ title: 'Night Fog', artist: 'Kite', genre: 'Ambient', duration: 120 });
    const after = await call('GET', `/api/smart-playlists/${id}/tracks`);
    assert.equal(after.total, '3');
    assert.ok(after.data.some((track) => track.title === 'Night Fog'));
    assert.equal((await call('GET', `/api/smart-playlists/${id}`)).data.trackCount, 3);
  });

  test('лимит и «любое из правил» — часть правил', async () => {
    const created = await call('POST', '/api/smart-playlists', {
      name: 'Короткий список',
      rules: {
        match: 'any',
        rules: [
          { field: 'genre', op: 'is', value: 'Ambient' },
          { field: 'genre', op: 'is', value: 'Techno' },
        ],
        sort: 'title',
        limit: 2,
      },
    });
    assert.equal(created.data.trackCount, 4, 'совпадений четыре');
    const tracks = await call('GET', `/api/smart-playlists/${created.data.id}/tracks`);
    assert.equal(tracks.data.length, 2, 'но лимит правила ограничивает выдачу');
    assert.equal(tracks.total, '4', 'X-Total-Count показывает полное число совпадений');
    assert.deepEqual(tracks.data.map((track) => track.title), ['Deep Focus', 'Night Bus']);
  });

  test('правило по лайку и по «забытым»', async () => {
    // лайк ставится PATCH-ем трека (отдельного /like в контракте нет)
    const any = await call('GET', '/api/tracks?limit=1');
    const likedRes = await fetch(`${BASE}/api/tracks/${any.data[0].id}`, {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ liked: true }),
    });
    assert.equal(likedRes.status, 200, await likedRes.text());

    const liked = await call('POST', '/api/smart-playlists', {
      name: 'Любимое',
      rules: { rules: [{ field: 'liked', op: 'is', value: true }] },
    });
    assert.equal(liked.data.trackCount, 1);
    assert.equal(liked.data.summary, 'лайк');

    const forgotten = await call('POST', '/api/smart-playlists', {
      name: 'Забытое',
      rules: { rules: [{ field: 'notPlayedDays', op: 'gte', value: 30 }] },
    });
    assert.ok(forgotten.data.trackCount >= 3, 'ничего не слушали — всё забыто');
    assert.equal(forgotten.data.summary, 'не слушал дней ≥ 30');
  });

  test('ошибка в правилах — 400 с кодом, понятным клиенту', async () => {
    const cases = [
      [{ rules: [] }, 'invalid_rules'],
      [{ rules: [{ field: 'bpm', op: 'gte', value: 120 }] }, 'unknown_field'],
      [{ rules: [{ field: 'genre', op: 'gte', value: 5 }] }, 'unknown_op'],
      [{ rules: [{ field: 'plays', op: 'gte', value: 'много' }] }, 'invalid_value'],
    ];
    for (const [rules, code] of cases) {
      const res = await call('POST', '/api/smart-playlists', { name: 'Ошибка', rules });
      assert.equal(res.status, 400, code);
      assert.equal(res.data.error.code, code);
    }
    assert.equal((await call('POST', '/api/smart-playlists', { name: '', rules: { rules: [{ field: 'genre', op: 'any' }] } })).status, 400);
  });

  test('значение правила не может стать SQL', async () => {
    const injection = "Ambient'; DROP TABLE tracks; --";
    const res = await call('POST', '/api/smart-playlists', {
      name: 'Инъекция',
      rules: { rules: [{ field: 'genre', op: 'is', value: injection }] },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.trackCount, 0, 'просто несуществующий жанр');
    assert.equal(res.data.rules.rules[0].value, injection, 'значение сохранено как есть');

    const tracks = await call('GET', '/api/tracks?limit=100');
    assert.ok(tracks.data.length >= 4, 'таблица tracks на месте');
    const again = await call('GET', `/api/smart-playlists/${res.data.id}/tracks`);
    assert.equal(again.status, 200);
    assert.equal(again.data.length, 0);
  });

  test('изменение правил, удаление и 404', async () => {
    const created = await call('POST', '/api/smart-playlists', {
      name: 'Черновик',
      rules: { rules: [{ field: 'genre', op: 'is', value: 'Techno' }] },
    });
    const id = created.data.id;

    const patched = await call('PATCH', `/api/smart-playlists/${id}`, {
      name: 'Техно и эмбиент',
      rules: { rules: [{ field: 'genre', op: 'is', value: 'Techno' }, { field: 'genre', op: 'is', value: 'Ambient' }], match: 'any' },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.name, 'Техно и эмбиент');
    assert.ok(patched.data.trackCount >= 3);

    const badPatch = await call('PATCH', `/api/smart-playlists/${id}`, { rules: { rules: [{ field: 'nope', op: 'is', value: 1 }] } });
    assert.equal(badPatch.status, 400, 'битые правила не сохраняются');
    assert.equal((await call('GET', `/api/smart-playlists/${id}`)).data.name, 'Техно и эмбиент');

    assert.equal((await call('DELETE', `/api/smart-playlists/${id}`)).status, 204);
    assert.equal((await call('GET', `/api/smart-playlists/${id}`)).status, 404);
    assert.equal((await call('GET', `/api/smart-playlists/${id}/tracks`)).status, 404);

    const ids = new Set((await call('GET', '/api/smart-playlists')).data.map((item) => item.id));
    assert.equal(ids.has(id), false, 'удалённый не висит в списке');
  });

  test('обычные плейлисты не сломались', async () => {
    const playlist = await call('POST', '/api/playlists', { name: 'Руками' });
    assert.equal(playlist.status, 201);
    assert.equal(playlist.data.smart, undefined, 'у обычного плейлиста нет флага smart');
    assert.equal((await call('GET', '/api/playlists')).data.length, 1);
  });
});
