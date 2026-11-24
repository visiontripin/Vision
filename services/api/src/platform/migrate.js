// @ts-check
import { createPlatformPool } from './postgres.js';
import { runPlatformMigrations } from './migrations.js';

let pool;
try {
  pool = createPlatformPool();
  const result = await runPlatformMigrations(pool);
  if (result.applied.length === 0) {
    console.log(`Platform database is up to date (${result.current} migrations).`);
  } else {
    console.log(`Applied ${result.applied.length} platform migration(s): ${result.applied.join(', ')}`);
  }
} catch (error) {
  console.error('Platform database migration failed:', error);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
