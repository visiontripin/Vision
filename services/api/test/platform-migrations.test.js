import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createPlatformPool } from '../src/platform/postgres.js';
import { runPlatformMigrations } from '../src/platform/migrations.js';

class MemoryMigrationPool {
  constructor() {
    this.applied = new Map();
    this.events = [];
    this.migrationSql = [];
    this.failOnSql = null;
    this.snapshot = null;
    this.released = 0;
  }

  async connect() {
    return this;
  }

  async query(sql, values = []) {
    const text = String(sql).trim();
    if (text.startsWith('SELECT pg_advisory_lock')) {
      this.events.push('lock');
      return { rows: [] };
    }
    if (text.startsWith('SELECT pg_advisory_unlock')) {
      this.events.push('unlock');
      return { rows: [{ pg_advisory_unlock: true }] };
    }
    if (text.startsWith('CREATE TABLE IF NOT EXISTS platform_schema_migrations')) {
      this.events.push('create-ledger');
      return { rows: [] };
    }
    if (text.startsWith('SELECT version, checksum FROM platform_schema_migrations')) {
      return { rows: [...this.applied].map(([version, checksum]) => ({ version, checksum })) };
    }
    if (text === 'BEGIN') {
      this.snapshot = new Map(this.applied);
      this.events.push('begin');
      return { rows: [] };
    }
    if (text === 'COMMIT') {
      this.snapshot = null;
      this.events.push('commit');
      return { rows: [] };
    }
    if (text === 'ROLLBACK') {
      if (this.snapshot) this.applied = this.snapshot;
      this.snapshot = null;
      this.events.push('rollback');
      return { rows: [] };
    }
    if (text.startsWith('INSERT INTO platform_schema_migrations')) {
      this.applied.set(values[0], values[1]);
      this.events.push(`ledger:${values[0]}`);
      return { rows: [] };
    }

    this.migrationSql.push(text);
    if (this.failOnSql && text.includes(this.failOnSql)) throw new Error('synthetic DDL failure');
    this.events.push('migration-sql');
    return { rows: [] };
  }

  release() {
    this.released += 1;
    this.events.push('release');
  }
}

