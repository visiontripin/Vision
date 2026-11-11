import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Проверка восстановления — глазами владельца архива (D5).
 *
 * Скрипт `scripts/verify-backup.mjs` запускают, когда что-то уже потеряли, и
 * молчаливого «наверное, ок» он позволить себе не может. Поэтому проверяем три
 * исхода на настоящих файлах: целый архив (0), архив без медиа (1), мусор вместо
 * tar.gz (1). Отдельно — вложенный каталог: так пакуют некоторые сборки, и это не
 * повод объявлять архив битым.
 */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SCRIPT = path.join(ROOT, 'scripts/verify-backup.mjs');

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Минимальная «резервная копия»: база с одним треком и его файл. */
function makeBundle({ withFile = true, manifest = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vision-verify-test-'));
  mkdirSync(path.join(dir, 'media'), { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'vision.db'));
  db.exec(`
    CREATE TABLE tracks (id TEXT, title TEXT, checksum TEXT, ext TEXT);
    CREATE TABLE playlists (id TEXT);
  `);
  db.prepare('INSERT INTO tracks VALUES (?,?,?,?)').run('track-1', 'Slow Tide', null, 'wav');
  db.close();
  if (withFile) writeFileSync(path.join(dir, 'media', 'track-1.wav'), 'audio');
  if (manifest) {
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-11T10:00:00Z', tracks: 1, ok: withFile }));
  }
  return dir;
}

test('целый архив: код 0 и понятный отчёт', () => {
  const dir = makeBundle();
  const { code, out } = run([dir]);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 0, out);
  assert.match(out, /архив целый: треков 1/);
  assert.match(out, /манифест: от 2026-11-11/);
  assert.match(out, /восстановление: остановите сервер/);
});

test('нет файлов медиа: код 1, но говорит, каких именно треков не хватает', () => {
  const dir = makeBundle({ withFile: false });
  const { code, out } = run([dir]);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.match(out, /восстановление невозможно/);
  assert.match(out, /нет файлов для 1 треков/);
  assert.match(out, /track-1 — Slow Tide/);
});

test('вложенный каталог внутри архива — не ошибка', () => {
  const outer = mkdtempSync(path.join(tmpdir(), 'vision-verify-nested-'));
  const inner = makeBundle();
  const nested = path.join(outer, 'vision-2026-11-11_1200');
  mkdirSync(nested);
  for (const name of ['vision.db', 'media']) {
    spawnSync('cp', ['-R', path.join(inner, name), nested]);
  }
  const { code, out } = run([outer]);
  rmSync(outer, { recursive: true, force: true });
  rmSync(inner, { recursive: true, force: true });
  assert.equal(code, 0, out);
});

test('мусор вместо архива: код 1 и без «наверное, ок»', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'vision-verify-junk-')), 'vision.tar.gz');
  writeFileSync(file, 'это не gzip');
  const { code, out } = run([file]);
  rmSync(path.dirname(file), { recursive: true, force: true });
  assert.equal(code, 1);
  assert.match(out, /не распаковывается/);
});

test('каталог без vision.db: сразу понятно, что это не наш архив', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vision-verify-empty-'));
  const { code, out } = run([dir]);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.match(out, /нет vision\.db/);
});
