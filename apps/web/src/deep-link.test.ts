import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canNativeShare, parseDeepLink, parseSeconds, parseShareTarget, trackDeepLink, trackLink,
  type DeepTarget,
} from './deep-link.ts';

/**
 * Достаёт поле из разобранной ссылки, не заставляя каждый тест писать уточнение
 * типа. Возвращает `undefined`, если ссылка не разобралась или вид другой —
 * так проверки «битых ссылок» остаются короткими.
 */
function field(link: DeepTarget | null, key: string): unknown {
  return link ? (link as unknown as Record<string, unknown>)[key] : undefined;
}

/**
 * Вход по ссылке (F5) и share target (F1).
 *
 * Модуль разбирает данные, которые приходят из чужих приложений, поэтому тесты
 * держат две границы: «понятная нам ссылка разбирается в точности» и «непонятная
 * даёт null, а не мусорный объект» — иначе приложение откроет пустой экран.
 */

const ID = '8a02bbc67c18ea75f552118edcd688b4';

test('deep link: трек, позиция и автозапуск', () => {
  assert.deepEqual(parseDeepLink(`visionaudio://track/${ID}`), {
    kind: 'track', id: ID, at: null, autoplay: false,
  });
  assert.deepEqual(parseDeepLink(`visionaudio://track/${ID}?t=90`), {
    kind: 'track', id: ID, at: 90, autoplay: false,
  });
  assert.deepEqual(parseDeepLink(`visionaudio://play/${ID}?t=12`), {
    kind: 'track', id: ID, at: 12, autoplay: true,
  });
  // `/track/<id>/90` — позиция прямо в пути
  assert.equal(field(parseDeepLink(`visionaudio://track/${ID}/90`), 'at'), 90);
});

test('deep link: схема без //, в верхнем регистре и с хвостовым слэшем', () => {
  assert.equal(field(parseDeepLink(`visionaudio:track/${ID}`), 'id'), ID);
  assert.equal(field(parseDeepLink(`VISIONAUDIO://TRACK/${ID}`), 'id'), ID);
  assert.equal(field(parseDeepLink(`VisionAudio://track/${ID}/`), 'id'), ID);
});

test('deep link: плейлист и share-цель', () => {
  assert.deepEqual(parseDeepLink(`visionaudio://playlist/${ID}`), {
    kind: 'playlist', id: ID, autoplay: false,
  });
  assert.deepEqual(parseDeepLink(`visionaudio://playlist/${ID}?play=1`), {
    kind: 'playlist', id: ID, autoplay: true,
  });
  assert.deepEqual(parseDeepLink('visionaudio://share'), { kind: 'share' });
});

test('hex-адреса: разбор ссылки не делает id хостом', () => {
  // регрессия: new URL('visionaudio://track/<id>') теряет путь, потому что track — хост
  const parsed = parseDeepLink(`visionaudio://track/${ID}`);
  assert.ok(parsed, 'ссылка со схемой разобрана');
  assert.equal(parsed.kind, 'track');
});

test('веб-адреса: хэш и полный URL с хэшем', () => {
  assert.equal(field(parseDeepLink(`#/track/${ID}`), 'id'), ID);
  assert.equal(field(parseDeepLink(`#/track/${ID}/90`), 'at'), 90);
  assert.equal(field(parseDeepLink(`https://music.example.com/#/track/${ID}`), 'id'), ID);
  assert.equal(field(parseDeepLink(`https://music.example.com/#/playlist/${ID}`), 'kind'), 'playlist');
});

test('битые и чужие ссылки → null, а не «пустой трек»', () => {
  assert.equal(parseDeepLink(''), null);
  assert.equal(parseDeepLink('   '), null);
  assert.equal(parseDeepLink(`visionaudio://track/короткий`), null);
  assert.equal(parseDeepLink(`visionaudio://track/${ID.slice(0, 31)}`), null);
  assert.equal(parseDeepLink('visionaudio://album/' + ID), null);
  assert.equal(parseDeepLink('https://example.com/foo'), null);
  assert.equal(parseDeepLink('https://youtube.com/watch?v=1'), null);
  assert.equal(parseDeepLink('обычный текст без ссылки'), null);
});

test('позиция: только неотрицательные секунды, большие клампятся', () => {
  assert.equal(parseSeconds('90'), 90);
  assert.equal(parseSeconds('0'), 0);
  assert.equal(parseSeconds('90.9'), 90);
  assert.equal(parseSeconds('-5'), null);
  assert.equal(parseSeconds('abc'), null);
  assert.equal(parseSeconds(''), null);
  assert.equal(parseSeconds('1e9'), null);
  assert.equal(parseSeconds('999999'), 86_400);
  assert.equal(parseSeconds('5000', 60), 60);
  // мусор в query не ломает ссылку: позиции просто нет
  assert.equal(field(parseDeepLink(`visionaudio://track/${ID}?t=abc`), 'at'), null);
});

test('share target: ссылка на аудио, страница и текст', () => {
  const remote = parseShareTarget('?url=https%3A%2F%2Ffiles.example.com%2Fnight.flac&title=Night');
  assert.deepEqual(remote, { kind: 'remote', url: 'https://files.example.com/night.flac', title: 'Night' });

  // Android часто кладёт адрес в text
  const fromText = parseShareTarget('text=слушай%20https%3A%2F%2Ffiles.example.com%2Fa.mp3%20круто');
  assert.equal(fromText.kind, 'remote');
  assert.equal('url' in fromText && fromText.url, 'https://files.example.com/a.mp3');

  const page = parseShareTarget('?url=https%3A%2F%2Fexample.com%2Farticle');
  assert.equal(page.kind, 'link');

  assert.deepEqual(parseShareTarget('text=просто%20заметка'), { kind: 'text', text: 'просто заметка' });
  assert.deepEqual(parseShareTarget(''), { kind: 'empty' });
  assert.deepEqual(parseShareTarget(new URLSearchParams()), { kind: 'empty' });
});

test('share target: не-http схемы не превращаются в загрузку', () => {
  const payload = parseShareTarget('?url=javascript%3Aalert(1)');
  assert.notEqual(payload.kind, 'remote');
  assert.notEqual(payload.kind, 'link');
});

test('обратные ссылки: для буфера и для Android', () => {
  assert.equal(trackLink(ID, 'https://music.example.com/'), `https://music.example.com/#/track/${ID}`);
  assert.equal(trackDeepLink(ID), `visionaudio://track/${ID}`);
  assert.equal(trackDeepLink(ID, 90), `visionaudio://track/${ID}?t=90`);
  assert.equal(trackDeepLink(ID, 0), `visionaudio://track/${ID}`);
});

test('системный диалог: мобильные да, десктопный браузер нет', () => {
  assert.equal(canNativeShare({ hasNavigatorShare: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel)' }), true);
  assert.equal(canNativeShare({ hasNavigatorShare: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' }), true);
  assert.equal(canNativeShare({ hasNavigatorShare: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), false);
  assert.equal(canNativeShare({ hasNavigatorShare: false, userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), false);
  assert.equal(canNativeShare(), false);
});
