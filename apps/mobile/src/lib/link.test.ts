import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOOK_SCRIPT, looksLikeAudio, titleFromUrl } from './link';

test('прямые аудио-адреса отличаются от страниц', () => {
  assert.equal(looksLikeAudio('https://cdn.example.com/a/song.mp3'), true);
  assert.equal(looksLikeAudio('https://cdn.example.com/song.m4a?sig=abc'), true);
  assert.equal(looksLikeAudio('https://example.com/song.mp3?x=1'), true);
  assert.equal(looksLikeAudio('https://example.com/track/12345'), false);
  // картинки и скрипты — не звук, даже если в query есть «.mp3»
  assert.equal(looksLikeAudio('https://example.com/cover.jpg'), false);
  assert.equal(looksLikeAudio('https://example.com/app.js?v=song.mp3'), false);
});

test('название из ссылки: без расширения, мусора и подчёркиваний', () => {
  assert.equal(titleFromUrl('https://cdn.example.com/music/Кино%20-%20Группа%20крови.mp3'), 'Кино - Группа крови');
  assert.equal(titleFromUrl('https://example.com/a/my_track-01.m4a'), 'my track-01');
  // «+» в адресе — это пробел, иначе в названии останется «a+b»
  assert.equal(titleFromUrl('https://example.com/a/Artist+Title.mp3'), 'Artist Title');
  // нет пути — берём хост, а не пустую строку
  assert.equal(titleFromUrl('https://example.com'), 'example.com');
  assert.equal(titleFromUrl(''), 'Трек по ссылке');
  // битый адрес не должен ронять добавление
  assert.equal(titleFromUrl('не ссылка'), 'не ссылка');
});

test('перехватчик внутри страницы не ломает её и не шлёт картинки', () => {
  assert.match(HOOK_SCRIPT, /window\.__visionHooked = true/);
  // повторная инъекция не должна заворачивать fetch второй раз
  assert.match(HOOK_SCRIPT, /if \(window\.__visionHooked\) return;/);
  assert.match(HOOK_SCRIPT, /ReactNativeWebView\.postMessage/);
  // фильтр по картинкам/скриптам — иначе список забьётся служебными запросами
  assert.match(HOOK_SCRIPT, /png\|jpe\?g\|gif/);
  // страница обязана продолжить работать: обёртки вызывают оригинал
  assert.match(HOOK_SCRIPT, /return open\.apply\(this, arguments\)/);
  assert.match(HOOK_SCRIPT, /return original\.apply\(this, arguments\)/);
});
