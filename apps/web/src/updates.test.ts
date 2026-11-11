import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions, isSnoozed, parseManifest, parseVersion, platformKey, snoozeUpdate, updateLabel,
} from './updates.ts';

/**
 * Автообновление десктопа (I4).
 *
 * Ошибка здесь стоит дороже обычной: «предлагаем обновиться на ту же версию»
 * раздражает, «молчим про новую» оставляет людей на дырявой сборке, а
 * «предлагаем артефакт без подписи» ломает установку. Проверяем ровно это.
 */

const CURRENT = '0.2.0';

const manifest = (over: Record<string, unknown> = {}) => ({
  version: '0.3.0',
  pub_date: '2026-11-11T08:00:00Z',
  notes: 'Первая строка изменений',
  platforms: {
    'linux-x86_64': { signature: 'sig-linux', url: 'https://example.com/app.AppImage.tar.gz' },
    'windows-x86_64': { signature: 'sig-win', url: 'https://example.com/app.nsis.zip' },
    'darwin-aarch64': { signature: 'sig-mac', url: 'https://example.com/app.app.tar.gz' },
  },
  ...over,
});

test('версии: разбор и сравнение', () => {
  assert.deepEqual(parseVersion('0.3.0'), [0, 3, 0]);
  assert.deepEqual(parseVersion(' 1.10.2-beta '), [1, 10, 2]);
  assert.equal(parseVersion('ноябрь'), null);
  assert.equal(parseVersion(''), null);

  assert.equal(compareVersions('0.3.0', '0.2.0'), 1);
  assert.equal(compareVersions('0.2.1', '0.2.0'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  // 10 больше 9: строковое сравнение «0.10» < «0.9» здесь ошибочно
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.3.0'), -1);
  assert.equal(compareVersions('мусор', '0.2.0'), null);
});

test('ключ платформы: имена Tauri, а не Node', () => {
  assert.equal(platformKey('linux', 'x64'), 'linux-x86_64');
  assert.equal(platformKey('win32', 'x64'), 'windows-x86_64');
  assert.equal(platformKey('darwin', 'arm64'), 'darwin-aarch64');
  assert.equal(platformKey('linux', 'arm64'), 'linux-aarch64');
  assert.equal(platformKey('win32', 'ia32'), 'windows-i686');
  assert.equal(platformKey('freebsd', 'x64'), null);
  assert.equal(platformKey('linux', 'mips'), null);
});

test('манифест даёт кандидата, когда версия новее и есть артефакт', () => {
  const candidate = parseManifest(manifest(), {
    currentVersion: CURRENT,
    platform: 'linux-x86_64',
  });
  assert.ok(candidate);
  assert.equal(candidate.version, '0.3.0');
  assert.equal(candidate.url, 'https://example.com/app.AppImage.tar.gz');
  assert.equal(candidate.signature, 'sig-linux');
  assert.equal(candidate.notes, 'Первая строка изменений');
  assert.equal(candidate.publishedAt, '2026-11-11T08:00:00Z');
});

test('та же версия, старая версия и битый манифест — не предлагаем', () => {
  const platform = 'linux-x86_64';
  assert.equal(parseManifest(manifest({ version: CURRENT }), { currentVersion: CURRENT, platform }), null);
  assert.equal(parseManifest(manifest({ version: '0.1.9' }), { currentVersion: CURRENT, platform }), null);
  assert.equal(parseManifest(manifest({ version: 'не версия' }), { currentVersion: CURRENT, platform }), null);
  assert.equal(parseManifest(null, { currentVersion: CURRENT, platform }), null);
  assert.equal(parseManifest('строка', { currentVersion: CURRENT, platform }), null);
  assert.equal(parseManifest(manifest(), { currentVersion: CURRENT, platform: null }), null);
});

test('нет артефакта для платформы или он без подписи → null', () => {
  const linux = { currentVersion: CURRENT, platform: 'linux-x86_64' };
  // платформы нет в манифесте — для этой системы обновления нет
  assert.equal(parseManifest(manifest({ platforms: {} }), linux), null);
  // подпись обязательна: Tauri без неё отклонит загрузку, предлагать бессмысленно
  assert.equal(
    parseManifest(manifest({ platforms: { 'linux-x86_64': { signature: '', url: 'https://x/a.tar.gz' } } }), linux),
    null
  );
  assert.equal(
    parseManifest(manifest({ platforms: { 'linux-x86_64': { signature: 's', url: 'ftp://x/a' } } }), linux),
    null
  );
  // нет notes — не беда, обновление всё равно предлагаем
  const noNotes = parseManifest(manifest({ notes: '  ' }), linux);
  assert.equal(noNotes?.notes, null);
});

test('«отложить» действует сутки и сбрасывается новой версией', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };

  assert.equal(isSnoozed('0.3.0', Date.now(), storage), false);
  snoozeUpdate('0.3.0', storage);
  assert.equal(isSnoozed('0.3.0', Date.now(), storage), true);
  // вышла 0.4.0 — прошлый отказ на неё не распространяется
  assert.equal(isSnoozed('0.4.0', Date.now(), storage), false);
  // через сутки напоминание возвращается
  assert.equal(isSnoozed('0.3.0', Date.now() + 25 * 3600_000, storage), false);

  // хранилище недоступно (приватный режим) — молча живём без «отложить»
  assert.equal(isSnoozed('0.3.0', Date.now(), null), false);
  assert.doesNotThrow(() => snoozeUpdate('0.3.0', null));
  const broken = { getItem: () => '{битый json', setItem: () => undefined };
  assert.equal(isSnoozed('0.3.0', Date.now(), broken), false);
});

test('подпись плашки: версия и текущая версия', () => {
  const candidate = parseManifest(manifest(), { currentVersion: CURRENT, platform: 'linux-x86_64' });
  assert.ok(candidate);
  assert.equal(updateLabel(candidate, CURRENT), 'Доступна версия 0.3.0 с 0.2.0');
});
