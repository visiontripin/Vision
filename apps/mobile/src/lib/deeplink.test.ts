import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIncoming, parsePosition, parseSharedIntent } from './deeplink.ts';

/**
 * Входящие ссылки мобильного приложения (F5) — те же правила, что в вебе.
 * Ссылка приходит из чужого приложения, поэтому проверяем и «правильную
 * разборку», и отказ на мусор: пустой экран тут дороже ошибки.
 */

const ID = '8a02bbc67c18ea75f552118edcd688b4';
const field = (t: ReturnType<typeof parseIncoming>, key: string): unknown =>
  t ? (t as unknown as Record<string, unknown>)[key] : undefined;

test('deep link: трек, позиция, автозапуск', () => {
  const plain = parseIncoming(`visionaudio://track/${ID}`);
  assert.equal(field(plain, 'kind'), 'track');
  assert.equal(field(plain, 'at'), null);
  assert.equal(field(plain, 'autoplay'), false);

  const withTime = parseIncoming(`visionaudio://play/${ID}?t=90`);
  assert.equal(field(withTime, 'at'), 90);
  assert.equal(field(withTime, 'autoplay'), true);

  assert.equal(field(parseIncoming(`visionaudio:play/${ID}`), 'id'), ID);
  assert.equal(field(parseIncoming(`VISIONAUDIO://TRACK/${ID}`), 'id'), ID);
});

test('deep link: плейлист и share', () => {
  const playlist = parseIncoming(`visionaudio://playlist/${ID}?play=1`);
  assert.equal(field(playlist, 'kind'), 'playlist');
  assert.equal(field(playlist, 'autoplay'), true);
  assert.equal(field(parseIncoming('visionaudio://share'), 'kind'), 'share');
});

test('deep link: https с хэшем (ссылка из мессенджера)', () => {
  const parsed = parseIncoming(`https://music.example.com/#/track/${ID}/90`);
  assert.equal(field(parsed, 'kind'), 'track');
  assert.equal(field(parsed, 'at'), 90);
});

test('мусор и чужие адреса → null', () => {
  assert.equal(parseIncoming(''), null);
  assert.equal(parseIncoming(null), null);
  assert.equal(parseIncoming(undefined), null);
  assert.equal(parseIncoming('visionaudio://track/short'), null);
  assert.equal(parseIncoming('visionaudio://album/' + ID), null);
  assert.equal(parseIncoming('https://example.com/статья'), null);
  assert.equal(parseIncoming('просто текст'), null);
});

test('позиция: только неотрицательные секунды', () => {
  assert.equal(parsePosition('90'), 90);
  assert.equal(parsePosition('0'), 0);
  assert.equal(parsePosition('-1'), null);
  assert.equal(parsePosition('abc'), null);
  assert.equal(parsePosition('1e9'), null);
  assert.equal(parsePosition('999999'), 86_400);
});

test('ACTION_SEND: аудиофайл, текст и пустой intent', () => {
  const audio = parseSharedIntent({ action: 'SEND', type: 'audio/mpeg', data: 'content://media/123' });
  assert.deepEqual(audio, { kind: 'audio', uri: 'content://media/123', mime: 'audio/mpeg' });

  const byExtension = parseSharedIntent({ action: 'SEND', data: 'file:///tmp/night.flac' });
  assert.equal(byExtension?.kind, 'audio');

  const text = parseSharedIntent({ action: 'SEND', type: 'text/plain', text: 'послушай https://x.com/a.mp3' });
  assert.deepEqual(text, { kind: 'text', text: 'послушай https://x.com/a.mp3' });

  assert.equal(parseSharedIntent(null), null);
  assert.equal(parseSharedIntent({ action: 'MAIN' }), null);
});
