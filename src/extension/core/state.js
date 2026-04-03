/**
 * 号池引擎共享状态
 * 所有模块通过 S 对象读写共享可变状态，通过 deps 调用跨模块函数
 */
import vscode from 'vscode';
import { MAX_EVENT_LOG, DEFAULT_PREEMPTIVE_THRESHOLD, BOOST_DURATION, getModelFamily, getPlanTier, isTierFree, PLAN_TIERS } from '../shared/config.js';

// ═══ 共享可变状态单例 ═══
export const S = {
  // 核心服务
  statusBar: null,
  am: null,
  auth: null,
  panelProvider: null,
  panel: null,
  outputChannel: null,

  // 号池状态
  activeIndex: -1,
  switching: false,
  poolTimer: null,
  lastQuota: null,
  lastCheckTs: 0,
  boostUntil: 0,
  switchCount: 0,
  discoveredAuthCmd: null,
  eventLog: [],

  // Gate 4
  tierRateLimitCount: 0,

  // 多窗口
  windowId: null,
  windowTimer: null,
  cachedWindowState: null,
  cacheTs: 0,

  // 并发Tab
  cascadeTabCount: 0,
  lastTabCheck: 0,
  burstMode: false,

  // 全池监控
  allQuotaSnapshot: new Map(),
  lastFullScanTs: 0,
  lastReactiveSwitchTs: 0,
  lastUfefSwitchTs: 0,

  // 热重置
  lastRotatedIds: null,
  hotResetCount: 0,
  hotResetVerified: 0,

  // 模型状态
  currentModelUid: null,
  modelRateLimitCount: 0,
  lastModelSwitch: 0,
  downgradeLockUntil: 0,
  lastTrialPoolCooldownFailTs: 0,
  autoDowngradedFromOpus: false,
  preDowngradeModelUid: null,
  opusGuardSwitchCount: 0,

  // L5容量探测
  cachedApiKey: null,
  cachedApiKeyTs: 0,
  capacityProbeCount: 0,
  capacitySwitchCount: 0,

  // UI防抖
  refreshPanelTimer: null,
};

// ═══ 调度运行时状态 ═══
export const schedulerState = {
  accounts: new Map(),
  accountQuarantines: new Map(),
  poolCooldowns: new Map(),
};

// ═══ 跨模块依赖注册 (打破循环依赖) ═══
export const deps = {
  loginToAccount: null,
  refreshOne: null,
  refreshAll: null,
  doPoolRotate: null,
  updatePoolBar: null,
  syncSchedulerToShared: null,
  performSwitch: null,
};

// ═══ 结构化日志系统 ═══
export function _log(level, tag, msg, data) {
  const ts = new Date().toLocaleTimeString();
  const prefix = `[${ts}] [${level}] [${tag}]`;
  const full =
    data !== undefined
      ? `${prefix} ${msg} ${JSON.stringify(data)}`
      : `${prefix} ${msg}`;
  if (S.outputChannel) S.outputChannel.appendLine(full);
  if (level === "ERROR") console.error(`WAM: ${full}`);
  else console.log(`WAM: ${full}`);
  S.eventLog.push({
    ts: Date.now(),
    level,
    tag,
    msg: data !== undefined ? `${msg} ${JSON.stringify(data)}` : msg,
  });
  if (S.eventLog.length > MAX_EVENT_LOG)
    S.eventLog = S.eventLog.slice(-MAX_EVENT_LOG);
}
export function _logInfo(tag, msg, data) { _log("INFO", tag, msg, data); }
export function _logWarn(tag, msg, data) { _log("WARN", tag, msg, data); }
export function _logError(tag, msg, data) { _log("ERROR", tag, msg, data); }

// ═══ Boost 模式 ═══
export function _isBoost() { return Date.now() < S.boostUntil; }
export function _activateBoost() { S.boostUntil = Date.now() + BOOST_DURATION; }

// ═══ Panel 防抖刷新 ═══
export function _refreshPanel() {
  if (!S.panelProvider) return;
  if (S.refreshPanelTimer) clearTimeout(S.refreshPanelTimer);
  S.refreshPanelTimer = setTimeout(() => {
    S.refreshPanelTimer = null;
    try { S.panelProvider.refresh(); } catch {}
  }, 50);
}

// ═══ 账号运行时状态 ═══
export function _createAccountRuntime() {
  return {
    hourlyMsgLog: [],
    msgRateLog: [],
    quotaHistory: [],
    velocityLog: [],
    opusMsgLog: [],
    capacity: {
      lastCheck: 0,
      lastResult: null,
      failCount: 0,
      lastSuccessfulProbe: 0,
      realMaxMessages: -1,
      consecutiveNoData: 0,
    },
  };
}

export function _normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

export function _getAccountEmail(index) {
  if (index === undefined) index = S.activeIndex;
  if (!S.am || index < 0) return '';
  return _normalizeEmail(S.am.get(index)?.email);
}

