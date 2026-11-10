/** SHA-256 загруженного файла: дедупликация библиотеки. */
export const id = '003-checksum';

export function up(db) {
  const columns = db.prepare('PRAGMA table_info(tracks)').all().map((column) => column.name);
  if (!columns.includes('checksum')) {
    db.exec('ALTER TABLE tracks ADD COLUMN checksum TEXT');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_checksum
      ON tracks(checksum) WHERE checksum IS NOT NULL;
  `);
}
