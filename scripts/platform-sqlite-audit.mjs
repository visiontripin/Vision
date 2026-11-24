#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const TABLES = [
  'tracks', 'playlists', 'playlist_tracks', 'listens', 'external_tracks', 'track_variants',
  'blobs', 'blob_seeds', 'shares', 'share_hits', 'share_comments', 'audit_log',
  'smart_playlists', 'listen_events', 'crash_reports', 'library_devices', 'library_tracks',
  'library_files', 'schema_version',
];
const AUDIO_EXT = /^[A-Za-z0-9]{1,10}$/;
const FILE_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COVER_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

function entryAt(filePath) {
  try { return lstatSync(filePath); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  return { sizeBytes, sha256: hash.digest('hex') };
}

function getColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name));
}

function columnOrNull(columns, name) {
  return columns.has(name) ? `"${name}"` : `NULL AS "${name}"`;
}

async function inspectMediaRow({ row, mediaDirectory, cache }) {
  const result = {
    hasExtension: typeof row.ext === 'string' && row.ext.length > 0,
    invalidExtension: false,
    invalidReference: false,
    missing: false,
    unsafePath: false,
    checksumPresent: row.checksum !== null && row.checksum !== undefined && row.checksum !== '',
    invalidChecksum: false,
    checksumMismatch: false,
    checksumMatched: false,
    sizeMismatch: false,
    ambiguousCandidates: false,
    candidates: [],
  };

  if (result.checksumPresent && (typeof row.checksum !== 'string' || !SHA256.test(row.checksum))) {
    result.invalidChecksum = true;
  }
  if (!result.hasExtension) return result;
  if (!AUDIO_EXT.test(row.ext)) {
    result.invalidExtension = true;
    result.invalidReference = true;
    return result;
  }

  const candidates = [];
  if (typeof row.id === 'string' && FILE_TOKEN.test(row.id)) candidates.push(`${row.id}.${row.ext}`);
  else result.invalidReference = true;

  if (result.checksumPresent && !result.invalidChecksum) candidates.push(`${row.checksum}.${row.ext}`);
  if (!mediaDirectory) {
    result.missing = true;
    return result;
  }

  const uniqueCandidates = [...new Set(candidates)];
  for (const name of uniqueCandidates) {
    const filePath = path.join(mediaDirectory, name);
    const entry = entryAt(filePath);
    if (!entry) continue;
    if (!entry.isFile()) {
      result.unsafePath = true;
      continue;
    }
    let facts = cache.get(filePath);
    if (!facts) {
      facts = { ...await hashFile(filePath) };
      cache.set(filePath, facts);
    }
    result.candidates.push({ name, ...facts });
  }

  result.ambiguousCandidates = result.candidates.length > 1;
  if (!result.candidates.length) {
    result.missing = true;
    return result;
  }

  const expectedSize = Number.isSafeInteger(row.size) && row.size >= 0 ? row.size : null;
  if (expectedSize !== null && !result.candidates.some((candidate) => candidate.sizeBytes === expectedSize)) {
    result.sizeMismatch = true;
  }

  if (result.checksumPresent && !result.invalidChecksum) {
    result.checksumMatched = result.candidates.some((candidate) => candidate.sha256 === row.checksum);
    result.checksumMismatch = !result.checksumMatched;
  }
  return result;
}

async function inspectCoverRow({ row, coversDirectory }) {
  if (!row.cover_mime) return { present: false, missing: false, unsupportedMime: false, unsafePath: false };
  if (typeof row.id !== 'string' || !FILE_TOKEN.test(row.id)) {
    return { present: false, missing: true, unsupportedMime: false, unsafePath: true };
  }
  const extension = COVER_EXTENSIONS.get(row.cover_mime);
  if (!extension) return { present: false, missing: false, unsupportedMime: true, unsafePath: false };
  if (!coversDirectory) return { present: false, missing: true, unsupportedMime: false, unsafePath: false };
  const filePath = path.join(coversDirectory, `${row.id}.${extension}`);
  const entry = entryAt(filePath);
  if (!entry) return { present: false, missing: true, unsupportedMime: false, unsafePath: false };
  if (!entry.isFile()) return { present: false, missing: false, unsupportedMime: false, unsafePath: true };
  return { present: true, missing: false, unsupportedMime: false, unsafePath: false };
}

