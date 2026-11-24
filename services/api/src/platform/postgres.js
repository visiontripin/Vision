// @ts-check
import { Pool } from 'pg';

/**
 * Создаёт отдельный pool для нового серверного контура. Не использует DATABASE_URL,
 * чтобы не переключить существующий SQLite private-mode без отдельного ADR/миграции.
 * @param {{connectionString?: string, max?: number, connectionTimeoutMillis?: number}} [options]
 * @returns {import('pg').Pool}
 */
export function createPlatformPool(options = {}) {
  const connectionString = options.connectionString || process.env.PLATFORM_DATABASE_URL;
  if (!connectionString) {
    throw new Error('PLATFORM_DATABASE_URL is required for the platform Postgres stack.');
  }

  const max = options.max ?? Number(process.env.PLATFORM_PG_POOL_MAX || 10);
  if (!Number.isInteger(max) || max < 1 || max > 100) {
    throw new Error('PLATFORM_PG_POOL_MAX must be an integer between 1 and 100.');
  }

  const connectionTimeoutMillis = options.connectionTimeoutMillis ?? 5_000;
  if (!Number.isInteger(connectionTimeoutMillis) || connectionTimeoutMillis < 1) {
    throw new Error('connectionTimeoutMillis must be a positive integer.');
  }

  return new Pool({
    connectionString,
    max,
    connectionTimeoutMillis,
    idleTimeoutMillis: 30_000,
    application_name: 'vision-platform',
  });
}
