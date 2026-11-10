import test from 'node:test';
import assert from 'node:assert/strict';
import type { Track } from '@vision/shared';

/**
 * Проверка офлайн-кэша на фейковом Cache Storage.
 *
 * В Node нет ни Cache Storage, ни localStorage, ни window — поэтому подменяем их
 * минимальными реализациями. Так тест проходит без браузера, а логика
 * (запись, вытеснение, индекс, object URL) остаётся настоящей.
 */

const MB = 1024 * 1024;

class FakeCache {
  map = new Map<string, Response>();

  async put(key: RequestInfo | URL, response: Response) {
    this.map.set(String(key), response.clone());
  }

  async match(key: RequestInfo | URL) {
    const found = this.map.get(String(key));
    return found ? found.clone() : undefined;
  }

  async delete(key: RequestInfo | URL) {
    return this.map.delete(String(key));
  }

  async keys() {
    return [...this.map.keys()].map((key) => new Request(new URL(key, 'http://vision.local')));
  }
}

function track(id: string, megabytes: number, checksum?: string): Track {
  return {
    id,
    checksum,
    title: `Track ${id}`,
    artist: 'Test',
    album: '',
    genre: '',
    duration: megabytes * 60,
    peaks: null,
    likes: 0,
    plays: 0,
    liked: false,
    size: megabytes * MB,
  } as unknown as Track;
}

async function setup(limitMb = 4) {
  const cachesMap = new Map<string, FakeCache>();
  const storage = new Map<string, string>([['vision.offline.limitMb', String(limitMb)]]);

  const fakeCaches = {
    async open(name: string) {
      if (!cachesMap.has(name)) cachesMap.set(name, new FakeCache());
      return cachesMap.get(name)!;
    },
    async keys() {
      return [...cachesMap.keys()];
    },
    async delete(name: string) {
      return cachesMap.delete(name);
    },
    async match() {
      return undefined;
    },
  };

  const g = globalThis as unknown as Record<string, unknown>;
  g.window = globalThis;
  g.CacheStorage = class {};
  g.caches = fakeCaches;
  g.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  };

  // каждый тест — свой экземпляр модуля (своя подписка и свой кэш blob-URL)
  const mod = await import(`./offline.ts?cache=${Math.random()}`);
  return { mod, storage, cachesMap };
}

function stubFetch(bytes: number) {
  globalThis.fetch = (async () =>
    new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-length': String(bytes), 'content-type': 'audio/ogg' },
    })) as typeof fetch;
}

test('офлайн-кэш: копия пишется в Cache Storage, индекс обновляется', async () => {
  const { mod } = await setup(10);
  stubFetch(1 * MB);

  const entry = await mod.cacheTrack(track('a', 1), 'http://vision.local/api/tracks/a/stream', {
    onProgress: () => {},
  });

  assert.equal(entry.id, 'a');
  assert.equal(entry.bytes, MB);
  assert.equal(mod.isOfflineCached('a'), true);
  assert.equal(mod.offlineTotalBytes(), MB);

  const cached = await mod.offlinePlayableUrl('a');
  assert.match(String(cached), /^blob:/);
  mod.revokeOfflineUrl('a');
});

test('офлайн-кэш: при переполнении лимита уходит самая старая копия', async () => {
  const { mod } = await setup(2);
  stubFetch(1 * MB);

  await mod.cacheTrack(track('old', 1), 'http://vision.local/1');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await mod.cacheTrack(track('mid', 1), 'http://vision.local/2');
  await new Promise((resolve) => setTimeout(resolve, 5));
  // третья копия не влезает: 2 МБ лимита, уже занято 2 МБ
  await mod.cacheTrack(track('new', 1), 'http://vision.local/3');

  const ids = mod.offlineEntries().map((item: { id: string }) => item.id);
  assert.deepEqual(ids, ['new', 'mid']);
  assert.equal(mod.isOfflineCached('old'), false);
  assert.equal(mod.isOfflineCached('mid'), true);
});

test('офлайн-кэш: удаление и полная очистка', async () => {
  const { mod } = await setup(10);
  stubFetch(512 * 1024);

  await mod.cacheTrack(track('a', 0.5), 'http://vision.local/a');
  await mod.cacheTrack(track('b', 0.5), 'http://vision.local/b');
  assert.equal(mod.offlineEntries().length, 2);

  await mod.removeOffline('a');
  assert.equal(mod.isOfflineCached('a'), false);
  assert.equal(mod.offlineEntries().length, 1);

  await mod.clearOffline();
  assert.equal(mod.offlineEntries().length, 0);
  assert.equal(await mod.offlinePlayableUrl('b'), null);
});

