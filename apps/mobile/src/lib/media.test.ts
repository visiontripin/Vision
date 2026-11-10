import test from 'node:test';
import assert from 'node:assert/strict';
import { pickDownloadSource, pickStreamSource } from './media.ts';

test('мобильный: для скачивания предпочитаем AAC, потом оригинал', () => {
  const streams = {
    original: 'https://srv/stream?format=original',
    opus: 'https://srv/stream?format=opus',
    aac: 'https://srv/stream?format=aac',
  };
  assert.deepEqual(pickDownloadSource(streams, 'audio/wav', 'https://srv/stream'), {
    url: streams.aac,
    mime: 'audio/mp4',
  });
});

test('мобильный: без AAC качаем оригинал с его MIME', () => {
  const streams = { original: 'https://srv/stream', opus: 'https://srv/stream?format=opus' };
  assert.deepEqual(pickDownloadSource(streams, 'audio/mpeg', null), {
    url: 'https://srv/stream',
    mime: 'audio/mpeg',
  });
});

test('мобильный: только opus — последний вариант, MIME ogg', () => {
  assert.deepEqual(pickDownloadSource({ opus: 'https://srv/opus' }, 'audio/mpeg', null), {
    url: 'https://srv/opus',
    mime: 'audio/ogg',
  });
});

test('мобильный: ссылки нет — честный null', () => {
  assert.equal(pickDownloadSource(undefined, 'audio/mpeg', null), null);
});

test('мобильный: для стрима AAC → оригинал → fallback → opus', () => {
  assert.equal(pickStreamSource({ aac: 'a', original: 'o' }, 'f'), 'a');
  assert.equal(pickStreamSource({ original: 'o' }, 'f'), 'o');
  assert.equal(pickStreamSource({}, 'f'), 'f');
  assert.equal(pickStreamSource({ opus: 'p' }, null), 'p');
  assert.equal(pickStreamSource(undefined, null), null);
});
