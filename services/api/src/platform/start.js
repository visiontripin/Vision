// @ts-check
import { createPlatformPool } from './postgres.js';
import { createPlatformServer } from './server.js';
import { requirePlatformAuthSecret } from './auth-crypto.js';
import { getPlatformServerConfig } from './config.js';
import { createPlatformStorage } from './storage.js';
import { createPlatformRateLimiter } from './rate-limit.js';
import { assertPlatformSchemaCurrent } from './migrations.js';

let pool;
let server;
let storage;
let rateLimiter;
try {
  const secret = requirePlatformAuthSecret();
  pool = createPlatformPool();
  await assertPlatformSchemaCurrent(pool);

  const { port, host, registrationEnabled, uploadsEnabled, maxUploadBytes } = getPlatformServerConfig();
  rateLimiter = createPlatformRateLimiter({ secret });
  await rateLimiter.ready();
  if (process.env.PLATFORM_S3_ENDPOINT) {
    storage = createPlatformStorage();
    await storage.ensureBucket();
  }
  if (uploadsEnabled && !storage) throw new Error('Uploads cannot be enabled without configured private S3 storage.');
  server = createPlatformServer({
    pool, secret, registrationEnabled, uploadsEnabled, maxUploadBytes, storage, rateLimiter,
    metricsToken: process.env.PLATFORM_METRICS_TOKEN || undefined,
  });
  server.listen(port, host, () => {
    console.log(`Vision platform API listening on http://${host}:${port} (registration ${registrationEnabled ? 'enabled' : 'disabled'}).`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(async () => {
      await Promise.all([pool.end(), storage?.close(), rateLimiter?.close()]);
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
  await Promise.all([pool?.end(), storage?.close(), rateLimiter?.close()]);
  process.exitCode = 1;
}
