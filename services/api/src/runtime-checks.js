import { DatabaseSync } from 'node:sqlite';

/**
 * Проверить FTS5 до миграции 002, чтобы неподдерживаемая сборка SQLite не
 * падала позднее непрозрачным `no such module: fts5`.
 *
 * @param {typeof DatabaseSync} [Database]
 */
export function assertFts5Available(Database = DatabaseSync) {
  /** @type {InstanceType<typeof DatabaseSync> | null} */
  let database = null;
  try {
    database = new Database(':memory:');
    database.exec('CREATE VIRTUAL TABLE vision_fts5_preflight USING fts5(content)');
    database.exec('DROP TABLE vision_fts5_preflight');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Vision API requires SQLite FTS5. Node 22.5–22.15 may ship SQLite without FTS5; upgrade to Node.js 22.16.0 or newer. Underlying error: ${detail}`,
      { cause: error },
    );
  } finally {
    database?.close();
  }
}