/** Read a verified, unpacked legacy backup and emit aggregate reconciliation evidence only. */
export async function auditLegacySqliteBundle(bundlePath) {
  const directory = path.resolve(bundlePath);
  const directoryEntry = entryAt(directory);
  if (!directoryEntry?.isDirectory()) throw new Error('Input must be a real directory containing vision.db.');

  const databasePath = path.join(directory, 'vision.db');
  const databaseEntry = entryAt(databasePath);
  if (!databaseEntry?.isFile()) throw new Error('Input directory must contain a regular vision.db file.');
  if (['-wal', '-shm', '-journal'].some((suffix) => entryAt(`${databasePath}${suffix}`))) {
    throw new Error('Use a standalone verified SQLite snapshot without WAL/journal sidecars.');
  }
  const mediaPath = path.join(directory, 'media');
  const coversPath = path.join(directory, 'covers');
  const mediaEntry = entryAt(mediaPath);
  const coversEntry = entryAt(coversPath);
  if (mediaEntry && !mediaEntry.isDirectory()) throw new Error('The media entry must be a directory, not a link or special file.');
  if (coversEntry && !coversEntry.isDirectory()) throw new Error('The covers entry must be a directory, not a link or special file.');

  const databaseHash = await hashFile(databasePath);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrityRows = database.prepare('PRAGMA integrity_check').all();
    const integrityOk = integrityRows.length === 1 && integrityRows[0].integrity_check === 'ok';
    const tableNames = new Set(database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all().map((row) => row.name));
    if (!tableNames.has('tracks')) throw new Error('SQLite source has no tracks table.');

    const tableCounts = {};
    for (const table of TABLES) {
      tableCounts[table] = tableNames.has(table)
        ? Number(database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count)
        : null;
    }

    const trackColumns = getColumns(database, 'tracks');
    if (!trackColumns.has('id') || !trackColumns.has('ext')) {
      throw new Error('SQLite tracks table does not have the required id/ext columns.');
    }
    const rows = database.prepare(`
      SELECT ${columnOrNull(trackColumns, 'id')},
             ${columnOrNull(trackColumns, 'ext')},
             ${columnOrNull(trackColumns, 'checksum')},
             ${columnOrNull(trackColumns, 'size')},
             ${columnOrNull(trackColumns, 'cover_mime')}
      FROM tracks
    `).all();
    const safeMediaDirectory = mediaEntry?.isDirectory() ? mediaPath : null;
    const safeCoversDirectory = coversEntry?.isDirectory() ? coversPath : null;
    const mediaCache = new Map();
    const trackAudit = {
      total: rows.length,
      withLocalExtension: 0,
      withoutLocalExtension: 0,
      invalidExtensions: 0,
      invalidFileReferences: 0,
      missingFiles: 0,
      unsafePaths: 0,
      withChecksum: 0,
      withoutChecksum: 0,
      invalidChecksums: 0,
      checksumMismatches: 0,
      checksumMatches: 0,
      sizeMismatches: 0,
      ambiguousFileCandidates: 0,
    };
    const coverAudit = {
      declared: 0,
      present: 0,
      missing: 0,
      unsupportedMime: 0,
      unsafePaths: 0,
    };

    for (const row of rows) {
      const media = await inspectMediaRow({ row, mediaDirectory: safeMediaDirectory, cache: mediaCache });
      if (media.hasExtension) trackAudit.withLocalExtension += 1;
      else trackAudit.withoutLocalExtension += 1;
      if (media.invalidExtension) trackAudit.invalidExtensions += 1;
      if (media.invalidReference) trackAudit.invalidFileReferences += 1;
      if (media.missing) trackAudit.missingFiles += 1;
      if (media.unsafePath) trackAudit.unsafePaths += 1;
      if (media.checksumPresent) trackAudit.withChecksum += 1;
      else trackAudit.withoutChecksum += 1;
      if (media.invalidChecksum) trackAudit.invalidChecksums += 1;
      if (media.checksumMismatch) trackAudit.checksumMismatches += 1;
      if (media.checksumMatched) trackAudit.checksumMatches += 1;
      if (media.sizeMismatch) trackAudit.sizeMismatches += 1;
      if (media.ambiguousCandidates) trackAudit.ambiguousFileCandidates += 1;

      if (row.cover_mime) {
        coverAudit.declared += 1;
        const cover = await inspectCoverRow({ row, coversDirectory: safeCoversDirectory });
        if (cover.present) coverAudit.present += 1;
        if (cover.missing) coverAudit.missing += 1;
        if (cover.unsupportedMime) coverAudit.unsupportedMime += 1;
        if (cover.unsafePath) coverAudit.unsafePaths += 1;
      }
    }

    const foreignKeyViolations = {};
    for (const violation of database.prepare('PRAGMA foreign_key_check').all()) {
      const table = TABLES.includes(violation.table) ? violation.table : 'other';
      foreignKeyViolations[table] = (foreignKeyViolations[table] || 0) + 1;
    }

    const migrationIds = tableNames.has('schema_version')
      ? database.prepare('SELECT id FROM schema_version ORDER BY id').all()
        .map((row) => row.id).filter((id) => typeof id === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(id))
      : [];
    const known = new Set([...TABLES, 'tracks_fts']);
    const unknownTableCount = [...tableNames].filter((name) => !known.has(name) && !name.startsWith('tracks_fts_')).length;
    const duplicateChecksumGroups = trackColumns.has('checksum')
      ? Number(database.prepare(`
          SELECT COUNT(*) AS count FROM (
            SELECT checksum FROM tracks WHERE checksum IS NOT NULL GROUP BY checksum HAVING COUNT(*) > 1
          )
        `).get().count)
      : 0;

    const integrityCheck = {
      ok: integrityOk,
      resultCount: integrityRows.length,
    };
    const nonPiiReport = {
      reportVersion: 1,
      reportType: 'vision-legacy-sqlite-inventory',
      createdAt: new Date().toISOString(),
      mode: 'read-only-inventory-only',
      assessment: 'inventory-only-not-a-migration-approval',
      writesPerformed: false,
      source: {
        databaseSizeBytes: databaseHash.sizeBytes,
        databaseSha256: databaseHash.sha256,
        integrityCheck,
        migrationIds,
      },
      tableCounts,
      unknownTableCount,
      foreignKeyViolations,
      tracks: {
        ...trackAudit,
        duplicateChecksumGroups,
        distinctReferencedMediaFiles: mediaCache.size,
        distinctReferencedMediaBytes: [...mediaCache.values()].reduce((sum, item) => sum + item.sizeBytes, 0),
      },
      covers: coverAudit,
      legacyPlaybackRowsAreUnverified: true,
      importOrCutoverPerformed: false,
    };
    return nonPiiReport;
  } finally {
    database.close();
  }
}

function help() {
  console.log('Read-only inventory of an unpacked, verified legacy backup.\n\nUsage:\n  npm run platform:sqlite:audit -- <unpacked-backup-directory>\n\nThe JSON report contains aggregate counts and hashes only; it does not import data, write to the source, or perform cutover.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    help();
  } else if (args.length !== 1 || args[0].startsWith('--')) {
    console.error('Usage: npm run platform:sqlite:audit -- <unpacked-backup-directory>');
    process.exitCode = 2;
  } else {
    auditLegacySqliteBundle(args[0]).then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.source.integrityCheck.ok) process.exitCode = 1;
    }).catch((error) => {
      console.error(`SQLite inventory failed: ${error?.message || 'invalid source bundle'}`);
      process.exitCode = 1;
    });
  }
}
