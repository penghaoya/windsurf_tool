const PRIORITY_WEIGHT = {
  high: 0,
  normal: 1,
  low: 2,
};

export function createRefreshQueue({ worker, concurrency = 3, logger = null } = {}) {
  const pending = [];
  const jobsByIndex = new Map();
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

  const drain = () => {
    while (running < concurrency && pending.length > 0) {
      const job = pending.shift();
      running++;
      job.status = 'running';
      Promise.resolve()
        .then(() => worker(job.index, job))
        .then((value) => {
          completed++;
          job.resolve({ ok: true, index: job.index, value });
        })
        .catch((error) => {
          failed++;
          job.resolve({ ok: false, index: job.index, error });
        })
        .finally(() => {
          running--;
          jobsByIndex.delete(job.index);
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
    const existing = jobsByIndex.get(index);
    if (existing) {
      if (
        existing.status === 'pending' &&
        PRIORITY_WEIGHT[priority] < PRIORITY_WEIGHT[existing.priority]
      ) {
        existing.priority = priority;
        existing.reason = options.reason || existing.reason;
        sortPending();
      }
      return existing.promise;
    }

    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const job = {
      index,
      priority,
      reason: options.reason || 'refresh',
      status: 'pending',
      seq: ++seq,
      resolve,
      promise,
    };
    jobsByIndex.set(index, job);
    pending.push(job);
    sortPending();
    logger?.('enqueue', { index, priority, reason: job.reason, pending: pending.length, running });
    drain();
    return promise;
  };

  const enqueueMany = (indexes, options = {}) => {
    const unique = [...new Set((indexes || []).filter((index) => Number.isInteger(index) && index >= 0))];
    const total = unique.length;
    let done = 0;
    const tasks = unique.map((index) =>
      enqueue(index, options).then((result) => {
        done++;
        try { options.progressFn?.(done - 1, total, result); } catch {}
        try { options.onSettledIndex?.(index, result); } catch {}
        return result;
      })
    );
    const completion = Promise.allSettled(tasks).then((settled) => ({
      total,
      settled,
      ok: settled.filter((item) => item.status === 'fulfilled' && item.value?.ok).length,
      failed: settled.filter((item) => item.status === 'fulfilled' && !item.value?.ok).length,
    }));
    if (options.wait === false) {
      completion.catch(() => {});
    }
    return completion;
  };

  const getStatus = () => ({
    pending: pending.length,
    running,
    queuedIndexes: [...jobsByIndex.keys()],
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
