// @ts-check
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
export const PLATFORM_SCHEMA_VERSION = '008_playback_sessions.sql';
const MIGRATION_NAME = /^\d{3}_[a-z0-9_]+\.sql$/;
const ADVISORY_LOCK = [22_089, 21_326];

/**
 * Read the schema version used by the API's readiness and startup gates.
 * @param {import('pg').Pool} pool
 */
export async function getPlatformSchemaStatus(pool) {
  const schema = await pool.query(`
    SELECT to_regclass('public.platform_schema_migrations') IS NOT NULL AS has_migrations,
      to_regclass('public.users') IS NOT NULL AS has_users
  `);
  if (!schema.rows[0]?.has_migrations || !schema.rows[0]?.has_users) {
    return { migration: null, ready: false };
  }
  const latest = await pool.query('SELECT version FROM platform_schema_migrations ORDER BY version DESC LIMIT 1');
  const migration = latest.rows[0]?.version ?? null;
  return { migration, ready: migration === PLATFORM_SCHEMA_VERSION };
}

/** Refuse API startup unless the complete schema version required by this code is installed. */
export async function assertPlatformSchemaCurrent(pool) {
  const { migration, ready } = await getPlatformSchemaStatus(pool);
  if (ready) return migration;
  if (!migration) {
    throw new Error('Platform schema is not installed. Run `npm run migrate:platform` first.');
  }
  throw new Error(`Platform schema is at ${migration}, expected ${PLATFORM_SCHEMA_VERSION}. Run npm run migrate:platform before starting the API.`);
}

/**
 * Apply immutable SQL migrations in order. Each migration and its checksum record
 * commit atomically. A session advisory lock prevents concurrent API replicas from
 * running the same migration simultaneously.
 * @param {import('pg').Pool} pool
 * @param {{directory?: string}} [options]
 * @returns {Promise<{applied: string[], current: number}>}
 */
export async function runPlatformMigrations(pool, { directory = DEFAULT_MIGRATIONS_DIR } = {}) {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', ADVISORY_LOCK);
    locked = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_schema_migrations (
        version text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    const ordinals = new Set();
    for (const name of names) {
      if (!MIGRATION_NAME.test(name)) throw new Error(`Invalid platform migration filename: ${name}`);
      const ordinal = name.slice(0, 3);
      if (ordinals.has(ordinal)) throw new Error(`Duplicate platform migration ordinal: ${ordinal}`);
      ordinals.add(ordinal);
    }
    if (new Set(names).size !== names.length) throw new Error('Duplicate platform migration filename.');

    const appliedRows = await client.query('SELECT version, checksum FROM platform_schema_migrations ORDER BY version');
    const appliedByVersion = new Map(appliedRows.rows.map(({ version, checksum }) => [version, checksum]));
    const known = new Set(names);
    for (const version of appliedByVersion.keys()) {
      if (!known.has(version)) {
        throw new Error(`Applied platform migration ${version} is missing from the migration directory.`);
      }
    }
    const highestAppliedOrdinal = Math.max(0, ...[...appliedByVersion.keys()].map((name) => Number(name.slice(0, 3))));
    for (const name of names) {
      if (!appliedByVersion.has(name) && Number(name.slice(0, 3)) <= highestAppliedOrdinal) {
        throw new Error(`New platform migration ${name} must have a higher ordinal than already-applied migrations.`);
      }
    }

    const applied = [];
    for (const name of names) {
      const sql = await readFile(path.join(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const oldChecksum = appliedByVersion.get(name);
      if (oldChecksum !== undefined) {
        if (oldChecksum !== checksum) {
          throw new Error(`Applied platform migration ${name} changed; add a new migration instead.`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO platform_schema_migrations (version, checksum) VALUES ($1, $2)',
          [name, checksum],
        );
        await client.query('COMMIT');
        applied.push(name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Platform migration ${name} failed: ${error?.message || error}`, { cause: error });
      }
    }

    return { applied, current: names.length };
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1, $2)', ADVISORY_LOCK);
    } finally {
      client.release();
    }
  }
}
