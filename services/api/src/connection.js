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

// WAL + нормальный synchronous: запись в разы быстрее при том же уровне надёжности.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
