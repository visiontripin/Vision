import test from 'node:test';
import assert from 'node:assert/strict';
import { adminUrl, ago, diagnose, diskState, expiry, humanBytes, isReady } from './lib.ts';
import { baseHint, normalizeBase } from './api.ts';

/**
 * Панель запускается на трёх платформах и вводит адрес руками — значит, именно
 * разбор ввода и диагностика ломаются чаще всего. Проверяем их без DOM.
 */

test('адрес сервера: человек вводит как удобно', () => {
  assert.equal(normalizeBase('192.168.1.10:4000'), 'http://192.168.1.10:4000');
  assert.equal(normalizeBase('  http://192.168.1.10:4000/  '), 'http://192.168.1.10:4000');
  assert.equal(normalizeBase('https://audio.example.com/'), 'https://audio.example.com');
  assert.equal(normalizeBase('http://host:4000/api'), 'http://host:4000');
  assert.equal(normalizeBase('http://host:4000/api/v1/'), 'http://host:4000');
  assert.equal(normalizeBase('host.local'), 'http://host.local');
  assert.equal(normalizeBase(''), '');
  assert.equal(normalizeBase('   '), '');
});

test('адрес сервера: подсказка показывает итоговый вид', () => {
  assert.equal(baseHint('192.168.1.10:4000'), 'http://192.168.1.10:4000');
  assert.equal(baseHint(''), null);
});

test('размеры и время читаются по-человечески', () => {
  assert.equal(humanBytes(0), '0 Б');
  assert.equal(humanBytes(512), '512 Б');
  assert.equal(humanBytes(1024), '1 КБ');
  assert.equal(humanBytes(1536), '1,5 КБ');
  assert.equal(humanBytes(1024 * 1024 * 900), '900 МБ');
  assert.equal(humanBytes(1024 ** 3 * 1.4), '1,4 ГБ');
  assert.equal(humanBytes(Number.NaN), '0 Б');
});

test('диск: предупреждаем заранее', () => {
  assert.equal(diskState(50_000).level, 'ok');
  assert.equal(diskState(2000).level, 'low');
  assert.equal(diskState(100).level, 'critical');
  assert.equal(diskState(null).level, 'unknown');
});

test('время ссылок и открытий', () => {
  const now = Date.parse('2026-11-10T12:00:00.000Z');
  assert.equal(ago(null, now), 'ещё не открывали');
  assert.equal(ago('2026-11-10T11:59:50.000Z', now), 'только что');
  assert.equal(ago('2026-11-10T11:30:00.000Z', now), '30 мин назад');
  assert.equal(ago('2026-11-10T09:00:00.000Z', now), '3 ч назад');
  assert.equal(ago('2026-11-08T12:00:00.000Z', now), '2 дн назад');

  assert.equal(expiry(null, now), 'бессрочная');
  assert.equal(expiry('2026-11-10T11:00:00.000Z', now), 'истекла');
  assert.equal(expiry('2026-11-10T18:00:00.000Z', now), 'ещё 6 ч');
  assert.equal(expiry('2026-11-20T12:00:00.000Z', now), 'ещё 10 дн');
});

test('диагностика: всё в порядке — зелёный список', () => {
  const checks = diagnose({
    ok: true,
    version: '0.14.0',
    diskFreeMb: 40_000,
    migrations: { applied: ['001-base', '002-fulltext-search'], pending: 0 },
    ffmpeg: { available: true, version: '6.1', path: '/usr/bin/ffmpeg' },
    storage: { mode: 'local', seedEnabled: true, deviceId: 'origin', publicUrl: 'https://audio.example.com' },
    tracker: { blobs: 10, seeds: 12, noSource: 0 },
  });
  assert.ok(checks.every((check) => check.level === 'ok'));
  assert.ok(isReady(checks));
});

test('диагностика: типичные поломки объяснены по-русски', () => {
  const offline = diagnose(null);
  assert.equal(offline[0].level, 'fail');
  assert.ok(!isReady(offline));

  const checks = diagnose({
    ok: true,
    version: '0.14.0',
    diskFreeMb: 120,
    migrations: { applied: ['001-base'], pending: 2 },
    ffmpeg: { available: false, version: null, path: null },
    storage: { mode: 'local', seedEnabled: true, deviceId: 'origin', publicUrl: null },
    tracker: { blobs: 5, seeds: 1, noSource: 3 },
  });

  assert.equal(checks.find((check) => check.title === 'Диск')?.level, 'fail');
  assert.equal(checks.find((check) => check.title === 'Миграции не применены')?.level, 'warn');
  assert.equal(checks.find((check) => check.title === 'ffmpeg не найден')?.level, 'warn');
  assert.equal(checks.find((check) => check.title === 'Есть файлы без источника')?.level, 'warn');
  assert.equal(checks.find((check) => check.title === 'PUBLIC_URL не задан')?.level, 'warn');
  assert.ok(!isReady(checks), 'красный диск блокирует «готово к работе»');
});

test('адрес панели для телефона', () => {
  assert.equal(adminUrl('http://192.168.1.10:4000'), 'http://192.168.1.10:4000/admin');
  assert.equal(adminUrl(''), '/admin');
});