export function _getAccountRuntimeByEmail(email, create = true) {
  const key = _normalizeEmail(email);
  if (!key) return null;
  let rt = schedulerState.accounts.get(key);
  if (!rt && create) {
    rt = _createAccountRuntime();
    schedulerState.accounts.set(key, rt);
  }
  return rt || null;
}

export function _getAccountRuntime(index, create = true) {
  if (index === undefined) index = S.activeIndex;
  const email = _getAccountEmail(index);
  return email ? _getAccountRuntimeByEmail(email, create) : null;
}

export function _getCapacityState(index, create = true) {
  if (index === undefined) index = S.activeIndex;
  const rt = _getAccountRuntime(index, create);
  return rt ? rt.capacity : null;
}

export function _clearExpiredEntries(store) {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.until && entry.until <= now) store.delete(key);
  }
}

// ═══ 隔离/冷却状态管理 ═══
export function _getTrialPoolCooldownKey(modelUid) {
  return `trial_pool_${getModelFamily(modelUid)}`;
}

export function _getAccountQuarantineByEmail(email) {
  const key = _normalizeEmail(email);
  if (!key) return null;
  _clearExpiredEntries(schedulerState.accountQuarantines);
  return schedulerState.accountQuarantines.get(key) || null;
}

export function _isAccountQuarantined(indexOrEmail) {
  const email = typeof indexOrEmail === 'string' ? indexOrEmail : _getAccountEmail(indexOrEmail);
  return !!_getAccountQuarantineByEmail(email);
}

export function _setAccountQuarantine(indexOrEmail, seconds, reason, meta = {}) {
  const email = typeof indexOrEmail === 'number'
    ? _getAccountEmail(indexOrEmail)
    : _normalizeEmail(indexOrEmail);
  if (!email || !seconds) return;
  const until = Date.now() + seconds * 1000;
  const current = _getAccountQuarantineByEmail(email);
  if (current && current.until >= until) return;
  schedulerState.accountQuarantines.set(email, { until, reason, ...meta });
  _logInfo('隔离', `账号隔离: ${email.split('@')[0]} ${seconds}s (${reason})`);
  deps.syncSchedulerToShared?.();
}

export function _clearAccountQuarantine(indexOrEmail) {
  const email = typeof indexOrEmail === 'number'
    ? _getAccountEmail(indexOrEmail)
    : _normalizeEmail(indexOrEmail);
  if (!email) return;
  schedulerState.accountQuarantines.delete(email);
  deps.syncSchedulerToShared?.();
}

export function _getTrialPoolCooldown(modelUid) {
  const key = _getTrialPoolCooldownKey(modelUid);
  _clearExpiredEntries(schedulerState.poolCooldowns);
  return schedulerState.poolCooldowns.get(key) || null;
}

export function _armTrialPoolCooldown(modelUid, seconds, reason, meta = {}) {
  if (!seconds) return;
  const key = _getTrialPoolCooldownKey(modelUid);
  const until = Date.now() + seconds * 1000;
  const current = _getTrialPoolCooldown(modelUid);
  if (current && current.until >= until) return;
  schedulerState.poolCooldowns.set(key, { until, reason, ...meta });
  _logWarn('池冷却', `Trial池冷却: ${key} ${seconds}s (${reason})`);
  deps.syncSchedulerToShared?.();
}

/** 获取账号的计划层级 (PLAN_TIERS 值) */
export function _getPlanTier(index) {
  if (!S.am || index < 0) return PLAN_TIERS.FREE;
  const account = S.am.get(index);
  if (!account) return PLAN_TIERS.FREE;
  return getPlanTier(account.usage?.plan);
}

/** 向后兼容: 账号是否 Free/Trial 类 */
export function _isTrialLikeAccount(index) {
  return isTierFree(_getPlanTier(index));
}

export function _resetAccountRuntimeByEmail(email) {
  const key = _normalizeEmail(email);
  if (key && schedulerState.accounts.has(key)) {
    schedulerState.accounts.set(key, _createAccountRuntime());
  }
}

export function _dropAccountRuntimeByEmail(email) {
  const key = _normalizeEmail(email);
  if (key) schedulerState.accounts.delete(key);
}

export function _getPreemptiveThreshold() {
  const raw = vscode.workspace.getConfiguration('wam').get('preemptiveThreshold', DEFAULT_PREEMPTIVE_THRESHOLD);
  const num = Number(raw);
  if (!Number.isFinite(num)) return DEFAULT_PREEMPTIVE_THRESHOLD;
  return Math.max(0, Math.min(100, Math.round(num)));
}

export function _getActiveSelectionMode() {
  return S.am && S.activeIndex >= 0 && S.am.getSelectionMode ? S.am.getSelectionMode(S.activeIndex) : null;
}
