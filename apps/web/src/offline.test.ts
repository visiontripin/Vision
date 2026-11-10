import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBytes, offlineEntries, offlineRef, offlineTotalBytes, pickEvictions, type OfflineEntry,
} from './offline.ts';

const MB = 1024 * 1024;

function entry(id: string, megabytes: number, at: number, hash = ''): OfflineEntry {
  return { id, hash, title: id, artist: 'Test', bytes: megabytes * MB, at };
}

test('офлайн: пока влезает в лимит — ничего не удаляем', () => {
  const entries = [entry('a', 10, 1), entry('b', 20, 2)];
  assert.deepEqual(pickEvictions(entries, 5 * MB, 100 * MB), []);
});

test('офлайн: при переполнении вытесняются самые старые копии', () => {
  const entries = [entry('old', 40, 1), entry('mid', 40, 2), entry('new', 40, 3)];
  // добавили 40 МБ при лимите 100 → нужно освободить 60, уходят old и mid
  assert.deepEqual(pickEvictions(entries, 40 * MB, 100 * MB), ['old', 'mid']);
});

test('офлайн: перекачиваемая копия не считается дважды и не вытесняет саму себя', () => {
  const entries = [entry('same', 50, 5), entry('other', 30, 1)];
  // same не учитываем (она перезапишется), лимит 60: 30 (other) + 40 (новая) = 70
  assert.deepEqual(pickEvictions(entries, 40 * MB, 60 * MB, 'same'), ['other']);
  // а если влезает — не трогаем ничего
  assert.deepEqual(pickEvictions(entries, 20 * MB, 60 * MB, 'same'), []);
});

test('офлайн: лимит меньше одной копии не ломает логику', () => {
  const entries = [entry('a', 10, 1)];
  assert.deepEqual(pickEvictions(entries, 5 * MB, 0), ['a']);
});

test('офлайн: суммы и форматирование размеров', () => {
  assert.equal(offlineTotalBytes([]), 0);
  assert.equal(offlineTotalBytes([entry('a', 2, 1), entry('b', 3, 2)]), 5 * MB);
  assert.equal(formatBytes(0), '0 МБ');
  assert.equal(formatBytes(512 * 1024), '0.5 МБ');
  assert.equal(formatBytes(50 * 1024), '50 КБ');
  assert.equal(formatBytes(5 * MB), '5.0 МБ');
  assert.equal(formatBytes(250 * MB), '250 МБ');
  assert.equal(formatBytes(2048 * MB), '2.0 ГБ');
});

test('офлайн: ключ копии — sha256 содержимого, иначе id трека', () => {
  assert.equal(offlineRef({ id: 'abc', checksum: 'f'.repeat(64) }), 'f'.repeat(64));
  assert.equal(offlineRef({ id: 'abc' }), 'abc');
  assert.equal(offlineRef({ id: 'abc', checksum: '' }), 'abc');
  assert.equal(offlineRef(null), '');
});

test('офлайн: без localStorage и Cache Storage модуль не падает', () => {
  // в Node этих API нет — это тот же случай, что http://<ip> без HTTPS
  assert.deepEqual(offlineEntries(), []);
});
