import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from './fetch.js';

const noSleep = async () => {};

test('returns the first successful result', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 2) throw new Error('flaky');
      return 'ok';
    },
    { sleep: noSleep },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('gives up after the configured retries', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error('down');
      },
      { retries: 2, sleep: noSleep },
    ),
    /down/,
  );
  assert.equal(calls, 3);
});
