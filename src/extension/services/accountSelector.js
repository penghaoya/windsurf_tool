import { MIN_DAILY_QUOTA_FOR_SWITCH, getPlanTier, PLAN_TIERS, isTierFree } from '../shared/config.js';

// v16.0: Opus请求时,非Trial账号优先 (Pro有500 credits/月 vs Trial 100/2周)
function _isOpusModelUid(uid) {
  return uid && ['opus-4-6-thinking-1m', 'opus-4-6-thinking', 'opus-4-6-1m', 'opus-4-6', 'opus-4-6-thinking-fast', 'opus-4-6-fast']
    .some(v => uid.includes(v));
}

function _sortQuotaCandidates(a, b) {
  const aUrg = a.urgency < 0 ? 2 : a.urgency;
  const bUrg = b.urgency < 0 ? 2 : b.urgency;
  if (aUrg !== bUrg) return aUrg - bUrg;

  const maxRem = Math.max(a.remaining, b.remaining);
  const remSimilar =
    maxRem > 0 && Math.abs(a.remaining - b.remaining) <= maxRem * 0.15;
  if (!remSimilar && a.remaining !== b.remaining) {
    return b.remaining - a.remaining;
  }

  const aWeekly = a.weeklyRemaining ?? a.remaining;
  const bWeekly = b.weeklyRemaining ?? b.remaining;
  if (aWeekly !== bWeekly) {
    const weeklyMax = Math.max(aWeekly, bWeekly);
    const weeklySimilar =
      weeklyMax > 0 && Math.abs(aWeekly - bWeekly) <= weeklyMax * 0.15;
    if (!weeklySimilar) return bWeekly - aWeekly;
  }

  if (a.weeklyResetProximity !== b.weeklyResetProximity) {
    const diff = a.weeklyResetProximity - b.weeklyResetProximity;
    if (Math.abs(diff) > 3600000) return diff < 0 ? -1 : 1;
  }

  const aDays = a.planDays ?? 999;
  const bDays = b.planDays ?? 999;
  if (aDays !== bDays) return aDays - bDays;
  if (a.lastUsed !== b.lastUsed) return a.lastUsed - b.lastUsed;
  return a.resetProximity - b.resetProximity;
}

function _sortCreditsCandidates(a, b) {
  const aUrg = a.urgency < 0 ? 2 : a.urgency;
  const bUrg = b.urgency < 0 ? 2 : b.urgency;
  if (aUrg !== bUrg) return aUrg - bUrg;
  if (
    a.remaining !== null &&
    b.remaining !== null &&
    a.remaining !== b.remaining
  ) {
    return b.remaining - a.remaining;
  }
  const aDays = a.planDays ?? 999;
  const bDays = b.planDays ?? 999;
  if (aDays !== bDays) return aDays - bDays;
  return a.lastUsed - b.lastUsed;
}

function _sortUnknownCandidates(a, b) {
  const aDays = a.planDays ?? 999;
  const bDays = b.planDays ?? 999;
  if (aDays !== bDays) return aDays - bDays;
  return a.lastUsed - b.lastUsed;
}

function _sortCandidatesByMode(candidates, mode) {
  const arr = [...candidates];
  if (mode === 'quota') return arr.sort(_sortQuotaCandidates);
  if (mode === 'credits') return arr.sort(_sortCreditsCandidates);
  return arr.sort(_sortUnknownCandidates);
}

