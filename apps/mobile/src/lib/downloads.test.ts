import test from 'node:test';
import assert from 'node:assert/strict';
import { findCopy } from './downloads.ts';

type Copy = { id: string; hash?: string; uri: string };

const index: Record<string, Copy> = {
  'track-1': { id: 'track-1', hash: 'a'.repeat(64), uri: 'file:///vision/track-1.m4a' },
  legacy: { id: 'legacy', uri: 'file:///vision/legacy.mp3' },
};

test('копия находится по id трека', () => {
  assert.equal(findCopy(index, 'track-1')?.uri, 'file:///vision/track-1.m4a');
});

test('копия находится по sha256 — другой id того же файла видит ту же копию', () => {
  assert.equal(findCopy(index, 'a'.repeat(64))?.id, 'track-1');
});

test('копия без hash (старый индекс) находится только по id', () => {
  assert.equal(findCopy(index, 'legacy')?.uri, 'file:///vision/legacy.mp3');
  assert.equal(findCopy(index, 'b'.repeat(64)), null);
});

test('пустые и незнакомые ключи не ломают поиск', () => {
  assert.equal(findCopy(index, ''), null);
  assert.equal(findCopy(index, null), null);
  assert.equal(findCopy(index, undefined), null);
  assert.equal(findCopy({}, 'track-1'), null);
});
