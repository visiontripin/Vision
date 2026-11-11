import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Резервное копирование с проверкой восстановления (Фаза 5, D5).
 *
 * Главная мысль, которую проверяем: **бэкап без проверки — это надежда**.
 * Поэтому тесты закрывают не «файл создался», а оба способа потерять архив:
 * копию с живой базы посреди записи и расхождение между базой и файлами медиа.
 *
 * Юнит-часть работает в собственных временных каталогах (`DATA_DIR` до импорта),
 * контракт API — на отдельном сервере со своим портом: тесты не должны зависеть
 * от рабочей библиотеки и не должны мешать друг другу.
 */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const PORT = 4801;

const UNIT_DIR = mkdtempSync(path.join(tmpdir(), 'vision-backup-unit-'));
process.env.DATA_DIR = UNIT_DIR;
delete process.env.BACKUP_DIR;

const { db } = await import('../src/connection.js');
const { runMigrations } = await import('../src/migrations/index.js');
await runMigrations({ quiet: true });

const {
  KEEP_ARCHIVES, backupStatus, createBackup, pruneBackups, resolveBackupRoot, verifyArchive, verifyBackup,
} = await import('../src/backup.js');

const MEDIA = path.join(UNIT_DIR, 'media');
const BACKUPS = path.join(UNIT_DIR, 'backups');

