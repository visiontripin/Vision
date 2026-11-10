/** Варианты воспроизведения: opus/aac/HLS, полученные транскодингом. */
export const id = '006-variants';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS track_variants (
      track_id   TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,           -- opus | aac | hls
      mime       TEXT NOT NULL,
      ext        TEXT NOT NULL,
      size       INTEGER NOT NULL DEFAULT 0,
      bitrate    INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (track_id, kind)
    );

    CREATE INDEX IF NOT EXISTS idx_variants_kind ON track_variants(kind);
  `);
}
