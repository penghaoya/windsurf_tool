const PRIORITY_WEIGHT = {
  high: 0,
  normal: 1,
  low: 2,
};

export function createRefreshQueue({ worker, concurrency = 3, logger = null } = {}) {
  const pending = [];
  const jobsByKey = new Map();
  let running = 0;
  let completed = 0;
  let failed = 0;

  const normalizePriority = (priority) =>
    Object.prototype.hasOwnProperty.call(PRIORITY_WEIGHT, priority)
      ? priority
      : 'normal';

  const sortPending = () => {
    pending.sort((a, b) => {
      const priorityDiff = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return a.seq - b.seq;
    });
  };

  let seq = 0;

  const getJobKey = (index, options = {}) =>
    options.key !== undefined && options.key !== null ? String(options.key) : String(index);

  const drain = () => {
    while (running < concurrency && pending.length > 0) {
      const job = pending.shift();
      running++;
      job.status = 'running';
      Promise.resolve()
        .then(() => worker(job.index, job))
        .then((value) => {
          completed++;
          job.resolve({ ok: true, index: job.index, key: job.key, value });
        })
        .catch((error) => {
          failed++;
          job.resolve({ ok: false, index: job.index, key: job.key, error });
        })
        .finally(() => {
          running--;
          jobsByKey.delete(job.key);
          drain();
        });
    }
  };

  const enqueue = (index, options = {}) => {
    if (!Number.isInteger(index) || index < 0) {
      return Promise.resolve({ ok: false, index, error: new Error('invalid_index') });
    }
    if (!worker) {
      return Promise.resolve({ ok: false, index, error: new Error('refresh_worker_not_configured') });
    }

    const priority = normalizePriority(options.priority || 'normal');
    const key = getJobKey(index, options);
    const existing = jobsByKey.get(key);
    if (existing) {
      if (
        existing.status === 'pending' &&
        PRIORITY_WEIGHT[priority] < PRIORITY_WEIGHT[existing.priority]
      ) {
        existing.priority = priority;
        existing.reason = options.reason || existing.reason;
        existing.index = index;
        existing.email = options.email || existing.email;
        sortPending();
      }
      return existing.promise;
    }

    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const job = {
      index,
      key,
      email: options.email || null,
      priority,
      reason: options.reason || 'refresh',
      status: 'pending',
      seq: ++seq,
      resolve,
      promise,
    };
    jobsByKey.set(key, job);
    pending.push(job);
    sortPending();
    logger?.('enqueue', { index, key, email: job.email, priority, reason: job.reason, pending: pending.length, running });
    drain();
    return promise;
  };

  const enqueueMany = (indexes, options = {}) => {
    const unique = [];
    const seen = new Set();
    for (const index of (indexes || [])) {
      if (!Number.isInteger(index) || index < 0) continue;
      const itemOptions = options.itemOptions ? (options.itemOptions(index) || {}) : {};
      const key = getJobKey(index, { ...options, ...itemOptions });
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ index, itemOptions });
    }
    const total = unique.length;
    let done = 0;
    const startedAt = Date.now();
    const enqueueDelayMs = Math.max(0, Number(options.enqueueDelayMs || 0));
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const run = async () => {
      const tasks = [];
      for (let i = 0; i < unique.length; i++) {
        if (i > 0 && enqueueDelayMs > 0) await delay(enqueueDelayMs);
        const { index, itemOptions } = unique[i];
        tasks.push(enqueue(index, { ...options, ...itemOptions }).then((result) => {
          done++;
          const settledIndex = Number.isInteger(result?.value?.index) ? result.value.index : index;
          try { options.progressFn?.(done - 1, total, result); } catch {}
          if (settledIndex >= 0) {
            try { options.onSettledIndex?.(settledIndex, result); } catch {}
          }
          return result;
        }));
      }
      const settled = await Promise.allSettled(tasks);
      return {
        total,
        settled,
        ok: settled.filter((item) => item.status === 'fulfilled' && item.value?.ok).length,
        failed: settled.filter((item) => item.status === 'fulfilled' && !item.value?.ok).length,
        elapsedMs: Date.now() - startedAt,
      };
    };
    const completion = run();
    if (options.wait === false) {
      completion.catch(() => {});
    }
    return completion;
  };

  const getStatus = () => ({
    pending: pending.length,
    running,
    queuedIndexes: [...jobsByKey.values()].map((job) => job.index),
    queuedKeys: [...jobsByKey.keys()],
    completed,
    failed,
  });

  return { enqueue, enqueueMany, getStatus };
}

let _queue = createRefreshQueue();

export function configureRefreshQueue(options) {
  _queue = createRefreshQueue(options);
  return _queue;
}

export function enqueueRefresh(index, options) {
  return _queue.enqueue(index, options);
}

export function enqueueRefreshAll(indexes, options) {
  return _queue.enqueueMany(indexes, options);
}

export function getRefreshQueueStatus() {
  return _queue.getStatus();
}
