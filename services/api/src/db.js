import { randomUUID } from 'node:crypto';
import { db, DATA_DIR, MEDIA_DIR, COVER_DIR } from './connection.js';
import { runMigrations, migrationStatus } from './migrations/index.js';

await runMigrations();

export { db, DATA_DIR, MEDIA_DIR, COVER_DIR, migrationStatus };

/* ------------------------------- маппинг -------------------------------- */

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

/* --------------------------------- поиск --------------------------------- */

const SORTS = {
  relevance: 'f.rank',
  recent: 't.created_at DESC',
  oldest: 't.created_at ASC',
  title: 't.title COLLATE NOCASE ASC',
  plays: 't.plays DESC, t.created_at DESC',
  duration: 't.duration DESC',
};

/** Экранирует пользовательский ввод в FTS5-запрос: префиксный поиск по словам. */
export function toMatchQuery(input) {
  const tokens = String(input)
    .replace(/["'^*:()\-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .slice(0, 8);
  if (!tokens.length) return null;
  return tokens.map((token) => `"${token}"*`).join(' AND ');
}

function buildQuery({ q, genre, liked, playlistId, sort = 'recent' }) {
  const joins = [];
  const joinParams = [];

  if (playlistId) {
    joins.push('JOIN playlist_tracks pt ON pt.track_id = t.id AND pt.playlist_id = ?');
    joinParams.push(playlistId);
  }

  const match = q ? toMatchQuery(q) : null;
  if (match) joins.push('JOIN tracks_fts f ON f.id = t.id');

  const clauses = [];
  const params = [];

  if (match) {
    clauses.push('tracks_fts MATCH ?');
    params.push(match);
  } else if (q) {
    clauses.push('(t.title LIKE ? OR t.artist LIKE ? OR t.album LIKE ? OR t.genre LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  if (genre) {
    clauses.push('t.genre = ?');
    params.push(genre);
  }
  if (liked) clauses.push('t.liked = 1');

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const order = playlistId
    ? 'pt.position ASC, t.created_at DESC'
    : SORTS[match ? (sort === 'recent' ? 'relevance' : sort) : sort] || SORTS.recent;

  return {
    from: `FROM tracks t ${joins.join(' ')} ${where}`,
    params: [...joinParams, ...params],
    order,
  };
}

export function listTracks(filters = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 2000);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const { from, params, order } = buildQuery(filters);

  const rows = db
    .prepare(`SELECT t.* ${from} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  return rows.map((row) => toTrack(row));
}

export function countTracks(filters = {}) {
  const { from, params } = buildQuery(filters);
  return db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params).n;
}

export function getTrack(id, opts) {
  const row = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
  return toTrack(row, opts);
}

export function getTrackFile(id) {
  const row = db.prepare('SELECT ext, mime FROM tracks WHERE id = ?').get(id);
  return row ? { ext: row.ext, mime: row.mime } : null;
}

export function getCoverInfo(id) {
  return db.prepare('SELECT cover_mime FROM tracks WHERE id = ?').get(id) ?? null;
}

export function findByChecksum(checksum) {
  if (!checksum) return null;
  const row = db.prepare('SELECT * FROM tracks WHERE checksum = ?').get(checksum);
  return toTrack(row);
}

/* --------------------------- запись и FTS-индекс -------------------------- */

function indexTrack(track, database = db) {
  database.prepare('DELETE FROM tracks_fts WHERE id = ?').run(track.id);
  database
    .prepare('INSERT INTO tracks_fts (id, title, artist, album, genre, description) VALUES (?, ?, ?, ?, ?, ?)')
    .run(track.id, track.title ?? '', track.artist ?? '', track.album ?? '', track.genre ?? '', track.description ?? '');
}

export function insertTrack(track) {
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO tracks
        (id, title, artist, album, genre, description, mime, ext, size, duration, peaks,
         cover_mime, plays, liked, checksum, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
    ).run(
      track.id, track.title, track.artist, track.album, track.genre, track.description,
      track.mime, track.ext, track.size, track.duration, track.peaks,
      track.cover_mime ?? null, track.checksum ?? null, track.created_at
    );
    indexTrack(track);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const EDITABLE_FIELDS = ['title', 'artist', 'album', 'genre', 'description'];

export function updateTrackFields(id, patch) {
  const fields = [];
  const values = [];

  for (const field of EDITABLE_FIELDS) {
    if (field in patch) {
      fields.push(`${field} = ?`);
      values.push(patch[field]);
    }
  }
  if ('liked' in patch) {
    fields.push('liked = ?');
    values.push(patch.liked ? 1 : 0);
  }
  if (!fields.length) return getTrack(id);

  db.exec('BEGIN');
  try {
    values.push(id);
    db.prepare(`UPDATE tracks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    const row = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
    if (row) indexTrack(row);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return getTrack(id);
}

export function setCoverMime(id, mime) {
  db.prepare('UPDATE tracks SET cover_mime = ? WHERE id = ?').run(mime, id);
}

export function deleteTrackRecord(id) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM tracks WHERE id = ?').run(id);
    db.prepare('DELETE FROM tracks_fts WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/* -------------------------------- история -------------------------------- */

export function recordListen(trackId, { position = 0, duration = 0, completed = false } = {}) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO listens (track_id, position, duration, completed, plays, updated_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(track_id) DO UPDATE SET
       position   = excluded.position,
       duration   = excluded.duration,
       completed  = MAX(listens.completed, excluded.completed),
       plays      = listens.plays + 1,
       updated_at = excluded.updated_at`
  ).run(trackId, Math.max(0, Number(position) || 0), Math.max(0, Number(duration) || 0), completed ? 1 : 0, now);
}

export function listHistory(limit = 12) {
  const rows = db.prepare(
    `SELECT t.*, l.position AS listen_position, l.duration AS listen_duration,
            l.completed AS listen_completed, l.plays AS listen_plays,
            l.updated_at AS listen_updated_at
     FROM listens l
     JOIN tracks t ON t.id = l.track_id
     ORDER BY l.updated_at DESC
     LIMIT ?`
  ).all(Math.min(Math.max(Number(limit) || 12, 1), 100));

  return rows.map((row) => ({
    track: toTrack(row),
    position: row.listen_position,
    duration: row.listen_duration,
    completed: Boolean(row.listen_completed),
    plays: row.listen_plays,
    listenedAt: row.listen_updated_at,
  }));
}

export function clearHistory() {
  db.exec('DELETE FROM listens');
}

/* -------------------------------- плейлисты ------------------------------ */

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

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    createdAt: row.created_at,
    trackCount: row.track_count,
    duration: row.duration,
  }));
}

export function getPlaylist(id) {
  return listPlaylists().find((playlist) => playlist.id === id) || null;
}

/* ------------------------------- статистика ------------------------------ */

export function stats() {
  const t = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(plays), 0) AS plays,
              COALESCE(SUM(duration), 0) AS duration, COALESCE(SUM(liked), 0) AS liked,
              COALESCE(SUM(size), 0) AS bytes
       FROM tracks`
    )
    .get();
  const p = db.prepare('SELECT COUNT(*) AS n FROM playlists').get();

  return {
    tracks: t.n,
    plays: t.plays,
    duration: t.duration,
    liked: t.liked,
    bytes: t.bytes,
    playlists: p.n,
  };
}

export function genres() {
  return db
    .prepare(
      `SELECT genre, COUNT(*) AS count FROM tracks
       WHERE genre IS NOT NULL AND length(genre) > 0
       GROUP BY genre ORDER BY count DESC`
    )
    .all();
}

/* ----------------------------- варианты аудио ---------------------------- */

function toVariant(row) {
  return {
    kind: row.kind,
    mime: row.mime,
    ext: row.ext,
    size: row.size,
    bitrate: row.bitrate,
    createdAt: row.created_at,
  };
}

export function listVariants(trackId) {
  return db
    .prepare('SELECT * FROM track_variants WHERE track_id = ? ORDER BY kind')
    .all(trackId)
    .map(toVariant);
}

export function getVariant(trackId, kind) {
  const row = db.prepare('SELECT * FROM track_variants WHERE track_id = ? AND kind = ?').get(trackId, kind);
  return row ? toVariant(row) : null;
}

export function upsertVariant({ trackId, kind, mime, ext, size = 0, bitrate = null }) {
  db.prepare(
    `INSERT INTO track_variants (track_id, kind, mime, ext, size, bitrate, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(track_id, kind) DO UPDATE SET
       mime = excluded.mime, ext = excluded.ext, size = excluded.size,
       bitrate = excluded.bitrate, created_at = excluded.created_at`
  ).run(trackId, kind, mime, ext, size, bitrate, new Date().toISOString());
}

export function deleteVariants(trackId) {
  db.prepare('DELETE FROM track_variants WHERE track_id = ?').run(trackId);
}

/** Треки без транскодированных вариантов — для догона после включения ffmpeg. */
export function tracksMissingVariants(limit = 50) {
  return db
    .prepare(
      `SELECT t.id, t.mime, t.title FROM tracks t
        LEFT JOIN track_variants v ON v.track_id = t.id AND v.kind = 'opus'
       WHERE v.track_id IS NULL
       ORDER BY t.created_at ASC
       LIMIT ?`
    )
    .all(Math.min(Math.max(Number(limit) || 50, 1), 500));
}

/* --------------------------- внешние источники --------------------------- */

function toExternal(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    permalink: row.permalink,
    title: row.title,
    artist: row.artist ?? null,
    artwork: row.artwork ?? null,
    embedUrl: row.embed_url,
    duration: row.duration,
    note: row.note ?? null,
    createdAt: row.created_at,
  };
}

export function listExternal(limit = 200) {
  return db
    .prepare('SELECT * FROM external_tracks ORDER BY created_at DESC LIMIT ?')
    .all(Math.min(Math.max(Number(limit) || 200, 1), 500))
    .map(toExternal);
}

export function getExternal(id) {
  return toExternal(db.prepare('SELECT * FROM external_tracks WHERE id = ?').get(id));
}

/** Повторный импорт той же ссылки обновляет метаданные, но не плодит записи. */
export function upsertExternal({ permalink, title, artist, artwork, embedUrl }) {
  const existing = db
    .prepare('SELECT id FROM external_tracks WHERE permalink = ?')
    .get(permalink);

  if (existing) {
    db.prepare(
      `UPDATE external_tracks
          SET title = ?, artist = ?, artwork = ?, embed_url = ?
        WHERE id = ?`
    ).run(title, artist, artwork, embedUrl, existing.id);
    return { ...getExternal(existing.id), created: false };
  }

  const id = randomUUID().replace(/-/g, '');
  db.prepare(
    `INSERT INTO external_tracks (id, source, permalink, title, artist, artwork, embed_url, duration, note, created_at)
     VALUES (?, 'soundcloud', ?, ?, ?, ?, ?, 0, NULL, ?)`
  ).run(id, permalink, title, artist, artwork, embedUrl, new Date().toISOString());

  return { ...getExternal(id), created: true };
}

export function updateExternalNote(id, note) {
  db.prepare('UPDATE external_tracks SET note = ? WHERE id = ?').run(note, id);
  return getExternal(id);
}

export function deleteExternal(id) {
  return db.prepare('DELETE FROM external_tracks WHERE id = ?').run(id).changes > 0;
}
