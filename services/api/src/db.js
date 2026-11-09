import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const COVER_DIR = path.join(DATA_DIR, 'covers');

for (const dir of [DATA_DIR, MEDIA_DIR, COVER_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'vision.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS tracks (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    artist      TEXT NOT NULL DEFAULT 'Unknown',
    album       TEXT,
    genre       TEXT,
    description TEXT,
    mime        TEXT NOT NULL,
    ext         TEXT NOT NULL,
    size        INTEGER NOT NULL,
    duration    REAL NOT NULL DEFAULT 0,
    peaks       TEXT,
    cover_mime  TEXT,
    plays       INTEGER NOT NULL DEFAULT 0,
    liked       INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (playlist_id, track_id)
  );

  CREATE INDEX IF NOT EXISTS idx_tracks_created ON tracks(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tracks_liked ON tracks(liked);
  CREATE INDEX IF NOT EXISTS idx_playlist_tracks ON playlist_tracks(playlist_id, position);
`);

/** @param {any} row */
export function toTrack(row, { withPeaks = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album ?? null,
    genre: row.genre ?? null,
    description: row.description ?? null,
    mime: row.mime,
    size: row.size,
    duration: row.duration,
    peaks: withPeaks && row.peaks ? JSON.parse(row.peaks) : null,
    cover: Boolean(row.cover_mime),
    plays: row.plays,
    liked: Boolean(row.liked),
    createdAt: row.created_at,
  };
}

const SORTS = {
  recent: 'created_at DESC',
  oldest: 'created_at ASC',
  title: 'title COLLATE NOCASE ASC',
  plays: 'plays DESC, created_at DESC',
  duration: 'duration DESC',
};

export function listTracks({ q, genre, liked, sort = 'recent', limit = 500, playlistId }) {
  const where = [];
  const params = [];
  if (q) {
    where.push('(title LIKE ? OR artist LIKE ? OR album LIKE ? OR genre LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (genre) {
    where.push('genre = ?');
    params.push(genre);
  }
  if (liked) where.push('liked = 1');

  let join = '';
  if (playlistId) {
    join = 'JOIN playlist_tracks pt ON pt.track_id = t.id AND pt.playlist_id = ?';
    params.unshift(playlistId);
  }
  const order = playlistId
    ? 'pt.position ASC, t.created_at DESC'
    : SORTS[sort] || SORTS.recent;

  const sql = `SELECT t.* FROM tracks t ${join}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${order} LIMIT ?`;
  params.push(Math.min(Number(limit) || 500, 2000));
  return db.prepare(sql).all(...params).map((r) => toTrack(r));
}

export function getTrack(id, opts) {
  const row = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
  return toTrack(row, opts);
}

export function getTrackFile(id) {
  const row = db.prepare('SELECT ext, mime FROM tracks WHERE id = ?').get(id);
  return row ? { ext: row.ext, mime: row.mime } : null;
}

export function listPlaylists() {
  const rows = db
    .prepare(
      `SELECT p.*, COUNT(pt.track_id) AS track_count,
              COALESCE(SUM(t.duration), 0) AS duration
       FROM playlists p
       LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
       LEFT JOIN tracks t ON t.id = pt.track_id
       GROUP BY p.id
       ORDER BY p.created_at DESC`
    )
    .all();
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description ?? null,
    createdAt: p.created_at,
    trackCount: p.track_count,
    duration: p.duration,
  }));
}

export function getPlaylist(id) {
  return listPlaylists().find((p) => p.id === id) || null;
}

export function stats() {
  const t = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(plays),0) plays,
      COALESCE(SUM(duration),0) duration, COALESCE(SUM(liked),0) liked FROM tracks`).get();
  const p = db.prepare('SELECT COUNT(*) n FROM playlists').get();
  return {
    tracks: t.n,
    plays: t.plays,
    duration: t.duration,
    liked: t.liked,
    playlists: p.n,
  };
}

export function genres() {
  return db
    .prepare('SELECT genre, COUNT(*) AS count FROM tracks WHERE genre IS NOT NULL AND length(genre) > 0 GROUP BY genre ORDER BY count DESC')
    .all();
}
