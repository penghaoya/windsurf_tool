import assert from 'node:assert/strict';
import test from 'node:test';
import { createRefreshQueue } from '../src/extension/core/refreshQueue.js';

test('refresh queue dedupes the same account index', async () => {
  let calls = 0;
  const queue = createRefreshQueue({
    concurrency: 1,
    worker: async (index) => {
      calls++;
      return { index };
    },
  });

  const [a, b] = await Promise.all([
    queue.enqueue(1, { priority: 'low' }),
    queue.enqueue(1, { priority: 'high' }),
  ]);

  assert.equal(calls, 1);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
});

test('refresh queue runs high priority jobs before low priority jobs', async () => {
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const queue = createRefreshQueue({
    concurrency: 1,
    worker: async (index) => {
      order.push(index);
      if (index === 1) await firstGate;
      return { index };
    },
  });

  const first = queue.enqueue(1, { priority: 'low' });
  const low = queue.enqueue(2, { priority: 'low' });
  const high = queue.enqueue(3, { priority: 'high' });

  releaseFirst();
  await Promise.all([first, low, high]);

  assert.deepEqual(order, [1, 3, 2]);
});

test('refresh queue reports enqueueMany progress and completion', async () => {
  const progress = [];
  const queue = createRefreshQueue({
    concurrency: 2,
    worker: async (index) => ({ index }),
  });

  const result = await queue.enqueueMany([1, 2, 2, 3], {
    progressFn: (done, total) => progress.push([done, total]),
  });

  assert.equal(result.total, 3);
  assert.equal(result.ok, 3);
  assert.deepEqual(progress, [[0, 3], [1, 3], [2, 3]]);
});

test('refresh queue dedupes by stable key when indexes differ', async () => {
  let calls = 0;
  const queue = createRefreshQueue({
    concurrency: 1,
    worker: async (index, job) => {
      calls++;
      return { index, key: job.key };
    },
  });

  const [a, b] = await Promise.all([
    queue.enqueue(1, { key: 'same@email.test', priority: 'low' }),
    queue.enqueue(4, { key: 'same@email.test', priority: 'high' }),
  ]);

  assert.equal(calls, 1);
  assert.equal(a.key, 'same@email.test');
  assert.equal(b.key, 'same@email.test');
});

test('refresh queue applies per-item options for enqueueMany', async () => {
  const keys = [];
  const settled = [];
  const queue = createRefreshQueue({
    concurrency: 1,
    worker: async (_index, job) => {
      keys.push(job.key);
      return { index: job.index };
    },
  });

  const result = await queue.enqueueMany([1, 2, 3], {
    itemOptions: (index) => ({ key: index >= 2 ? 'two' : String(index) }),
    onSettledIndex: (index) => settled.push(index),
  });

  assert.equal(result.total, 2);
  assert.deepEqual(keys, ['1', 'two']);
  assert.deepEqual(settled, [1, 2]);
});
