import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditLegacySqliteBundle } from './platform-sqlite-audit.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeBundle() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vision-sqlite-audit-'));
  const mediaDirectory = path.join(directory, 'media');
  const coversDirectory = path.join(directory, 'covers');
  mkdirSync(mediaDirectory);
  mkdirSync(coversDirectory);

  const goodAudio = Buffer.from('approved-only-for-test-fixture');
  const staleAudio = Buffer.from('stale local bytes');
  const databasePath = path.join(directory, 'vision.db');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec(`
    CREATE TABLE schema_version (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE tracks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, ext TEXT, checksum TEXT, size INTEGER,
      cover_mime TEXT, created_at TEXT
    );
    CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE playlist_tracks (
      playlist_id TEXT REFERENCES playlists(id),
      track_id TEXT REFERENCES tracks(id)
    );
    CREATE TABLE listens (track_id TEXT PRIMARY KEY, plays INTEGER NOT NULL);
    CREATE TABLE listen_events (id INTEGER PRIMARY KEY, track_id TEXT NOT NULL);
  `);
  database.prepare('INSERT INTO schema_version VALUES (?, ?)').run('001-base', '2026-11-12T00:00:00.000Z');
  const insertTrack = database.prepare('INSERT INTO tracks VALUES (?, ?, ?, ?, ?, ?, ?)');
  insertTrack.run('track-good', 'PRIVATE TITLE MUST NOT LEAK', 'wav', sha256(goodAudio), goodAudio.length, 'image/png', '2026-11-12T00:00:00.000Z');
  insertTrack.run('track-stale', 'ANOTHER PRIVATE TITLE', 'mp3', sha256(Buffer.from('expected bytes')), 999, null, '2026-11-12T00:00:00.000Z');
  insertTrack.run('../unsafe', 'UNSAFE PATH TITLE', 'mp3', 'not-a-checksum', 10, 'image/png', '2026-11-12T00:00:00.000Z');
  insertTrack.run('external-ref', 'EXTERNAL TITLE', null, null, 0, null, '2026-11-12T00:00:00.000Z');
  insertTrack.run('track-unknown-cover', 'COVER MIME TITLE', null, null, 0, 'image/svg+xml', '2026-11-12T00:00:00.000Z');
  database.prepare('INSERT INTO playlist_tracks VALUES (?, ?)').run('missing-playlist', 'track-good');
  database.prepare('INSERT INTO listens VALUES (?, ?)').run('track-good', 7);
  database.prepare('INSERT INTO listen_events VALUES (?, ?)').run(1, 'track-good');
  database.close();

  writeFileSync(path.join(mediaDirectory, 'track-good.wav'), goodAudio);
  writeFileSync(path.join(mediaDirectory, 'track-stale.mp3'), staleAudio);
  writeFileSync(path.join(coversDirectory, 'track-good.png'), 'synthetic cover bytes');
  return { directory, databasePath };
}

test('SQLite migration audit is read-only, aggregates source state, and emits no titles or paths', async () => {
  const { directory, databasePath } = makeBundle();
  try {
    const originalDatabase = readFileSync(databasePath);
    const originalEntries = readdirSync(directory).sort();
    const report = await auditLegacySqliteBundle(directory);
    const serialized = JSON.stringify(report);

    assert.equal(report.reportType, 'vision-legacy-sqlite-inventory');
    assert.equal(report.mode, 'read-only-inventory-only');
    assert.equal(report.writesPerformed, false);
    assert.equal(report.importOrCutoverPerformed, false);
    assert.deepEqual(report.source.integrityCheck, { ok: true, resultCount: 1 });
    assert.deepEqual(report.source.migrationIds, ['001-base']);
    assert.equal(report.tableCounts.tracks, 5);
    assert.equal(report.tableCounts.listens, 1);
    assert.equal(report.tableCounts.listen_events, 1);
    assert.equal(report.foreignKeyViolations.playlist_tracks, 1);
    assert.equal(report.tracks.total, 5);
    assert.equal(report.tracks.withLocalExtension, 3);
    assert.equal(report.tracks.withoutLocalExtension, 2);
    assert.equal(report.tracks.missingFiles, 1);
    assert.equal(report.tracks.checksumMatches, 1);
    assert.equal(report.tracks.checksumMismatches, 1);
    assert.equal(report.tracks.invalidChecksums, 1);
    assert.equal(report.tracks.sizeMismatches, 1);
    assert.equal(report.tracks.invalidFileReferences, 1);
    assert.equal(report.tracks.duplicateChecksumGroups, 0);
    assert.equal(report.covers.present, 1);
    assert.equal(report.covers.unsupportedMime, 1);
    assert.equal(report.covers.unsafePaths, 1);
    assert.doesNotMatch(serialized, /PRIVATE TITLE|UNSAFE PATH TITLE|EXTERNAL TITLE|COVER MIME TITLE|track-good|track-stale|external-ref|\.\.\/unsafe/);
    assert.deepEqual(readFileSync(databasePath), originalDatabase, 'source DB bytes stay untouched');
    assert.deepEqual(readdirSync(directory).sort(), originalEntries, 'source bundle entries stay untouched');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite migration audit rejects a missing or non-directory source without creating a database', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vision-sqlite-audit-empty-'));
  try {
    await assert.rejects(auditLegacySqliteBundle(directory), /regular vision\.db/);
    assert.equal(existsSync(path.join(directory, 'vision.db')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
