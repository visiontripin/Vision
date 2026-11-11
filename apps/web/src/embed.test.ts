import test from 'node:test';
import assert from 'node:assert/strict';
import { embedCode, oembedUrl } from '@vision/shared';

/**
 * Код встраивания (Фаза 6, E4) строится из выданной ссылки: токен сервер
 * показывает один раз, и второй раз его взять негде. Поэтому разбор адреса —
 * самая хрупкая часть: проверим варианты ссылки и отказ на чужой адрес.
 */

const TOKEN = 'SN63kb3sFT3-C8rgqGgg8iUz363xKAT7vlCvmJpPYC8';

test('embed-код: ours /s/ превращается в /embed/ и сохраняет ширину', () => {
  const code = embedCode(`https://audio.example.com/s/${TOKEN}`);
  assert.ok(code);
  assert.match(code, /^<iframe src="https:\/\/audio\.example\.com\/embed\/SN63/);
  assert.match(code, /width="480"/);
  assert.match(code, /height="180"/);
  assert.match(code, /loading="lazy"/);
});

test('embed-код: плейлист выше трека', () => {
  const code = embedCode(`http://192.168.1.10:4000/s/${TOKEN}`, 'playlist');
  assert.match(code ?? '', /height="320"/);
});

test('embed-код: уже embed-адрес и хвостовой слэш не ломают разбор', () => {
  const direct = embedCode(`https://audio.example.com/embed/${TOKEN}/`);
  assert.match(direct ?? '', new RegExp(`/embed/${TOKEN}"`));
  assert.equal(direct?.match(/\/embed\//g)?.length, 1);
});

test('embed-код: чужой адрес и пустое значение → null, а не «что попало»', () => {
  assert.equal(embedCode(''), null);
  assert.equal(embedCode('https://soundcloud.com/artist/track'), null);
  assert.equal(embedCode('https://audio.example.com/s/короткий'), null);
  assert.equal(embedCode('https://audio.example.com/tracks/abc'), null);
});

test('oEmbed-адрес: абсолютный, с закодированной ссылкой', () => {
  const url = oembedUrl(`https://audio.example.com/s/${TOKEN}`);
  assert.ok(url);
  assert.match(url, /^https:\/\/audio\.example\.com\/api\/oembed\?url=https%3A%2F%2F/);
  assert.ok(url.includes(encodeURIComponent(`https://audio.example.com/s/${TOKEN}`)));
  assert.equal(oembedUrl('https://soundcloud.com/a/b'), null);
});
