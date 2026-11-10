import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseName } from './audio.ts';

test('имя файла: исполнитель и название', () => {
  assert.deepEqual(parseName('Kira Voss - Neon Rain.mp3'), {
    artist: 'Kira Voss',
    title: 'Neon Rain',
  });
  assert.deepEqual(parseName('Kira Voss - Neon Rain (Extended).flac'), {
    artist: 'Kira Voss',
    title: 'Neon Rain (Extended)',
  });
});

test('номер трека не считается исполнителем', () => {
  assert.deepEqual(parseName('01 - Midnight Drive.mp3'), {
    artist: 'Unknown',
    title: 'Midnight Drive',
  });
  assert.deepEqual(parseName('07. Slow Tide.wav'), {
    artist: 'Unknown',
    title: 'Slow Tide',
  });
  assert.deepEqual(parseName('12 Harbour Lights.m4a'), {
    artist: 'Unknown',
    title: 'Harbour Lights',
  });
});

test('одиночное имя и подчёркивания', () => {
  assert.deepEqual(parseName('static_bloom.mp3'), {
    artist: 'Unknown',
    title: 'static bloom',
  });
  assert.deepEqual(parseName('Без названия.wav'), {
    artist: 'Unknown',
    title: 'Без названия',
  });
});
