// @ts-check
import { createServer } from 'node:http';
import { createPlatformPool } from './postgres.js';
import { createPlatformStorage } from './storage.js';
import { createPlatformRedisConnection, createPlatformQueues, createPlatformWorker } from './queue.js';
import { createPlatformJobProcessor } from './worker.js';
import { dispatchPlatformOutbox } from './outbox.js';
import { expirePendingUploadIntents } from './upload.js';
import { requirePlatformAuthSecret } from './auth-crypto.js';

const HEALTH_PORT = Number(process.env.PLATFORM_WORKER_HEALTH_PORT || 4401);
if (!Number.isInteger(HEALTH_PORT) || HEALTH_PORT < 1 || HEALTH_PORT > 65_535) {
  throw new Error('PLATFORM_WORKER_HEALTH_PORT must be between 1 and 65535.');
}

let pool;
let storage;
let queues;
let worker;
let healthServer;
let outboxTimer;
let stopping = false;

function code(error) {
  const value = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : 'worker_error';
}

async function main() {
  requirePlatformAuthSecret();
  pool = createPlatformPool();
  storage = createPlatformStorage();
  await storage.ensureBucket();
  const redis = createPlatformRedisConnection();
  queues = createPlatformQueues({ connection: redis });
  await Promise.all([
    queues.queue.waitUntilReady(),
    queues.deadLetterQueue.waitUntilReady(),
    queues.events.waitUntilReady(),
  ]);
  worker = createPlatformWorker({
    connection: redis,
    deadLetterQueue: queues.deadLetterQueue,
    processor: createPlatformJobProcessor({ pool, storage }),
  });
  await worker.waitUntilReady();
  worker.on('completed', (job, result) => {
    console.log(JSON.stringify({ level: 'info', event: 'platform_job_completed', jobId: job.id, type: job.name, result: result?.status }));
  });
  worker.on('failed', (job, error) => {
    console.error(JSON.stringify({
      level: 'error', event: 'platform_job_failed', jobId: job?.id,
      type: job?.name, attempts: job?.attemptsMade, errorCode: code(error),
    }));
  });
  worker.on('error', (error) => {
    console.error(JSON.stringify({ level: 'error', event: 'platform_worker_error', errorCode: code(error) }));
  });
  queues.events.on('error', (error) => {
    console.error(JSON.stringify({ level: 'error', event: 'platform_queue_events_error', errorCode: code(error) }));
  });

  let dispatching = false;
  let lastUploadSweep = 0;
  outboxTimer = setInterval(async () => {
    if (dispatching || stopping) return;
    dispatching = true;
    try {
      const result = await dispatchPlatformOutbox(pool, queues.queue);
      if (result.dispatched || result.deadLettered) {
        console.log(JSON.stringify({ level: 'info', event: 'platform_outbox_dispatch', ...result }));
      }
      if (Date.now() - lastUploadSweep >= 60_000) {
        lastUploadSweep = Date.now();
        const expired = await expirePendingUploadIntents(pool, storage);
        if (expired.expired) console.log(JSON.stringify({ level: 'info', event: 'platform_upload_intents_expired', ...expired }));
      }
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'platform_outbox_error', errorCode: code(error) }));
    } finally {
      dispatching = false;
    }
  }, 1_000);
  outboxTimer.unref();

  healthServer = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method !== 'GET' || req.url !== '/health') {
      res.statusCode = 404;
      res.end('{"error":"not_found"}');
      return;
    }
    const ready = !stopping && worker.isRunning();
    res.statusCode = ready ? 200 : 503;
    res.end(JSON.stringify({ ok: ready, service: 'vision-platform-worker' }));
  });
  await new Promise((resolve, reject) => {
    healthServer.once('error', reject);
    healthServer.listen(HEALTH_PORT, '127.0.0.1', resolve);
  });
  console.log(JSON.stringify({ level: 'info', event: 'platform_worker_started', healthPort: HEALTH_PORT }));
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(outboxTimer);
  try {
    await new Promise((resolve) => {
      if (!healthServer?.listening) return resolve();
      healthServer.close(() => resolve());
    });
    await worker?.close();
    await queues?.close();
    await Promise.all([pool?.end(), storage?.close()]);
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'platform_worker_shutdown_error', errorCode: code(error) }));
    process.exitCode = 1;
  }
}

try {
  await main();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error(JSON.stringify({ level: 'error', event: 'platform_worker_start_failed', errorCode: code(error) }));
  const resources = /** @type {any} */ ({ worker, queues, pool, storage });
  const cleanup = [];
  if (resources.worker) cleanup.push(resources.worker.close());
  if (resources.queues) cleanup.push(resources.queues.close());
  if (resources.pool) cleanup.push(resources.pool.end());
  if (resources.storage) cleanup.push(resources.storage.close());
  await Promise.all(cleanup);
  process.exitCode = 1;
}
