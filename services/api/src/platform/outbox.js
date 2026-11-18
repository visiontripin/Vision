// @ts-check

function errorCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : 'queue_unavailable';
}

/**
 * Publish PostgreSQL outbox rows to BullMQ with deterministic job IDs. A crash
 * between Redis and the SQL commit is safe: a replay attempts the same job id.
 * @param {import('pg').Pool} pool
 * @param {import('bullmq').Queue} queue
 * @param {{limit?: number, maxAttempts?: number, nowMs?: number}} [options]
 */
export async function dispatchPlatformOutbox(pool, queue, { limit = 20, maxAttempts = 8, nowMs = Date.now() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Outbox limit must be between 1 and 100.');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 32) throw new Error('Outbox maxAttempts must be between 1 and 32.');
  const totals = { dispatched: 0, retried: 0, deadLettered: 0 };

  for (let index = 0; index < limit; index += 1) {
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      const result = await client.query(`
        SELECT id, topic, payload, attempts
        FROM platform_outbox
        WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND available_at <= $1
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `, [new Date(nowMs)]);
      const row = result.rows[0];
      if (!row) {
        await client.query('COMMIT');
        inTransaction = false;
        break;
      }

      try {
        await queue.add(row.topic, row.payload, { jobId: row.id });
        await client.query(`
          UPDATE platform_outbox SET processed_at = $2, attempts = attempts + 1, last_error_code = NULL
          WHERE id = $1
        `, [row.id, new Date(nowMs)]);
        totals.dispatched += 1;
      } catch (error) {
        const attempts = Number(row.attempts) + 1;
        const terminal = attempts >= maxAttempts;
        const delayMs = Math.min(60 * 60_000, 1_000 * (2 ** Math.min(attempts - 1, 12)));
        await client.query(`
          UPDATE platform_outbox
          SET attempts = $2, available_at = $3, dead_lettered_at = CASE WHEN $4 THEN $5 ELSE NULL END,
            last_error_code = $6
          WHERE id = $1
        `, [row.id, attempts, new Date(nowMs + delayMs), terminal, terminal ? new Date(nowMs) : null, errorCode(error)]);
        if (terminal) totals.deadLettered += 1;
        else totals.retried += 1;
      }
      await client.query('COMMIT');
      inTransaction = false;
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return totals;
}