async function withMigrationDirectory(files, callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'vision-platform-migrations-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(path.join(directory, name), contents, 'utf8');
    }
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('platform PostgreSQL foundation', () => {
  test('pool requires the platform-specific URL and validates sizing', async () => {
    const oldUrl = process.env.PLATFORM_DATABASE_URL;
    delete process.env.PLATFORM_DATABASE_URL;
    try {
      assert.throws(() => createPlatformPool(), /PLATFORM_DATABASE_URL is required/);
      assert.throws(
        () => createPlatformPool({ connectionString: 'postgres://localhost/vision', max: 0 }),
        /PLATFORM_PG_POOL_MAX must be an integer/,
      );
      assert.throws(
        () => createPlatformPool({ connectionString: 'postgres://localhost/vision', max: 101 }),
        /PLATFORM_PG_POOL_MAX must be an integer/,
      );

      const pool = createPlatformPool({
        connectionString: 'postgres://user:pass@127.0.0.1/vision',
        max: 3,
        connectionTimeoutMillis: 1_200,
      });
      assert.equal(pool.options.max, 3);
      assert.equal(pool.options.connectionTimeoutMillis, 1_200);
      assert.equal(pool.options.application_name, 'vision-platform');
      await pool.end();
    } finally {
      if (oldUrl === undefined) delete process.env.PLATFORM_DATABASE_URL;
      else process.env.PLATFORM_DATABASE_URL = oldUrl;
    }
  });

  test('applies lexically ordered migrations once, records checksums, and releases the lock', async () => {
    await withMigrationDirectory({
      '002_catalog.sql': 'CREATE TABLE catalog_marker (id integer);',
      '001_identity.sql': 'CREATE TABLE identity_marker (id integer);',
    }, async (directory) => {
      const pool = new MemoryMigrationPool();
      const result = await runPlatformMigrations(pool, { directory });
      assert.deepEqual(result, {
        applied: ['001_identity.sql', '002_catalog.sql'],
        current: 2,
      });
      assert.deepEqual(pool.migrationSql, [
        'CREATE TABLE identity_marker (id integer);',
        'CREATE TABLE catalog_marker (id integer);',
      ]);
      assert.equal(
        pool.applied.get('001_identity.sql'),
        createHash('sha256').update('CREATE TABLE identity_marker (id integer);').digest('hex'),
      );
      assert.deepEqual(pool.events.filter((event) => ['lock', 'unlock', 'release'].includes(event)), [
        'lock', 'unlock', 'release',
      ]);

      const secondRun = await runPlatformMigrations(pool, { directory });
      assert.deepEqual(secondRun, { applied: [], current: 2 });
      assert.equal(pool.migrationSql.length, 2, 'an applied migration is never replayed');
      assert.equal(pool.released, 2, 'every acquired client is released');
    });
  });

  test('refuses changed or removed applied migrations', async () => {
    await withMigrationDirectory({ '001_identity.sql': 'CREATE TABLE identity_marker (id integer);' }, async (directory) => {
      const pool = new MemoryMigrationPool();
      await runPlatformMigrations(pool, { directory });
      await writeFile(path.join(directory, '001_identity.sql'), 'CREATE TABLE identity_marker (id bigint);', 'utf8');
      await assert.rejects(runPlatformMigrations(pool, { directory }), /changed; add a new migration/);

      await rm(path.join(directory, '001_identity.sql'));
      await assert.rejects(runPlatformMigrations(pool, { directory }), /is missing from the migration directory/);
      assert.equal(pool.released, 3);
      assert.equal(pool.events.filter((event) => event === 'unlock').length, 3);
    });
  });

  test('rolls back a failed migration and always unlocks/releases its client', async () => {
    await withMigrationDirectory({ '001_broken.sql': 'FAIL THIS MIGRATION;' }, async (directory) => {
      const pool = new MemoryMigrationPool();
      pool.failOnSql = 'FAIL THIS MIGRATION';
      await assert.rejects(runPlatformMigrations(pool, { directory }), /Platform migration 001_broken.sql failed/);
      assert.equal(pool.applied.size, 0, 'failed migration ledger entry is rolled back');
      assert.ok(pool.events.includes('rollback'));
      assert.ok(pool.events.includes('unlock'));
      assert.equal(pool.released, 1);
    });
  });

  test('rejects duplicate ordinals and backdated migrations', async () => {
    await withMigrationDirectory({
      '001_first.sql': 'SELECT 1;',
      '001_second.sql': 'SELECT 2;',
    }, async (directory) => {
      const pool = new MemoryMigrationPool();
      await assert.rejects(runPlatformMigrations(pool, { directory }), /Duplicate platform migration ordinal/);
    });

    await withMigrationDirectory({
      '001_backdated.sql': 'SELECT 1;',
      '002_current.sql': 'SELECT 2;',
    }, async (directory) => {
      const pool = new MemoryMigrationPool();
      pool.applied.set('002_current.sql', '0'.repeat(64));
      await assert.rejects(runPlatformMigrations(pool, { directory }), /must have a higher ordinal/);
    });
  });

  test('rejects non-versioned SQL files rather than applying them', async () => {
    await withMigrationDirectory({ 'create-table.sql': 'CREATE TABLE unsafe (id integer);' }, async (directory) => {
      const pool = new MemoryMigrationPool();
      await assert.rejects(runPlatformMigrations(pool, { directory }), /Invalid platform migration filename/);
      assert.equal(pool.migrationSql.length, 0);
      assert.equal(pool.released, 1);
      assert.ok(pool.events.includes('unlock'));
    });
  });
});
