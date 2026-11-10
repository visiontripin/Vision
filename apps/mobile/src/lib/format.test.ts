import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadFileName, formatBytes, mimeToExt } from './format.ts';

test('мобильный: форматирование размеров', () => {
  assert.equal(formatBytes(0), '0 МБ');
  assert.equal(formatBytes(-5), '0 МБ');
  assert.equal(formatBytes(50 * 1024), '50 КБ');
  assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 МБ');
  assert.equal(formatBytes(300 * 1024 * 1024), '300 МБ');
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.0 ГБ');
});

test('мобильный: MIME → расширение файла', () => {
  assert.equal(mimeToExt('audio/mpeg'), 'mp3');
  assert.equal(mimeToExt('audio/mp4'), 'm4a');
  assert.equal(mimeToExt('audio/ogg'), 'ogg');
  assert.equal(mimeToExt('audio/ogg; codecs=opus'), 'ogg');
  assert.equal(mimeToExt('AUDIO/WAV'), 'wav');
  assert.equal(mimeToExt(null), 'bin');
  assert.equal(mimeToExt('application/octet-stream'), 'bin');
});

test('мобильный: имя файла офлайн-копии', () => {
  assert.equal(downloadFileName('abc123', 'audio/mp4'), 'abc123.m4a');
  assert.equal(downloadFileName('abc123', null), 'abc123.bin');
});
