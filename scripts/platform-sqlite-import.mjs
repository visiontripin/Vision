#!/usr/bin/env node
/**
 * Импорт legacy SQLite-библиотеки (v1) в v2 PostgreSQL через штатный
 * quarantine-ingest: upload intent → запись байтов → complete → outbox/worker.
 * Ничего не публикует и не одобряет: все треки остаются private/quarantine.
 *
 *   node scripts/platform-sqlite-import.mjs --source <bundleDir> --owner <user-uuid> [--apply] [--report <path>]
 *
 * --source — каталог с vision.db и media/ (распакованный проверенный backup,
 * см. docs/PLATFORM-OPERATIONS.md §3.1). По умолчанию dry-run: только
 * extract+verify+report, без записи в PostgreSQL/S3. --apply выполняет импорт.
 * PLATFORM_DATABASE_URL и PLATFORM_S3_* берутся из окружения (как у API).
 *
 * Диспозиция (docs/PLATFORM-OPERATIONS.md §3.2): импортируются только
 * tracks+media; playlists/listens/shares/library/crash — исключены.
 * Отчёт не содержит названий/путей — только sourceId, sha256 и disposition.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';
import { createPlatformPool } from '../services/api/src/platform/postgres.js';
import { createPlatformStorage } from '../services/api/src/platform/storage.js';
import { createUploadIntent, completeUploadIntent } from '../services/api/src/platform/upload.js';

const AUDIO_TYPES = new Set([
  'audio/aac', 'audio/flac', 'audio/mp4', 'audio/mpeg', 'audio/ogg',
  'audio/opus', 'audio/wav', 'audio/webm', 'audio/x-wav',
]);
const EXCLUDED_TABLES = [
  'playlists', 'playlist_tracks', 'smart_playlists', 'listens', 'listen_events',
  'external_tracks', 'shares', 'share_hits', 'share_comments', 'library_devices',
  'library_tracks', 'library_files', 'crash_reports', 'audit_log',
];
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function locateMedia(mediaDir, row) {
  const candidates = [];
  if (row.checksum && SHA256.test(row.checksum)) candidates.push(`${row.checksum}.${row.ext}`);
  candidates.push(`${row.id}.${row.ext}`);
  for (const name of candidates) {
    const filePath = path.join(mediaDir, name);
    try {
      const info = await stat(filePath);
      if (info.isFile()) return filePath;
    } catch { /* следующий кандидат */ }
  }
  return null;
}

