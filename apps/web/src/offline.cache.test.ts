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

function track(id: string, megabytes: number): Track {
  return {
    id,
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

test('офлайн-кэш: ошибка сервера не оставляет мусор в индексе', async () => {
  const { mod } = await setup(10);
  globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;

  await assert.rejects(() => mod.cacheTrack(track('x', 0.01), 'http://vision.local/x'), /Сервер ответил 500/);
  assert.equal(mod.isOfflineCached('x'), false);
  assert.deepEqual(mod.offlineEntries(), []);
});
