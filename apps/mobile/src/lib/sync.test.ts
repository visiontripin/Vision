import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Track } from '@vision/shared';
import {
  DEVICE_TTL_MS,
  EMPTY_REGISTRY,
  activeDevices,
  downloadUrl,
  feedTracks,
  mergeRegistry,
  missingTracks,
  outgoing,
  toSharedTrack,
  type Registry,
  type SharedTrack,
} from './sync';

const now = 1_700_000_000_000;

const device = (id: string, at = now, baseUrl: string | null = 'http://192.168.1.5:4000') => ({
  id,
  name: `Телефон ${id}`,
  baseUrl,
  at,
});

const shared = (id: string, deviceId: string, extra: Partial<SharedTrack> = {}): SharedTrack => ({
  id,
  title: `Трек ${id}`,
  artist: 'Артист',
  duration: 200,
  mime: 'audio/mpeg',
  bytes: 1000,
  checksum: null,
  deviceId,
  deviceName: `Телефон ${deviceId}`,
  downloadable: true,
  updatedAt: now,
  ...extra,
});

const track = (id: string, extra: Partial<Track> = {}): Track => ({
  id,
  title: `Трек ${id}`,
  artist: 'Артист',
  album: null,
  genre: null,
  description: null,
  mime: 'audio/mpeg',
  size: 1000,
  duration: 200,
  peaks: null,
  cover: false,
  plays: 0,
  liked: false,
  createdAt: new Date(now).toISOString(),
  ...extra,
});

test('слияние реестров: побеждает более свежая запись', () => {
  const local: Registry = { version: 1, devices: {}, tracks: { a: shared('a', 'd1', { title: 'Старое', updatedAt: now }) } };
  const incoming: Registry = {
    version: 1,
    devices: { d2: device('d2') },
    tracks: { a: shared('a', 'd1', { title: 'Новое', updatedAt: now + 1000 }), b: shared('b', 'd2') },
  };
  const merged = mergeRegistry(local, incoming);
  assert.equal(merged.tracks.a.title, 'Новое');
  assert.equal(Object.keys(merged.tracks).length, 2);
  assert.ok(merged.devices.d2);

  // старая запись не должна перетирать новую
  const backwards = mergeRegistry(merged, { version: 1, devices: {}, tracks: { a: shared('a', 'd1', { title: 'Древнее', updatedAt: now - 5000 }) } });
  assert.equal(backwards.tracks.a.title, 'Новое');
  // мусор вместо реестра не ломает локальную копию
  assert.equal(mergeRegistry(local, null), local);
});

test('офлайн-устройства исчезают из ленты, свои треки остаются', () => {
  const registry: Registry = {
    version: 1,
    devices: { d1: device('d1', now), d2: device('d2', now - DEVICE_TTL_MS - 1), d3: device('d3', now) },
    tracks: {
      mine: shared('mine', 'd1'),
      theirs: shared('theirs', 'd2'),
      live: shared('live', 'd3', { updatedAt: now + 10 }),
    },
  };
  const feed = feedTracks(registry, 'd1', { now });
  assert.deepEqual(feed.map((item) => item.id), ['live', 'mine']);
  assert.equal(feed.find((item) => item.id === 'mine')?.mine, true);
  assert.equal(feed.find((item) => item.id === 'live')?.mine, false);
  // в ленте чужие треки сверху
  assert.equal(feed[0].mine, false);

  const devices = activeDevices(registry, now);
  assert.deepEqual(devices.map((item) => item.id).sort(), ['d1', 'd3']);
});

test('файл отдаёт реестр, а не телефон: работает в любой сети', () => {
  assert.equal(downloadUrl(shared('a', 'd1'), 'https://sync.example.com/'), 'https://sync.example.com/api/library/a/file');
  // id экранируется — иначе спецсимволы в id сломают путь
  assert.equal(downloadUrl(shared('a b/c', 'd1'), 'https://sync.example.com'), 'https://sync.example.com/api/library/a%20b%2Fc/file');
  // без адреса реестра скачать неоткуда — и это видно в интерфейсе
  assert.equal(downloadUrl(shared('a', 'd1'), null), null);
  assert.equal(downloadUrl(shared('a', 'd1'), ''), null);
});

test('дубликаты не появляются: сверка по id и по контрольной сумме', () => {
  const incoming = [shared('new', 'd2', { checksum: 'abc' }), shared('same-sum', 'd2', { checksum: 'def' }), shared('has-id', 'd2')];
  const missing = missingTracks(incoming, ['has-id'], ['def']);
  assert.deepEqual(missing.map((item) => item.id), ['new']);
});

test('отправка своих треков не сдвигает время у уже опубликованных', () => {
  const published = shared('a', 'me', { updatedAt: now - 1000, bytes: 4242 });
  const registry: Registry = { version: 1, devices: {}, tracks: { a: published } };
  const sent = outgoing(registry, 'me', [track('a'), track('b')], () => 1000, { id: 'me', name: 'Мой телефон' }, true, now);

  assert.equal(sent.length, 2);
  // уже опубликованный трек сохраняет своё время и размер — иначе мы бы
  // перетирали правки других устройств и врали о размере файла
  assert.equal(sent[0].updatedAt, now - 1000);
  assert.equal(sent[0].bytes, 4242);
  // новый получает текущее время
  assert.equal(sent[1].updatedAt, now);
  assert.equal(sent[1].bytes, 1000);
});

test('toSharedTrack не тащит в реестр лишнее', () => {
  const result = toSharedTrack(track('a', { peaks: [1, 2, 3], liked: true, plays: 9 }), { id: 'me', name: 'Телефон' }, 1234, true, now);
  assert.equal(result.bytes, 1234);
  assert.equal(result.deviceId, 'me');
  assert.ok(!('peaks' in result));
  assert.ok(!('plays' in result));
  assert.equal(EMPTY_REGISTRY.tracks && Object.keys(EMPTY_REGISTRY.tracks).length, 0);
});