export function selectOptimal(
  accountManager,
  excludeIndex = -1,
  threshold = 5,
  excludeEmails = [],
  options = {},
) {
  const excluded = new Set();
  if (excludeIndex >= 0) excluded.add(excludeIndex);

  const excludedEmailsSet = new Set(
    (excludeEmails || [])
      .map((email) => String(email || '').toLowerCase())
      .filter(Boolean),
  );
  const preferredMode = options.preferredMode || null;
  const modelUid = options.modelUid || null;

  const candidates = [];
  for (let i = 0; i < accountManager.count(); i++) {
    if (excluded.has(i)) continue;
    const account = accountManager.get(i);
    if (!account) continue;
    if (excludedEmailsSet.has(String(account.email || '').toLowerCase())) {
      continue;
    }
    if (accountManager.isRateLimited(i)) continue;
    if (accountManager.isExpired(i)) continue;
    if (modelUid && accountManager.isModelRateLimited(i, modelUid)) continue;
    const rem = accountManager.effectiveRemaining(i);
    if (rem !== null && rem !== undefined && rem > threshold) {
      const dailyRem = accountManager.getDailyRemaining(i);
      if (dailyRem !== null && dailyRem <= MIN_DAILY_QUOTA_FOR_SWITCH) continue;
      const planDays = accountManager.getPlanDaysRemaining(i);
      const urgency = accountManager.getExpiryUrgency(i);
      const resetTs = accountManager.effectiveResetTime(i);
      const resetProximity = resetTs
        ? Math.max(0, resetTs - Date.now())
        : Infinity;
      const weeklyResetMs = account.usage?.weeklyReset || 0;
      const weeklyResetProximity =
        weeklyResetMs > Date.now() ? weeklyResetMs - Date.now() : Infinity;
      const tier = getPlanTier(account.usage?.plan);
      candidates.push({
        index: i,
        email: account.email,
        remaining: rem,
        dailyRemaining: account.usage?.daily?.remaining ?? null,
        weeklyRemaining: account.usage?.weekly?.remaining ?? null,
        planDays,
        urgency,
        resetProximity,
        weeklyResetProximity,
        lastUsed: accountManager.getLastUsedTs(i),
        mode: accountManager.getSelectionMode(i),
        tier,
        isTrial: isTierFree(tier),
      });
    }
  }

  const byMode = {
    quota: _sortCandidatesByMode(
      candidates.filter((candidate) => candidate.mode === 'quota'),
      'quota',
    ),
    credits: _sortCandidatesByMode(
      candidates.filter((candidate) => candidate.mode === 'credits'),
      'credits',
    ),
    unknown: _sortCandidatesByMode(
      candidates.filter((candidate) => candidate.mode === 'unknown'),
      'unknown',
    ),
  };

  let modeOrder = ['quota', 'credits', 'unknown'];
  if (preferredMode === 'credits') modeOrder = ['credits', 'quota', 'unknown'];
  else if (preferredMode === 'quota') {
    modeOrder = ['quota', 'credits', 'unknown'];
  }

  const ordered = [];
  for (const mode of modeOrder) {
    ordered.push(...byMode[mode]);
  }

  // v17.0: Opus模型路由 — Opus请求时 Max前置 > Pro/Teams > Free后置 (额度感知路由)
  if (modelUid && _isOpusModelUid(modelUid) && ordered.length > 1) {
    const tierRank = (c) => {
      if (c.tier === PLAN_TIERS.MAX) return 0;
      if (c.tier === PLAN_TIERS.PRO || c.tier === PLAN_TIERS.TEAMS || c.tier === PLAN_TIERS.ENTERPRISE) return 1;
      return 2; // Free/Trial
    };
    const hasDiff = ordered.some(c => tierRank(c) !== tierRank(ordered[0]));
    if (hasDiff) {
      ordered.sort((a, b) => tierRank(a) - tierRank(b));
    }
  }
  if (ordered.length > 0) return ordered;

  const unknownCandidates = [];
  for (let i = 0; i < accountManager.count(); i++) {
    if (excluded.has(i)) continue;
    const account = accountManager.get(i);
    if (!account) continue;
    if (excludedEmailsSet.has(String(account.email || '').toLowerCase())) {
      continue;
    }
    if (accountManager.isRateLimited(i)) continue;
    if (accountManager.isExpired(i)) continue;
    if (modelUid && accountManager.isModelRateLimited(i, modelUid)) continue;
    const rem = accountManager.effectiveRemaining(i);
    if (rem === null || rem === undefined) {
      unknownCandidates.push({
        index: i,
        email: account.email,
        remaining: null,
        planDays: accountManager.getPlanDaysRemaining(i),
        urgency: accountManager.getExpiryUrgency(i),
        lastUsed: accountManager.getLastUsedTs(i),
        mode: accountManager.getSelectionMode(i),
      });
    }
  }
  return _sortCandidatesByMode(unknownCandidates, 'unknown');
}

export function findBestForModel(
  accountManager,
  modelUid,
  excludeIndex = -1,
  threshold = 0,
  excludeEmails = [],
  options = {},
) {
  return selectOptimal(accountManager, excludeIndex, threshold, excludeEmails, {
    ...options,
    modelUid,
    preferredMode:
      options.preferredMode ??
      (excludeIndex >= 0 ? accountManager.getSelectionMode(excludeIndex) : null),
  });
}