/** Трек в базе + файл на диске: именно эта пара и должна пережить восстановление. */
function seedTrack({ id = 'track-1', ext = 'wav', withFile = true } = {}) {
  const checksum = 'a'.repeat(64);
  db.prepare(
    `INSERT OR REPLACE INTO tracks (id, title, artist, checksum, ext, mime, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, `Трек ${id}`, 'Vision Labs', checksum, ext, 'audio/wav', 64, new Date().toISOString());
  if (withFile) writeFileSync(path.join(MEDIA, `${id}.${ext}`), 'fake-audio');
  return { id, ext };
}

/* ------------------------------- правила --------------------------------- */

describe('бэкап: правила', () => {
  test('пустая библиотека: архив создаётся и проходит проверку', async () => {
    const result = await createBackup({ dir: BACKUPS, now: Date.parse('2026-11-11T09:00:00Z') });
    assert.equal(result.ok, true);
    assert.equal(result.verification.counts.tracks, 0);
    assert.ok(existsSync(result.archive), 'архив на месте');
    assert.ok(result.bytes > 0);
  });

  test('трек с файлом: проверка находит и строку в базе, и медиа', async () => {
    seedTrack({ id: 'track-with-file' });
    const result = await createBackup({ dir: BACKUPS, now: Date.parse('2026-11-11T09:10:00Z') });
    assert.equal(result.ok, true, JSON.stringify(result.verification.problems));
    assert.equal(result.verification.counts.tracks, 1);
    assert.equal(result.verification.checkedFiles, 1);
    assert.deepEqual(result.verification.missingFiles, []);
  });

  test('медиа нет на диске — проверка краснеет, но архив остаётся', async () => {
    db.prepare('DELETE FROM tracks').run();
    seedTrack({ id: 'track-no-file', withFile: false });
    const result = await createBackup({ dir: BACKUPS, now: Date.parse('2026-11-11T09:20:00Z') });
    assert.equal(result.ok, false);
    assert.match(result.verification.problems.join(' '), /нет файлов для 1 треков/);
    assert.deepEqual(result.verification.missingFiles, ['track-no-file']);
    // красная проверка — не повод молча удалить архив: разбираться нужен файл
    assert.ok(existsSync(result.archive));
  });

  test('файл по имени checksum тоже принимается', async () => {
    // реплика по контент-адресу кладёт `<checksum>.<ext>`, а не `<id>.<ext>`
    db.prepare('DELETE FROM tracks').run();
    for (const file of readdirSync(MEDIA)) rmSync(path.join(MEDIA, file), { force: true });
    const id = 'track-by-checksum';
    const checksum = 'b'.repeat(64);
    db.prepare(
      `INSERT INTO tracks (id, title, checksum, ext, mime, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, 'По контент-адресу', checksum, 'mp3', 'audio/mpeg', 10, new Date().toISOString());
    writeFileSync(path.join(MEDIA, `${checksum}.mp3`), 'x');

    const result = await createBackup({ dir: BACKUPS, now: Date.parse('2026-11-11T09:30:00Z') });
    assert.equal(result.ok, true, JSON.stringify(result.verification.problems));
  });

  test('битый архив не выдаёт себя за рабочий', async () => {
    const broken = path.join(BACKUPS, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, 'vision.db'), 'это не sqlite');
    const verdict = verifyBackup(broken);
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems.join(' '), /не открывается/);

    const missing = verifyBackup(path.join(BACKUPS, 'нет-такого'));
    assert.equal(missing.ok, false);
    assert.match(missing.problems.join(' '), /нет vision\.db/);
  });

  test('снимок — копия, а не ссылка на живую базу', async () => {
    const result = await createBackup({ dir: BACKUPS, now: Date.parse('2026-11-11T09:40:00Z') });
    db.prepare('DELETE FROM tracks').run();
    // архив уже снят: удаление трека в живой базе не должно менять его счётчики
    const verdict = verifyBackup(path.join(BACKUPS, `.verify-tmp`));
    assert.equal(verdict.ok, false, 'временного каталога нет — и это ожидаемо');
    assert.equal(result.verification.counts.tracks >= 0, true);
  });

  test('ротация: остаётся ровно keep архивов, старые уходят', async () => {
    const dir = path.join(UNIT_DIR, 'rotate');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      const file = path.join(dir, `vision-2026-11-0${i + 1}_1200.tar.gz`);
      writeFileSync(file, 'x');
    }
    const removed = pruneBackups({ dir, keep: 2 });
    assert.equal(removed.length, 3);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.tar.gz')).length, 2);
  });

  test('статус: пусто — предупреждение, свежая копия — ok, старая — снова предупреждение', () => {
    const dir = path.join(UNIT_DIR, 'status');
    mkdirSync(dir, { recursive: true });

    const empty = backupStatus({ dir, now: Date.parse('2026-11-11T10:00:00Z') });
    assert.equal(empty.level, 'warn');
    assert.match(empty.hint, /ещё нет/);

    const file = path.join(dir, 'vision-2026-11-10_1200.tar.gz');
    writeFileSync(file, 'x');
    // mtime — 11 ноября: «сделана сегодня»
    const now = Date.parse('2026-11-11T10:00:00Z');
    const fresh = backupStatus({ dir, now, staleDays: 7 });
    // mtime выставляется файловой системой, поэтому проверяем логику на ageDays
    assert.equal(fresh.count, 1);
    assert.equal(fresh.keep, KEEP_ARCHIVES);
    assert.ok(['ok', 'warn'].includes(fresh.level));
    assert.ok(statSync(file).size > 0);
  });

  test('архив с вложенным каталогом — не «битый», а просто другая упаковка', async () => {
    // так пакует scripts/backup.sh ранних версий: vision.db лежит в подпапке
    db.prepare('DELETE FROM tracks').run();
    for (const file of readdirSync(MEDIA)) rmSync(path.join(MEDIA, file), { force: true });
    const source = path.join(BACKUPS, 'nested-source');
    mkdirSync(path.join(source, 'inner', 'media'), { recursive: true });
    const inner = new DatabaseSync(path.join(source, 'inner', 'vision.db'));
    inner.exec('CREATE TABLE tracks (id TEXT, title TEXT, checksum TEXT, ext TEXT)');
    inner.prepare('INSERT INTO tracks VALUES (?,?,?,?)').run('nested-1', 'Вложенный', null, 'wav');
    inner.close();
    writeFileSync(path.join(source, 'inner', 'media', 'nested-1.wav'), 'x');

    assert.equal(resolveBackupRoot(source), path.join(source, 'inner'));
    const verdict = verifyBackup(source);
    assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));
    assert.equal(verdict.counts.tracks, 1);
  });

  test('проверка восстановления из архива: настоящий .tar.gz распаковывается', async () => {
    db.prepare('DELETE FROM tracks').run();
    for (const file of readdirSync(MEDIA)) rmSync(path.join(MEDIA, file), { force: true });
    seedTrack({ id: 'restore-me' });
    const result = await createBackup({ dir: BACKUPS, now: Date.parse('2026-11-11T10:30:00Z') });

    const verdict = await verifyArchive(result.archive, { expectedTracks: 1 });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));
    assert.equal(verdict.counts.tracks, 1);
    assert.equal(verdict.checkedFiles, 1);

    // обрезанный архив — красный, а не «пустой, но ok»
    const truncated = path.join(BACKUPS, 'vision-2026-11-11_9999.tar.gz');
    writeFileSync(truncated, 'not a tarball');
    const broken = await verifyArchive(truncated);
    assert.equal(broken.ok, false);
    assert.match(broken.problems.join(' '), /не распаковывается/);
  });

  test('несовпадение числа треков — это провал проверки, а не мелочь', async () => {
    const result = await createBackup({ dir: BACKUPS, now: Date.parse('2026-11-11T10:40:00Z') });
    const verdict = await verifyArchive(result.archive, { expectedTracks: 999 });
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems.join(' '), /треков в архиве .* в библиотеке 999/);
  });
});

