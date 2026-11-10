/** Базовые таблицы. Идемпотентно: на существующих базах ничего не меняет. */
export const id = '001-base';

export function up(db) {
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre);
    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
    CREATE INDEX IF NOT EXISTS idx_playlist_tracks ON playlist_tracks(playlist_id, position);
  `);
}