test('офлайн-кэш: копия адресуется sha256 — другой id того же файла не качается второй раз', async () => {
  const { mod, cachesMap } = await setup(10);
  stubFetch(1 * MB);
  const hash = 'a'.repeat(64);

  const first = await mod.cacheTrack(track('import-1', 1, hash), 'http://vision.local/1');
  assert.equal(first.hash, hash);
  assert.equal(mod.isOfflineCached(hash), true);
  assert.equal(mod.isOfflineCached('import-1'), true, 'старый id тоже находит копию');

  // тот же файл импортировали заново — у него новый id, но то же содержимое
  const second = await mod.cacheTrack(track('import-2', 1, hash), 'http://vision.local/2');
  assert.equal(second.id, 'import-2');
  assert.equal(mod.offlineEntries().length, 1, 'копия одна');
  assert.equal(mod.isOfflineCached(hash), true);
  assert.equal(mod.isOfflineCached('import-2'), true);
  assert.equal(mod.isOfflineCached('import-1'), false, 'прежняя строка трека больше не в индексе');

  // в Cache Storage ключ — контентный
  const cache = await cachesMap.get('vision-media-v1')!.keys();
  assert.deepEqual(cache.map((request) => new URL(request.url).pathname), [`/__vision-offline/${hash}`]);

  assert.match(String(await mod.offlinePlayableUrl(hash)), /^blob:/);
  assert.match(String(await mod.offlinePlayableUrl('import-2')), /^blob:/);

  await mod.removeOffline('import-2');
  assert.equal(mod.isOfflineCached(hash), false);
});

test('офлайн-кэш: копия старого формата без hash находится по id', async () => {
  const { mod, storage, cachesMap } = await setup(10);
  storage.set(
    'vision.offline.index',
    JSON.stringify([{ id: 'legacy', title: 'L', artist: 'A', bytes: MB, at: Date.now() }])
  );
  const cache = await cachesMap.get('vision-media-v1');
  const target = cache ?? (await (globalThis as any).caches.open('vision-media-v1'));
  await target.put('/__vision-offline/legacy', new Response(new Uint8Array(MB), {
    headers: { 'content-type': 'audio/mpeg' },
  }));

  assert.equal(mod.isOfflineCached('legacy'), true);
  assert.match(String(await mod.offlinePlayableUrl('legacy')), /^blob:/);

  await mod.removeOffline('legacy');
  assert.equal(mod.isOfflineCached('legacy'), false);
  assert.deepEqual(mod.offlineEntries(), []);
});

test('офлайн-кэш: копия, скачанная до трекера (ключ — id), находится по checksum', async () => {
  const { mod, storage, cachesMap } = await setup(10);
  const hash = 'c'.repeat(64);
  // так выглядела запись до v0.10.1: ключ — id, поля hash ещё нет
  storage.set(
    'vision.offline.index',
    JSON.stringify([{ id: 'old-track', title: 'O', artist: 'A', bytes: MB, at: Date.now() }])
  );
  const cache = await (globalThis as any).caches.open('vision-media-v1');
  await cache.put(
    '/__vision-offline/old-track',
    new Response(new Uint8Array(MB), { headers: { 'content-type': 'audio/mpeg' } })
  );

  const nowHasChecksum = { id: 'old-track', checksum: hash };
  assert.equal(mod.isTrackCached(nowHasChecksum), true, 'id-запись всё ещё считается копией');
  assert.match(String(await mod.offlinePlayable(nowHasChecksum)), /^blob:/);

  // повторное скачивание переводит запись на контентный ключ и убирает старый
  stubFetch(MB);
  await mod.cacheTrack(track('old-track', 1, hash), 'http://vision.local/x');
  const keys = (await cachesMap.get('vision-media-v1')!.keys()).map(
    (request) => new URL(request.url).pathname
  );
  assert.deepEqual(keys, [`/__vision-offline/${hash}`]);
  assert.equal(mod.offlineEntries().length, 1);

  await mod.removeTrackCopy(nowHasChecksum);
  assert.equal(mod.isTrackCached(nowHasChecksum), false);
  assert.equal(mod.isOfflineCached(hash), false);
});

test('офлайн-кэш: ошибка сервера не оставляет мусор в индексе', async () => {
  const { mod } = await setup(10);
  globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;

  await assert.rejects(() => mod.cacheTrack(track('x', 0.01), 'http://vision.local/x'), /Сервер ответил 500/);
  assert.equal(mod.isOfflineCached('x'), false);
  assert.deepEqual(mod.offlineEntries(), []);
});