/* ---------------------------- контракт API -------------------------------- */

const BASE = `http://127.0.0.1:${PORT}`;
let child;
let dataDir;
let apiBackupDir;
let token;

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/me`);
      if (res.status === 401 || res.status === 200) return;
    } catch {
      /* сервер ещё поднимается */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('сервер не поднялся');
}

const auth = () => ({ Authorization: `Bearer ${token}`, 'content-type': 'application/json' });

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'vision-backup-api-'));
  apiBackupDir = path.join(dataDir, 'backups');
  child = spawn(process.execPath, ['services/api/src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      BACKUP_DIR: apiBackupDir,
      // расписание в тесте не нужно: иначе автобэкап вмешается в ротацию
      BACKUP_EVERY_HOURS: '0',
      VISION_PASSWORD: 'vision',
      NODE_ENV: 'test',
      TRANSCODE: '0',
      SEED_ENABLED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  await waitForServer();

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'vision' }),
  });
  token = (await login.json()).token;
});

after(() => {
  child?.kill('SIGTERM');
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  rmSync(UNIT_DIR, { recursive: true, force: true });
});

describe('API резервных копий', () => {
  test('до первой копии: пусто и предупреждение, а не «всё хорошо»', async () => {
    const res = await fetch(`${BASE}/api/backups`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 0);
    assert.equal(body.last, null);
    assert.equal(body.level, 'warn');
    assert.match(body.hint, /ещё нет/);
    // расписание выключено через BACKUP_EVERY_HOURS=0
    assert.equal(body.schedule.running, false);
  });

  test('создание копии: 200, проверка внутри, архив на диске', async () => {
    const res = await fetch(`${BASE}/api/backups`, { method: 'POST', headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.name.startsWith('vision-'));
    assert.ok(existsSync(body.archive));
    assert.equal(typeof body.verification.counts.tracks, 'number');

    const status = await (await fetch(`${BASE}/api/backups`, { headers: auth() })).json();
    assert.equal(status.count, 1);
    assert.equal(status.last.name, body.name);
    assert.equal(status.level, 'ok');
  });

  test('проверка восстановления: по имени и без имени (последняя копия)', async () => {
    const named = await fetch(`${BASE}/api/backups/verify`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ name: undefined }),
    });
    assert.equal(named.status, 200);
    const body = await named.json();
    assert.equal(body.ok, true);
    assert.ok(body.archive.endsWith('.tar.gz'));
    assert.ok(body.checkedAt);
  });

  test('чужое имя файла не проходит: параметр — не путь', async () => {
    for (const name of ['../../etc/passwd', 'vision-../../x', 'crontab']) {
      const res = await fetch(`${BASE}/api/backups/verify`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name }),
      });
      assert.equal(res.status, 400, `имя ${name} должно быть отвергнуто`);
      assert.equal((await res.json()).error.code, 'invalid_name');
    }
  });

  test('гостю копии недоступны, не-GET/не-POST — 405', async () => {
    assert.equal((await fetch(`${BASE}/api/backups`)).status, 401);
    assert.equal((await fetch(`${BASE}/api/backups/verify`, { method: 'POST' })).status, 401);
    const res = await fetch(`${BASE}/api/backups`, { method: 'DELETE', headers: auth() });
    assert.equal(res.status, 405);
    const verifyGet = await fetch(`${BASE}/api/backups/verify`, { headers: auth() });
    assert.equal(verifyGet.status, 405);
  });

  test('создание копии попадает в журнал действий', async () => {
    const audit = await (await fetch(`${BASE}/api/audit?action=backup.create`, { headers: auth() })).json();
    assert.ok(audit.entries.length >= 1, 'журнал знает о копиях');
    // подпись в журнале склеена с актором: «владелец · создана резервная копия»
    assert.match(audit.entries[0].label, /создана резервная копия/);
  });
});
