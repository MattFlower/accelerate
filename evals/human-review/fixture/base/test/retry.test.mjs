import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay, canRetry } from '../src/retry/policy.mjs';
import { Scheduler } from '../src/retry/scheduler.mjs';

test('delay starts at base and stays below the ceiling', () => {
  assert.equal(retryDelay(1), 100);
  assert.equal(retryDelay(20), 10000);
});

test('permanent errors are not retried', () => {
  assert.equal(canRetry(new Error('rejected'), 1), false);
  assert.equal(canRetry({ retryable: true }, 4), false);
});

test('scheduler retries transient delivery failures', async () => {
  let now = 0;
  const queue = new Scheduler({ baseMs: 100, capMs: 1000, maxAttempts: 3 }, () => now);
  queue.enqueue('a', { orderId: 'a' });
  await queue.tick(async () => { throw { retryable: true }; });
  assert.equal(queue.snapshot().pending[0].attempt, 2);
  now = 100;
  await queue.tick(async () => {});
  assert.equal(queue.snapshot().finished[0].outcome, 'sent');
});
