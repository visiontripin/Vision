import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPlatformRedisConnection, createPlatformQueues, createPlatformWorker } from '../src/platform/queue.js';

const REDIS_URL = process.env.PLATFORM_REDIS_URL;

test('BullMQ retry, duplicate delivery, dead-letter and restart recovery on Redis', {
  skip: !REDIS_URL && 'Set PLATFORM_REDIS_URL to run the Redis integration test.',
}, async () => {
  const prefix = `vision-it-${randomUUID()}`;
  let redis;
  let queues;
  let worker;
  try {
    redis = createPlatformRedisConnection(REDIS_URL);
    queues = createPlatformQueues({ connection: redis, prefix });
    await Promise.all([
      queues.queue.waitUntilReady(), queues.deadLetterQueue.waitUntilReady(), queues.events.waitUntilReady(),
    ]);

    const retryCalls = new Map();
    worker = createPlatformWorker({
      connection: redis,
      prefix,
      deadLetterQueue: queues.deadLetterQueue,
      processor: async (job) => {
        if (job.data.case === 'retry') {
          const count = (retryCalls.get(job.id) || 0) + 1;
          retryCalls.set(job.id, count);
          if (count < 3) {
            const error = new Error('test transient failure');
            error.code = 'test_transient';
            throw error;
          }
        }
        if (job.data.case === 'dead') {
          const error = new Error('test terminal failure');
          error.code = 'test_terminal';
          throw error;
        }
        return { ok: true, case: job.data.case };
      },
      concurrency: 1,
      lockDuration: 2_000,
    });
    await worker.waitUntilReady();

    const retryId = randomUUID();
    const firstDelivery = await queues.queue.add('it.retry', { case: 'retry' }, {
      jobId: retryId, attempts: 3, backoff: { type: 'fixed', delay: 10 }, removeOnComplete: false,
    });
    const duplicateDelivery = await queues.queue.add('it.retry', { case: 'retry' }, {
      jobId: retryId, attempts: 3, backoff: { type: 'fixed', delay: 10 }, removeOnComplete: false,
    });
    assert.equal(duplicateDelivery.id, firstDelivery.id);
    assert.deepEqual(await firstDelivery.waitUntilFinished(queues.events, 10_000), { ok: true, case: 'retry' });
    assert.equal(retryCalls.get(retryId), 3);

    const failedJob = await queues.queue.add('it.dead', { case: 'dead' }, {
      attempts: 2, backoff: { type: 'fixed', delay: 10 }, removeOnFail: false,
    });
    await assert.rejects(failedJob.waitUntilFinished(queues.events, 10_000), /test terminal failure/);
    const dlqId = `dlq-${failedJob.id}`;
    let deadLetter = null;
    for (let attempt = 0; attempt < 50 && !deadLetter; attempt += 1) {
      deadLetter = await queues.deadLetterQueue.getJob(dlqId);
      if (!deadLetter) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(deadLetter, 'exhausted jobs are persisted in the dead-letter queue');
    assert.equal(deadLetter.data.failureCode, 'test_terminal');
    assert.equal(deadLetter.data.attemptsMade, 2);

    await worker.close();
    worker = null;
    await queues.close();
    queues = null;
    redis = null;

    // Queue data is durable across a worker/connection restart.
    const restartPrefix = `${prefix}-restart`;
    const firstRedis = createPlatformRedisConnection(REDIS_URL);
    const firstQueues = createPlatformQueues({ connection: firstRedis, prefix: restartPrefix });
    await firstQueues.queue.waitUntilReady();
    const pendingId = randomUUID();
    await firstQueues.queue.add('it.restart', { case: 'restart' }, { jobId: pendingId });
    await firstQueues.close();

    const nextRedis = createPlatformRedisConnection(REDIS_URL);
    const nextQueues = createPlatformQueues({ connection: nextRedis, prefix: restartPrefix });
    await Promise.all([nextQueues.queue.waitUntilReady(), nextQueues.events.waitUntilReady()]);
    const nextWorker = createPlatformWorker({
      connection: nextRedis,
      prefix: restartPrefix,
      deadLetterQueue: nextQueues.deadLetterQueue,
      processor: async (job) => ({ recovered: job.data.case === 'restart' }),
      concurrency: 1,
    });
    await nextWorker.waitUntilReady();
    const recoveredJob = await nextQueues.queue.getJob(pendingId);
    assert.ok(recoveredJob, 'queued job remains available after the original connection closes');
    assert.deepEqual(await recoveredJob.waitUntilFinished(nextQueues.events, 10_000), { recovered: true });
    await nextWorker.close();
    await nextQueues.close();
  } finally {
    await worker?.close().catch(() => {});
    await queues?.close().catch(() => {});
    if (redis?.status !== 'end') await redis?.quit().catch(() => {});
  }
});
