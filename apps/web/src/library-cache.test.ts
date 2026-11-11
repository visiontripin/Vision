import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE_KEY,
  CACHE_VERSION,
  clearSnapshot,
  offlineBannerText,
  readSnapshot,
  saveSnapshot,
  snapshotAge,
} from './library-cache';

/**
 * Локальный кэш библиотеки (I5). Тесты закрывают сценарии, которые руками не
 * проверить: переполненный localStorage, снимок от другого сервера, битый JSON,
 * часы, переведённые назад.
 */

function memoryStore(initial: Record<string, string> = {}, quotaBytes = Infinity): Storage {
  const data = new Map(Object.entries(initial));
  const store = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    // квота как у браузера: превысил — исключение, как настоящий QuotaExceededError
    setItem: (key: string, value: string) => {
      if (value.length > quotaBytes) throw new Error('QuotaExceededError');
      data.set(key, value);
    },
    removeItem: (key: string) => void data.delete(key),
  };
  return store as unknown as Storage;
}

/** Трек, близкий к настоящему: волна из 320 пиков — главный потребитель места. */
function bulkTrack(index: number) {
  return {
    id: `id${index}`.padEnd(32, 'a'),
    title: `Трек номер ${index}`,
    artist: 'Vision Labs',
    genre: 'Synthwave',
    duration: 245,
    peaks: Array.from({ length: 320 }, (_, i) => Math.round(Math.sin(i / 7) * 50) / 100),
    checksum: 'a'.repeat(64),
  };
}

const sample = {
  tracks: [{ id: 'a', title: 'Midnight Drive' }],
  playlists: [{ id: 'p', name: 'Вечер' }],
  stats: { tracks: 1, plays: 3 },
};

test('кэш библиотеки: снимок сохраняется и читается', () => {
  const store = memoryStore();
  assert.equal(saveSnapshot(sample, { base: '', now: 1000, store }), true);

  const snapshot = readSnapshot({ base: '', now: 2000 }, store);
  assert.ok(snapshot);
  assert.equal(snapshot.tracks.length, 1);
  assert.equal((snapshot.playlists[0] as { name: string }).name, 'Вечер');
  assert.deepEqual(snapshot.stats, { tracks: 1, plays: 3 });
  assert.equal(snapshot.savedAt, 1000);
  assert.equal(snapshot.version, CACHE_VERSION);
});

test('кэш библиотеки: пустая библиотека — тоже библиотека', () => {
  const store = memoryStore();
  saveSnapshot({ tracks: [], playlists: [], stats: null }, { store });
  const snapshot = readSnapshot({}, store);
  assert.ok(snapshot, 'пустой снимок читается');
  assert.deepEqual(snapshot.tracks, []);
  assert.deepEqual(snapshot.playlists, []);
  assert.equal(snapshot.stats, null);
});

test('кэш библиотеки: чужой сервер и другой формат не читаются', () => {
  const store = memoryStore();
  saveSnapshot(sample, { base: 'http://192.168.1.10:4000', now: 1, store });

  assert.equal(readSnapshot({ base: '' }, store), null, 'тот же origin ≠ другой сервер');
  assert.equal(readSnapshot({ base: 'http://192.168.1.10:4000' }, store)?.tracks.length, 1);

  // версия формата изменилась — старый снимок игнорируем, а не падаем
  store.setItem(CACHE_KEY, JSON.stringify({ version: 99, base: '', savedAt: 1, tracks: [] }));
  assert.equal(readSnapshot({ base: '' }, store), null);
});

test('кэш библиотеки: битый JSON и переполнение не ломают загрузку', () => {
  const store = memoryStore({ [CACHE_KEY]: '{не json' });
  assert.equal(readSnapshot({}, store), null);

  const full = memoryStore();
  full.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  assert.equal(saveSnapshot(sample, { store: full }), false, 'переполнение — false, не исключение');
  assert.equal(clearSnapshot(full), undefined);
});

test('кэш библиотеки: часы назад не дают отрицательный возраст', () => {
  const store = memoryStore();
  saveSnapshot(sample, { now: 5_000, store });
  const snapshot = readSnapshot({ now: 1_000 }, store);
  assert.equal(snapshot?.savedAt, 1_000, 'снимок «из будущего» клампится текущим временем');
});

test('возраст снимка склоняется по-русски', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const at = (msAgo: number) => snapshotAge(now - msAgo, now);

  assert.equal(at(10_000), 'только что');
  assert.equal(at(60_000), '1 минуту назад');
  assert.equal(at(3 * 60_000), '3 минуты назад');
  assert.equal(at(5 * 60_000), '5 минут назад');
  assert.equal(at(2 * 3600_000), '2 часа назад');
  assert.equal(at(21 * 3600_000), '21 час назад');
  assert.equal(at(30 * 3600_000), '1 день назад');
  assert.equal(at(5 * 24 * 3600_000), '5 дней назад');
  assert.equal(snapshotAge(0, now), 'неизвестно когда');
});

test('баннер офлайна: честно про отсутствие копии', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const withCache = offlineBannerText(now - 3 * 60_000, now);
  assert.match(withCache, /сохранённая библиотека \(3 минуты назад\)/);
  assert.doesNotMatch(withCache, /null|undefined|NaN/);

  const without = offlineBannerText(null, now);
  assert.match(without, /сохранённой копии библиотеки нет/);
});

test('кэш библиотеки: при нехватке места сохраняется часть, а не ничего', () => {
  // 20 КБ — влезает примерно 8–12 треков из 60
  const store = memoryStore({}, 20 * 1024);
  const tracks = Array.from({ length: 60 }, (_, i) => bulkTrack(i));
  assert.equal(saveSnapshot({ tracks, playlists: [], stats: null }, { now: 1, store }), true);

  const snapshot = readSnapshot({ now: 2 }, store);
  assert.ok(snapshot, 'частичный снимок читается');
  assert.ok(snapshot.tracks.length > 0, 'влезло хоть что-то');
  assert.ok(snapshot.tracks.length < tracks.length, 'и это честно меньше всей библиотеки');
  assert.equal(snapshot.total, 60, 'total помнит настоящий размер библиотеки');

  const text = offlineBannerText(snapshot.savedAt, 2, {
    saved: snapshot.tracks.length,
    total: snapshot.total,
  });
  assert.match(text, new RegExp(`сохранены первые ${snapshot.tracks.length} из 60 треков`));
});

test('кэш библиотеки: полный снимок не притворяется частичным', () => {
  const store = memoryStore();
  saveSnapshot({ tracks: [bulkTrack(1), bulkTrack(2)], playlists: [], stats: null }, { now: 1, store });
  const snapshot = readSnapshot({ now: 2 }, store);
  assert.equal(snapshot?.total, 2);
  const text = offlineBannerText(1, 2, { saved: 2, total: 2 });
  assert.doesNotMatch(text, /сохранены первые/);
});
