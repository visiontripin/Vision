// @ts-check
import { createPlatformPool } from './postgres.js';
import { createPlatformServer } from './server.js';
import { requirePlatformAuthSecret } from './auth-crypto.js';
import { getPlatformServerConfig } from './config.js';
import { createPlatformStorage } from './storage.js';

let pool;
let server;
let storage;
try {
  const secret = requirePlatformAuthSecret();
  pool = createPlatformPool();
  const schema = await pool.query(`
    SELECT to_regclass('public.platform_schema_migrations') IS NOT NULL AS has_migrations,
      to_regclass('public.users') IS NOT NULL AS has_users
  `);
  if (!schema.rows[0]?.has_migrations || !schema.rows[0]?.has_users) {
    throw new Error('Platform schema is not installed. Run `npm run migrate:platform` first.');
  }
  const latestMigration = await pool.query('SELECT version FROM platform_schema_migrations ORDER BY version DESC LIMIT 1');
  if (!latestMigration.rows[0]) {
    throw new Error('Platform database has no applied migrations. Run `npm run migrate:platform` first.');
  }

  const { port, host, registrationEnabled, uploadsEnabled, maxUploadBytes } = getPlatformServerConfig();
  if (process.env.PLATFORM_S3_ENDPOINT) {
    storage = createPlatformStorage();
    await storage.ensureBucket();
  }
  if (uploadsEnabled && !storage) throw new Error('Uploads cannot be enabled without configured private S3 storage.');
  server = createPlatformServer({ pool, secret, registrationEnabled, uploadsEnabled, maxUploadBytes, storage });
  server.listen(port, host, () => {
    console.log(`Vision platform API listening on http://${host}:${port} (registration ${registrationEnabled ? 'enabled' : 'disabled'}).`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(async () => {
      await Promise.all([pool.end(), storage?.close()]);
      process.exitCode = 0;
    });
    setTimeout(() => {
      console.error('Platform API graceful shutdown timed out.');
      process.exitCode = 1;
    }, 10_000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error('Platform API startup failed.', { errorName: error?.name, errorCode: error?.code, message: error?.message });
  await Promise.all([pool?.end(), storage?.close()]);
  process.exitCode = 1;
}
