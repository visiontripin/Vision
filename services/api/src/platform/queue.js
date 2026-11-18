// @ts-check
import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';

export const PLATFORM_QUEUE_NAME = 'vision-platform';
export const PLATFORM_DEAD_LETTER_QUEUE_NAME = 'vision-platform-dead-letter';
const QUEUE_PREFIX = 'vision-platform';

/** Redis is configured explicitly; no localhost fallback is used by the deployed process. */
export function createPlatformRedisConnection(redisUrl = process.env.PLATFORM_REDIS_URL) {
  if (typeof redisUrl !== 'string' || !/^rediss?:\/\//i.test(redisUrl)) {
    throw new Error('PLATFORM_REDIS_URL must be an explicit redis:// or rediss:// URL.');
  }
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    connectionName: 'vision-platform',
  });
}

/**
 * Creates separate durable primary and dead-letter queues. BullMQ stores job state
 * in Redis; deterministic job ids make the PostgreSQL outbox relay crash-safe.
 * @param {{connection?: import('ioredis').Redis, redisUrl?: string, prefix?: string}} [options]
 */
export function createPlatformQueues({ connection, redisUrl, prefix = QUEUE_PREFIX } = {}) {
  const redis = connection || createPlatformRedisConnection(redisUrl);
  const queue = new Queue(PLATFORM_QUEUE_NAME, {
    connection: redis,
    prefix,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: false,
    },
  });
  const deadLetterQueue = new Queue(PLATFORM_DEAD_LETTER_QUEUE_NAME, { connection: redis, prefix });
  const events = new QueueEvents(PLATFORM_QUEUE_NAME, { connection: redis, prefix });
  return Object.freeze({
    connection: redis,
    queue,
    deadLetterQueue,
    events,
    async close() {
      await Promise.all([queue.close(), deadLetterQueue.close(), events.close()]);
      await redis.quit();
    },
  });
}

/** @param {unknown} value */
function safeFailureCode(value) {
  const candidate = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'code' in value ? value.code : undefined;
  return typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate)
    ? candidate
    : 'worker_error';
}

/**
 * Start an at-least-once worker. Failed terminal attempts are copied to a durable
 * dead-letter queue with sanitized metadata; the source job is retained for audit.
 * @param {{connection: import('ioredis').Redis, prefix?: string,
 *   deadLetterQueue: import('bullmq').Queue, processor: import('bullmq').Processor,
 *   concurrency?: number, lockDuration?: number}} options
 */
export function createPlatformWorker({
  connection,
  prefix = QUEUE_PREFIX,
  deadLetterQueue,
  processor,
  concurrency = 2,
  lockDuration = 30_000,
}) {
  if (!connection || !deadLetterQueue) throw new Error('The worker requires a managed Redis connection and dead-letter queue.');
  if (typeof processor !== 'function') throw new Error('A platform job processor is required.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error('Worker concurrency must be between 1 and 32.');
  }
  const redis = connection;
  const ownDeadLetterQueue = deadLetterQueue;
  const worker = new Worker(PLATFORM_QUEUE_NAME, processor, {
    connection: redis,
    prefix,
    concurrency,
    lockDuration,
    stalledInterval: Math.max(1_000, Math.floor(lockDuration / 2)),
    maxStalledCount: 2,
  });

  worker.on('failed', (job, error) => {
    if (!job) return;
    const terminalAttempt = job.attemptsMade >= Number(job.opts.attempts || 1)
      || error?.name === 'UnrecoverableError';
    if (!terminalAttempt) return;
    const deadLetterId = `dlq-${job.id || randomUUID()}`;
    void ownDeadLetterQueue.add('job.failed', {
      originalJobId: String(job.id || ''),
      originalName: job.name,
      attemptsMade: job.attemptsMade,
      failureCode: safeFailureCode(error),
      failedAt: new Date().toISOString(),
      payload: job.data,
    }, { jobId: deadLetterId, removeOnComplete: false, removeOnFail: false })
      .catch((queueError) => worker.emit('error', queueError));
  });

  return worker;
}

export { UnrecoverableError };