async function readSourceTracks(sourceDir) {
  const { DatabaseSync } = await import('node:sqlite');
  const databasePath = path.join(sourceDir, 'vision.db');
  const databaseSha256 = await sha256File(databasePath);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrityRows = database.prepare('PRAGMA integrity_check').all();
    const integrityCheck = { ok: integrityRows.length === 1 && integrityRows[0].integrity_check === 'ok', resultCount: integrityRows.length };
    const tableNames = new Set(database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all().map((row) => row.name));
    if (!tableNames.has('tracks')) throw new Error('SQLite source has no tracks table.');
    const migrationIds = tableNames.has('schema_version')
      ? database.prepare('SELECT id FROM schema_version ORDER BY id').all()
        .map((row) => row.id).filter((id) => typeof id === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(id))
      : [];
    const excludedTableCounts = {};
    for (const table of EXCLUDED_TABLES) {
      excludedTableCounts[table] = tableNames.has(table)
        ? Number(database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count)
        : null;
    }
    const duplicateChecksumGroups = Number(database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT checksum FROM tracks WHERE checksum IS NOT NULL GROUP BY checksum HAVING COUNT(*) > 1
      )
    `).get().count);
    const rows = database.prepare(`
      SELECT id, title, artist, album, genre, mime, ext, size, checksum
      FROM tracks ORDER BY created_at, id
    `).all();
    return { rows, sourceMeta: { databaseSha256, integrityCheck, migrationIds, excludedTableCounts, duplicateChecksumGroups } };
  } finally {
    database.close();
  }
}

/**
 * @param {{sourceDir: string, ownerId: string, pool: import('pg').Pool,
 *   storage: import('../services/api/src/platform/storage.js').PlatformStorage,
 *   apply?: boolean}} options
 */
export async function runSqliteImport({ sourceDir, ownerId, pool, storage, apply = false }) {
  if (!UUID.test(ownerId)) throw new Error('--owner must be a user UUID.');
  const owner = await pool.query('SELECT id, primary_role FROM users WHERE id = $1', [ownerId]);
  const ownerRow = owner.rows[0];
  if (!ownerRow) throw new Error(`Owner user ${ownerId} not found in platform database.`);
  if (!['artist', 'admin'].includes(ownerRow.primary_role)) {
    throw new Error(`Owner user must have role artist or admin (found ${ownerRow.primary_role}).`);
  }
  const actor = { id: ownerId, role: ownerRow.primary_role };
  const mediaDir = path.join(sourceDir, 'media');
  const { rows, sourceMeta } = await readSourceTracks(sourceDir);
  if (!sourceMeta.integrityCheck.ok) {
    throw new Error('SQLite source failed integrity_check; refusing to import an unverified database.');
  }
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    source: path.basename(sourceDir),
    owner: ownerId,
    sourceDatabase: sourceMeta,
    counts: { total: rows.length, imported: 0, would_import: 0, already_imported: 0, skipped: 0, failed: 0 },
    tracks: [],
  };

  for (const row of rows) {
    const entry = { sourceId: row.id, sha256: row.checksum || null };
    report.tracks.push(entry);
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const artist = typeof row.artist === 'string' ? row.artist.trim() : '';
    const contentType = typeof row.mime === 'string' ? row.mime.toLowerCase() : '';
    if (!title || title.length > 300 || !artist || artist.length > 300) {
      entry.disposition = 'invalid_metadata'; report.counts.skipped += 1; continue;
    }
    if (!AUDIO_TYPES.has(contentType)) {
      entry.disposition = 'unsupported_type'; report.counts.skipped += 1; continue;
    }
    if (!Number.isSafeInteger(row.size) || row.size < 1 || row.size > MAX_UPLOAD_BYTES) {
      entry.disposition = 'invalid_size'; report.counts.skipped += 1; continue;
    }
    const filePath = await locateMedia(mediaDir, row);
    if (!filePath) {
      entry.disposition = 'missing_media'; report.counts.skipped += 1; continue;
    }
    const info = await stat(filePath);
    if (info.size !== row.size) {
      entry.disposition = 'size_mismatch'; report.counts.skipped += 1; continue;
    }
    const sha256 = await sha256File(filePath);
    entry.sha256 = sha256;
    if (row.checksum && row.checksum !== sha256) {
      entry.disposition = 'checksum_mismatch'; report.counts.skipped += 1; continue;
    }
    const existing = await pool.query(
      'SELECT id FROM tracks WHERE owner_id = $1 AND sha256 = $2 LIMIT 1', [ownerId, sha256]);
    if (existing.rows[0]) {
      entry.disposition = 'already_imported';
      entry.trackId = existing.rows[0].id;
      report.counts.already_imported += 1;
      continue;
    }
    if (!apply) {
      entry.disposition = 'would_import';
      report.counts.would_import += 1;
      continue;
    }
    try {
      const intent = await createUploadIntent(pool, actor,
        { title, artistDisplay: artist, contentType, sizeBytes: row.size }, { storage });
      const key = storage.makeQuarantineKey({ ownerId, trackId: intent.trackId, intentId: intent.uploadId });
      await storage.putPrivateObject({
        key, body: createReadStream(filePath), contentType, contentLength: row.size,
      });
      const completed = await completeUploadIntent(pool, intent.uploadId, actor, { storage });
      const album = typeof row.album === 'string' && row.album.trim() ? row.album.trim().slice(0, 300) : null;
      const genre = typeof row.genre === 'string' && row.genre.trim() ? row.genre.trim().slice(0, 300) : null;
      if (album || genre) {
        await pool.query('UPDATE tracks SET album = $1, genre = $2 WHERE id = $3',
          [album, genre, completed.trackId]);
      }
      entry.disposition = 'imported';
      entry.trackId = completed.trackId;
      report.counts.imported += 1;
    } catch (error) {
      entry.disposition = 'failed';
      entry.error = error?.code || error?.message || 'unknown';
      report.counts.failed += 1;
    }
  }
  return report;
}

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source') args.sourceDir = argv[++i];
    else if (argv[i] === '--owner') args.ownerId = argv[++i];
    else if (argv[i] === '--report') args.reportPath = argv[++i];
    else if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.ownerId && !UUID.test(args.ownerId)) {
    console.error('--owner must be a user UUID.');
    process.exitCode = 2;
    return;
  }
  if (args.sourceDir && !statSync(path.join(path.resolve(args.sourceDir), 'vision.db'), { throwIfNoEntry: false })?.isFile()) {
    console.error(`vision.db not found in ${args.sourceDir} (expected <source>/vision.db).`);
    process.exitCode = 2;
    return;
  }
  if (args.help || !args.sourceDir || !args.ownerId) {
    console.log('Usage: node scripts/platform-sqlite-import.mjs --source <bundleDir> --owner <user-uuid> [--apply] [--report <path>]');
    console.log('Dry-run by default. --apply imports via quarantine ingest (private only).');
    if (!args.help) process.exitCode = 2;
    return;
  }
  const pool = createPlatformPool();
  const storage = createPlatformStorage();
  try {
    const report = await runSqliteImport({
      sourceDir: path.resolve(args.sourceDir), ownerId: args.ownerId, pool, storage, apply: args.apply,
    });
    const text = JSON.stringify(report, null, 2);
    if (args.reportPath) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.resolve(args.reportPath), `${text}\n`);
      console.log(`Report written to ${args.reportPath}`);
    } else {
      console.log(text);
    }
    console.log(`Counts: ${JSON.stringify(report.counts)}`);
    if (report.counts.failed > 0) process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
    await storage.close?.().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.message || 'SQLite import failed.');
    process.exitCode = 1;
  });
}
