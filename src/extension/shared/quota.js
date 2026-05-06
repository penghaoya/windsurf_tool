/**
 * Quota helpers shared between extension entrypoint and scheduler.
 * Single source of truth for transforming cachedPlanInfo into usage records,
 * preventing drift between previously-duplicated copies.
 */

// Real-time channels — produce authoritative quota numbers (server round-trip).
export const FRESH_USAGE_SOURCES = new Set(['api', 'api_json', 'apikey_status']);
// Local cache — windsurf IDE's own cachedPlanInfo, may lag real-time by minutes.
export const CACHED_USAGE_SOURCES = new Set(['local_cache', 'local']);

// Window in which a fresh real-time write is considered authoritative
// and must NOT be overwritten by a (potentially stale) local-cache read.
// Must exceed ACTIVE_NETWORK_REFRESH_TTL (60s) — otherwise stale proto blob
// in windsurfAuthStatus can overwrite fresh API data between network cycles,
// causing quota oscillation (e.g. 26%↔74% where the proto contains a stale snapshot).
export const FRESH_USAGE_GUARD_MS = 90 * 1000;

/** Build a usage record from windsurf's cachedPlanInfo proto/json snapshot. */
export function usageFromCachedQuota(cached, existingUsage = {}) {
  const daily = cached.daily !== null && cached.daily !== undefined
    ? { used: Math.max(0, 100 - cached.daily), total: 100, remaining: cached.daily }
    : existingUsage.daily || null;
  const weekly = cached.weekly !== null && cached.weekly !== undefined
    ? { used: Math.max(0, 100 - cached.weekly), total: 100, remaining: cached.weekly }
    : existingUsage.weekly || null;

  return {
    mode: cached.billing === 'credits' ? 'credits' : 'quota',
    billingStrategy: cached.billing || existingUsage.billingStrategy || 'quota',
    daily,
    weekly,
    plan: cached.plan || existingUsage.plan || null,
    resetTime: cached.resetTime || existingUsage.resetTime || null,
    weeklyReset: cached.weeklyReset || existingUsage.weeklyReset || null,
    extraBalance: cached.extraBalance ?? existingUsage.extraBalance ?? null,
    planStart: cached.planStart || existingUsage.planStart || null,
    planEnd: cached.planEnd || existingUsage.planEnd || null,
    source: 'local_cache',
    userEmail: cached.email || null,
  };
}

/** Has cached snapshot diverged from existing stored usage in any meaningful field? */
export function cachedQuotaChanged(cached, existingUsage = {}) {
  const daily = existingUsage.daily?.remaining ?? null;
  const weekly = existingUsage.weekly?.remaining ?? null;
  return (
    daily !== (cached.daily ?? null) ||
    weekly !== (cached.weekly ?? null) ||
    (existingUsage.plan || null) !== (cached.plan || null) ||
    (existingUsage.resetTime || null) !== (cached.resetTime || null) ||
    (existingUsage.weeklyReset || null) !== (cached.weeklyReset || null) ||
    (existingUsage.planEnd || null) !== (cached.planEnd || null)
  );
}

/**
 * Decide if `incoming` should overwrite `existing`.
 * Prevents stale cachedPlanInfo from clobbering a fresh real-time write
 * that arrived seconds earlier from GetPlanStatus / GetUserStatus.
 */
export function shouldAcceptUsageWrite(existing, incoming, now = Date.now()) {
  if (!existing) return true;
  if (!incoming) return false;
  const incomingIsCache = CACHED_USAGE_SOURCES.has(incoming.source);
  const existingIsFresh = FRESH_USAGE_SOURCES.has(existing.source);
  if (!incomingIsCache || !existingIsFresh) return true;
  const age = now - (existing.fetchedAt || existing.lastChecked || 0);
  // Reject only when the fresh write is recent enough to still be authoritative.
  return age >= FRESH_USAGE_GUARD_MS;
}
