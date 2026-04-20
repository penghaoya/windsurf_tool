const PRIORITY_WEIGHT = {
  high: 0,
  normal: 1,
  low: 2,
};

export function createRefreshQueue({ worker, concurrency = 3, logger = null } = {}) {
  const pending = [];
  const jobsByKey = new Map();
  const laneState = new Map();
  let running = 0;
  let completed = 0;
  let failed = 0;
  let drainTimer = null;

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

  const getLaneState = (lane) => {
    if (!laneState.has(lane)) laneState.set(lane, { running: 0, lastStart: 0 });
    return laneState.get(lane);
  };

  const getStartWaitMs = (job, now = Date.now()) => {
    if (!job.lane || job.minStartGapMs <= 0) return 0;
    const state = getLaneState(job.lane);
    if (!state.lastStart) return 0;
    return Math.max(0, job.minStartGapMs - (now - state.lastStart));
  };

  const canStartJob = (job, now = Date.now()) => {
    if (!job.lane) return true;
    const state = getLaneState(job.lane);
    if (state.running >= job.laneConcurrency) return false;
    return getStartWaitMs(job, now) === 0;
  };

  const scheduleDrain = (delayMs) => {
    if (!Number.isFinite(delayMs) || delayMs < 0) return;
    if (drainTimer) return;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      drain();
    }, delayMs);
  };

  const findNextJobIndex = () => {
    const now = Date.now();
    let waitMs = Infinity;
    for (let i = 0; i < pending.length; i++) {
      const job = pending[i];
      if (canStartJob(job, now)) return { index: i, waitMs: 0 };
      const lane = job.lane ? getLaneState(job.lane) : null;
      if (lane && lane.running < job.laneConcurrency) {
        waitMs = Math.min(waitMs, getStartWaitMs(job, now));
      }
    }
    return { index: -1, waitMs };
  };

  const startJob = (job) => {
    running++;
    job.status = 'running';
    if (job.lane) {
      const state = getLaneState(job.lane);
      state.running++;
      state.lastStart = Date.now();
    }
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
        if (job.lane) {
          const state = getLaneState(job.lane);
          state.running = Math.max(0, state.running - 1);
        }
        jobsByKey.delete(job.key);
        drain();
      });
  };

  const drain = () => {
    while (running < concurrency && pending.length > 0) {
      const next = findNextJobIndex();
      if (next.index < 0) {
        if (next.waitMs !== Infinity) scheduleDrain(next.waitMs);
        return;
      }
      const [job] = pending.splice(next.index, 1);
      startJob(job);
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
        existing.lane = options.lane || existing.lane;
        existing.laneConcurrency = Math.max(1, Number(options.laneConcurrency || existing.laneConcurrency || 1));
        existing.minStartGapMs = Math.max(0, Number(options.minStartGapMs || existing.minStartGapMs || 0));
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
      lane: options.lane || null,
      laneConcurrency: Math.max(1, Number(options.laneConcurrency || 1)),
      minStartGapMs: Math.max(0, Number(options.minStartGapMs || 0)),
      status: 'pending',
      seq: ++seq,
      resolve,
      promise,
    };
    jobsByKey.set(key, job);
    pending.push(job);
    sortPending();
    logger?.('enqueue', { index, key, email: job.email, priority, reason: job.reason, lane: job.lane, pending: pending.length, running });
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
    lanes: Object.fromEntries([...laneState.entries()].map(([lane, state]) => [lane, { ...state }])),
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
