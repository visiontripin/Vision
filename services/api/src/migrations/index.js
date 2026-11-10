import { readdirSync } from 'node:fs';
import path from 'node:path';
import { db } from '../connection.js';

/**
 * Простые миграции: нумерованные модули, каждый делает `up(db)`.
 * Применённые версии пишутся в schema_version, повторный запуск безопасен.
 * Требование: `up()` идемпотентен (IF NOT EXISTS / проверки PRAGMA) — так проще
 * обновлять уже работающие инсталляции и отлаживать.
 */
const MIGRATIONS_DIR = path.dirname(new URL(import.meta.url).pathname);

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_version (
    id         TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`);

const applied = new Set(
  db.prepare('SELECT id FROM schema_version').all().map((row) => row.id)
);

const files = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.js') && file !== 'index.js')
  .sort();

export async function runMigrations({ quiet = false } = {}) {
  for (const file of files) {
    const module = await import(`./${file}`);
    const id = module.id;
    if (!id) throw new Error(`migration ${file} has no id`);
    if (applied.has(id)) continue;

    db.exec('BEGIN');
    try {
      module.up(db);
      db.prepare('INSERT INTO schema_version (id, applied_at) VALUES (?, ?)')
        .run(id, new Date().toISOString());
      db.exec('COMMIT');
      applied.add(id);
      if (!quiet) console.log(`[db] applied migration ${id}`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${id} failed: ${error?.message ?? error}`);
    }
  }
}

export function migrationStatus() {
  return {
    applied: [...applied].sort(),
    pending: files.length - applied.size,
  };
}
