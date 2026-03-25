/**
 * 号池调度器
 * 引擎心跳、预防性评估、候选排序、无感切换、速度/斜率预测
 */
import vscode from 'vscode';
import {
  POLL_NORMAL, POLL_BOOST, POLL_BURST, SLOPE_WINDOW, SLOPE_HORIZON,
  CONCURRENT_TAB_SAFE, MSG_RATE_WINDOW, MSG_RATE_LIMIT, BURST_DETECT_THRESHOLD,
  TAB_CHECK_INTERVAL, FULL_SCAN_INTERVAL_NORMAL, FULL_SCAN_INTERVAL_BOOST,
  FULL_SCAN_INTERVAL_BURST, REACTIVE_SWITCH_CD, UFEF_COOLDOWN,
  VELOCITY_WINDOW, VELOCITY_THRESHOLD, OPUS_VARIANTS, SONNET_FALLBACK,
  TIER_MSG_CAP_ESTIMATE, TRIAL_POOL_COOLDOWN_RETRY_CD,
  isOpusModel, isThinkingModel, isThinking1MModel, getModelBudget,
  getReactiveDropMin,
} from '../shared/config.js';
import {
  S, schedulerState, deps, _getAccountRuntime, _getCapacityState,
  _normalizeEmail, _getAccountEmail, _dropAccountRuntimeByEmail,
  _resetAccountRuntimeByEmail, _isAccountQuarantined, _getTrialPoolCooldown,
  _isTrialLikeAccount, _getPreemptiveThreshold, _getActiveSelectionMode,
  _logInfo, _logWarn, _logError, _isBoost, _activateBoost, _refreshPanel,
} from './state.js';
import {
  _readCurrentModelUid, _trackOpusMsg, _getOpusMsgCount, _getPreemptAt,
  _isNearOpusBudget, _getOpusDynamicCooldown, _resetOpusMsgLog,
  _downgradeFromTrialPressure,
} from './model.js';
import {
  _getOtherWindowAccountEmails, _getActiveWindowCount,
  _heartbeatWindow, _mergeSchedulerFromShared,
} from './window.js';
import {
  _classifyRateLimit, _trackHourlyMsg, _getHourlyMsgCount, _isNearTierCap,
  _invalidateApiKeyCache, _pushRateLimitEvent, _startQuotaWatcher,
} from './defense.js';

// ═══ 并发Tab感知 ═══

/** 探测当前窗口活跃Cascade对话数 */
export function _detectCascadeTabs() {
  const now = Date.now();
  if (now - S.lastTabCheck < TAB_CHECK_INTERVAL) return S.cascadeTabCount;
  S.lastTabCheck = now;

  let count = 0;
  try {
    if (vscode.window.tabGroups) {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const label = (tab.label || "").toLowerCase();
          const inputUri = tab.input && tab.input.uri ? tab.input.uri.toString() : "";
          if (
            label.includes("cascade") || label.includes("chat") ||
            inputUri.includes("cascade") || inputUri.includes("chat") ||
            (tab.input && tab.input.viewType && /cascade|chat|copilot/i.test(tab.input.viewType))
          ) {
            count++;
          }
        }
      }
    }
  } catch {}

  if (count === 0) {
    try {
      const visibleEditors = vscode.window.visibleTextEditors.length;
      if (visibleEditors > 1) count = Math.max(1, Math.floor(visibleEditors / 2));
    } catch {}
  }

  if (count === 0) count = 1;

  const prev = S.cascadeTabCount;
  S.cascadeTabCount = count;
  if (count !== prev) {
    _logInfo("对话感知", `并发对话数: ${prev} → ${count}${count > CONCURRENT_TAB_SAFE ? " ⚠️ 超过安全阈值!" : ""}`);
    if (count > CONCURRENT_TAB_SAFE && !S.burstMode) {
      S.burstMode = true;
      _activateBoost();
      _logWarn("对话感知", `🔥 BURST防护开启 — 检测到${count}个并发对话, 加速轮询+预防性轮转`);
    } else if (count <= CONCURRENT_TAB_SAFE && S.burstMode) {
      S.burstMode = false;
      _logInfo("对话感知", "BURST防护关闭 — 并发数回到安全水平");
    }
  }
  return count;
}

// ═══ 消息速率追踪 ═══

export function _trackMessageRate() {
  const runtime = _getAccountRuntime();
  if (!runtime) return;
  runtime.msgRateLog.push({ ts: Date.now() });
  const cutoff = Date.now() - MSG_RATE_WINDOW;
  runtime.msgRateLog = runtime.msgRateLog.filter((m) => m.ts > cutoff);
}

function _getCurrentMsgRate() {
  const runtime = _getAccountRuntime(S.activeIndex, false);
  if (!runtime) return 0;
  const cutoff = Date.now() - MSG_RATE_WINDOW;
  return runtime.msgRateLog.filter((m) => m.ts > cutoff).length;
}

function _isNearMsgRateLimit() {
  const rate = _getCurrentMsgRate();
  const tabAdjustedLimit = Math.max(3, MSG_RATE_LIMIT / Math.max(1, S.cascadeTabCount));
  return rate >= tabAdjustedLimit * BURST_DETECT_THRESHOLD;
}

// ═══ 速度/斜率预测 ═══

export function _trackVelocity(remaining) {
  if (remaining === null || remaining === undefined) return;
  const runtime = _getAccountRuntime();
  if (!runtime) return;
  runtime.velocityLog.push({ ts: Date.now(), remaining });
  const cutoff = Date.now() - VELOCITY_WINDOW;
  runtime.velocityLog = runtime.velocityLog.filter((s) => s.ts >= cutoff);
}

export function _getVelocity() {
  const runtime = _getAccountRuntime(S.activeIndex, false);
  if (!runtime || runtime.velocityLog.length < 2) return 0;
  const first = runtime.velocityLog[0];
  const last = runtime.velocityLog[runtime.velocityLog.length - 1];
  const dtMin = (last.ts - first.ts) / 60000;
  if (dtMin <= 0) return 0;
  return (first.remaining - last.remaining) / dtMin;
}

export function _isHighVelocity() {
  const runtime = _getAccountRuntime(S.activeIndex, false);
  if (!runtime || runtime.velocityLog.length < 2) return false;
  const first = runtime.velocityLog[0];
  const last = runtime.velocityLog[runtime.velocityLog.length - 1];
  return (first.remaining - last.remaining) >= VELOCITY_THRESHOLD;
}

export function _slopePredict() {
  const runtime = _getAccountRuntime(S.activeIndex, false);
  if (!runtime || runtime.quotaHistory.length < 2) return null;
  const recent = runtime.quotaHistory.slice(-SLOPE_WINDOW);
  if (recent.length < 2) return null;
  const first = recent[0], last = recent[recent.length - 1];
  const dt = last.ts - first.ts;
  if (dt <= 0) return null;
  const rate = (last.remaining - first.remaining) / dt;
  if (rate >= 0) return null;
  return Math.round(last.remaining + rate * SLOPE_HORIZON);
}

function _getAdaptivePollMs() {
  if (S.burstMode) return POLL_BURST;
  if (_isBoost()) return POLL_BOOST;
  return POLL_NORMAL;
}

// ═══ 运行时候选过滤 ═══

export function _filterRuntimeCandidates(candidates, { modelUid = null, opusBudgetFilter = false } = {}) {
  const trialPoolCooldown = _getTrialPoolCooldown(modelUid);
  return candidates.filter((candidate) => {
    if (_isAccountQuarantined(candidate.email || candidate.index)) return false;
    if (trialPoolCooldown && _isTrialLikeAccount(candidate.index)) return false;
    if (opusBudgetFilter && _isTrialLikeAccount(candidate.index)) {
      const opusCount = _getOpusMsgCount(candidate.index);
      const preemptAt = _getPreemptAt(modelUid || _readCurrentModelUid());
      if (opusCount >= preemptAt) return false;
    }
    return true;
  });
}

/** 统计号池中Opus预算仍有余量的Trial账号数 */
export function _countOpusAvailableTrials(excludeIndex = -1) {
  const accounts = S.am.getAll();
  const modelUid = S.currentModelUid || _readCurrentModelUid();
  if (_getTrialPoolCooldown(modelUid)) return 0;
  const preemptAt = _getPreemptAt(modelUid);
  let available = 0;
  for (let i = 0; i < accounts.length; i++) {
    if (i === excludeIndex) continue;
    if (!_isTrialLikeAccount(i)) continue;
    if (S.am.isRateLimited(i) || S.am.isExpired(i)) continue;
    if (_isAccountQuarantined(i)) continue;
    const opusCount = _getOpusMsgCount(i);
    if (opusCount < preemptAt) available++;
  }
  return available;
}

// ═══ 候选选择 ═══

export function _getOrderedCandidates({
  excludeIndex = S.activeIndex,
  threshold = _getPreemptiveThreshold(),
  targetPolicy = 'same_strategy',
  modelUid = null,
  excludeClaimed = true,
  opusBudgetFilter = false,
} = {}) {
  const preferredMode = targetPolicy === 'same_strategy' || targetPolicy === 'same_model'
    ? _getActiveSelectionMode()
    : null;
  const excludedEmails = excludeClaimed ? _getOtherWindowAccountEmails() : [];
  const options = { preferredMode, modelUid };
  const primary = modelUid
    ? S.am.findBestForModel(modelUid, excludeIndex, threshold, excludedEmails, options)
    : S.am.selectOptimal(excludeIndex, threshold, excludedEmails, options);
  const filteredPrimary = _filterRuntimeCandidates(primary, { modelUid, opusBudgetFilter });
  if (filteredPrimary.length > 0 || !excludeClaimed) return filteredPrimary;
  const fallback = modelUid
    ? S.am.findBestForModel(modelUid, excludeIndex, threshold, [], options)
    : S.am.selectOptimal(excludeIndex, threshold, [], options);
  return _filterRuntimeCandidates(fallback, { modelUid, opusBudgetFilter });
}

// ═══ 预热验证 ═══

export async function _validateSwitchCandidate(targetIndex, threshold) {
  if (_isAccountQuarantined(targetIndex)) {
    return { ok: false, remaining: null, reason: 'account_quarantined' };
  }
  const trialPoolCooldown = _getTrialPoolCooldown(_readCurrentModelUid());
  if (trialPoolCooldown && _isTrialLikeAccount(targetIndex)) {
    return { ok: false, remaining: null, reason: 'trial_pool_cooldown' };
  }
  try {
    await Promise.race([
      deps.refreshOne(targetIndex),
      new Promise((_, reject) => setTimeout(() => reject(new Error('preheat_timeout')), 5000)),
    ]);
    if (S.am.isRateLimited(targetIndex)) {
      return { ok: false, remaining: null, reason: 'rate_limited' };
    }
    const remaining = S.am.effectiveRemaining(targetIndex);
    if (remaining !== null && remaining <= threshold) {
      return { ok: false, remaining, reason: 'insufficient_quota' };
    }
    return { ok: true, remaining };
  } catch (e) {
    return { ok: false, remaining: null, reason: e.message };
  }
}

// ═══ 统一切换入口 ═══

export async function _performSwitch(context, {
  excludeIndex = S.activeIndex,
  threshold = _getPreemptiveThreshold(),
  targetPolicy = 'same_strategy',
  panic = false,
  refreshPool = false,
  modelUid = null,
  candidates = null,
  allowThresholdFallback = false,
  opusBudgetFilter = false,
} = {}) {
  if (refreshPool) await deps.refreshAll();
  let ordered = Array.isArray(candidates) && candidates.length > 0
    ? _filterRuntimeCandidates(candidates, { modelUid, opusBudgetFilter })
    : _getOrderedCandidates({ excludeIndex, threshold, targetPolicy, modelUid, excludeClaimed: true, opusBudgetFilter });
  if (ordered.length === 0 && allowThresholdFallback && threshold > 0) {
    ordered = _getOrderedCandidates({ excludeIndex, threshold: 0, targetPolicy, modelUid, excludeClaimed: false, opusBudgetFilter });
  }
  if (ordered.length === 0 && !modelUid && _getTrialPoolCooldown(_readCurrentModelUid())) {
    const downgraded = await _downgradeFromTrialPressure('Trial候选池冷却中');
    if (downgraded) {
      ordered = _getOrderedCandidates({ excludeIndex, threshold, targetPolicy, modelUid: SONNET_FALLBACK, excludeClaimed: true });
      if (ordered.length === 0 && allowThresholdFallback && threshold > 0) {
        ordered = _getOrderedCandidates({ excludeIndex, threshold: 0, targetPolicy, modelUid: SONNET_FALLBACK, excludeClaimed: false });
      }
    }
  }
  for (const candidate of ordered) {
    const preheat = await _validateSwitchCandidate(candidate.index, threshold);
    if (!preheat.ok) {
      _logWarn('切换', `预热跳过 #${candidate.index + 1}: ${preheat.reason}${preheat.remaining !== null ? ` (${preheat.remaining}%≤${threshold}%)` : ''}`);
      continue;
    }
    const switched = await _seamlessSwitch(context, candidate.index);
    if (switched) return { ok: true, index: candidate.index, candidate };
  }
  if (!panic) _logWarn('切换', '候选账号全部预热失败或不可切换');
  return { ok: false, index: -1 };
}

// ═══ 预防性评估 ═══

export function evaluateActiveAccount({ accounts, threshold, curQuota }) {
  const decision = { action: 'none', reason: 'ok', cooldown: null, targetPolicy: 'same_strategy' };
  const capacity = _getCapacityState(S.activeIndex, false);
  const lastCapacityResult = capacity?.lastResult || null;
  const lastCapacityCheck = capacity?.lastCheck || 0;
  const realMaxMessages = capacity?.realMaxMessages ?? -1;
  const l5Valid = lastCapacityResult &&
    lastCapacityResult.messagesRemaining >= 0 &&
    (Date.now() - lastCapacityCheck < 120000);

  if (l5Valid && !lastCapacityResult.hasCapacity) {
    decision.action = 'switch_account';
    decision.reason = `L5_no_capacity(remaining=${lastCapacityResult.messagesRemaining}/${lastCapacityResult.maxMessages},resets=${lastCapacityResult.resetsInSeconds}s)`;
    return decision;
  }

  if (l5Valid && lastCapacityResult.hasCapacity) {
    const capMax = lastCapacityResult.maxMessages > 0 ? lastCapacityResult.maxMessages : TIER_MSG_CAP_ESTIMATE;
    const capRem = lastCapacityResult.messagesRemaining;
    if (capRem <= 2 || (capMax > 0 && capRem <= capMax * 0.2)) {
      decision.action = 'switch_account';
      decision.reason = `L5_capacity_low(remaining=${capRem}/${capMax},resets=${lastCapacityResult.resetsInSeconds}s)`;
      return decision;
    }
  }

  const baseDecision = S.am.shouldSwitch(S.activeIndex, threshold);
  if (baseDecision.switch) {
    decision.action = 'switch_account';
    decision.reason = baseDecision.reason;
    return decision;
  }

  if (S.am.isRateLimited(S.activeIndex)) {
    decision.action = 'switch_account';
    decision.reason = 'rate_limited';
    return decision;
  }

  if (curQuota !== null && curQuota > threshold) {
    const currentModel = _readCurrentModelUid();
    if (isOpusModel(currentModel) && S.downgradeLockUntil <= Date.now() && _isNearOpusBudget(S.activeIndex)) {
      const opusCount = _getOpusMsgCount(S.activeIndex);
      const tierBudget = getModelBudget(currentModel);
      decision.action = 'switch_account';
      decision.reason = `opus_budget_guard(model=${currentModel},msgs=${opusCount}/${tierBudget},tier=${isThinking1MModel(currentModel) ? 'T1M' : isThinkingModel(currentModel) ? 'T' : 'R'})`;
      return decision;
    }
  }

  if (curQuota !== null && curQuota > threshold && Date.now() - S.lastUfefSwitchTs > UFEF_COOLDOWN) {
    const activeUrg = S.am.getExpiryUrgency(S.activeIndex);
    if (activeUrg >= 2 || activeUrg < 0) {
      for (let i = 0; i < accounts.length; i++) {
        if (i === S.activeIndex) continue;
        if (S.am.isRateLimited(i) || S.am.isExpired(i)) continue;
        const iUrg = S.am.getExpiryUrgency(i);
        const iRem = S.am.effectiveRemaining(i);
        if (iUrg === 0 && iRem !== null && iRem > threshold) {
          decision.action = 'switch_account';
          decision.reason = `ufef_urgent(active_urg=${activeUrg},#${i + 1}_urg=${iUrg},#${i + 1}_rem=${iRem},#${i + 1}_days=${S.am.getPlanDaysRemaining(i)})`;
          decision.targetPolicy = 'quota_first';
          return decision;
        }
      }
    }
  }

  if (!l5Valid) {
    if (curQuota !== null && curQuota > threshold) {
      const predicted = _slopePredict();
      if (predicted !== null && predicted <= threshold) {
        decision.action = 'switch_account';
        decision.reason = `fallback_slope(cur=${curQuota},pred=${predicted})`;
        return decision;
      }
    }
    if (S.burstMode && _isNearMsgRateLimit()) {
      decision.action = 'switch_account';
      decision.reason = `fallback_burst(tabs=${S.cascadeTabCount},rate=${_getCurrentMsgRate()}/${MSG_RATE_LIMIT})`;
      return decision;
    }
    if (S.cascadeTabCount > CONCURRENT_TAB_SAFE && curQuota !== null) {
      const dynamicThreshold = threshold + (S.cascadeTabCount - CONCURRENT_TAB_SAFE) * 5;
      if (curQuota <= dynamicThreshold && curQuota > threshold) {
        decision.action = 'switch_account';
        decision.reason = `fallback_tab_pressure(tabs=${S.cascadeTabCount},cur=${curQuota},dyn=${dynamicThreshold})`;
        return decision;
      }
    }
    if (_isHighVelocity() && curQuota !== null && curQuota > threshold) {
      const vel = _getVelocity();
      decision.action = 'switch_account';
      decision.reason = `fallback_velocity(vel=${vel.toFixed(1)}%/min,cur=${curQuota})`;
      return decision;
    }
    if (curQuota !== null && curQuota > threshold && _isNearTierCap()) {
      const effectiveCap = realMaxMessages > 0 ? realMaxMessages : TIER_MSG_CAP_ESTIMATE;
      decision.action = 'switch_account';
      decision.reason = `fallback_tier_cap(hourly=${_getHourlyMsgCount()}/${effectiveCap})`;
      return decision;
    }
  }

  return decision;
}

// ═══ 无感切换 ═══

export async function _seamlessSwitch(context, targetIndex) {
  if (S.switching || targetIndex === S.activeIndex) return false;
  S.switching = true;
  const prevBar = S.statusBar.text;
  S.statusBar.text = "$(sync~spin) ...";
  const prevIndex = S.activeIndex;
  const prevEmail = _getAccountEmail(prevIndex);

  try {
    _invalidateApiKeyCache();
    await deps.loginToAccount(context, targetIndex);
    S.switchCount++;
    S.am.markUsed(targetIndex);
    S.lastQuota = null;
    _dropAccountRuntimeByEmail(prevEmail);
    _resetAccountRuntimeByEmail(_getAccountEmail(targetIndex));
    _resetOpusMsgLog(targetIndex);
    _heartbeatWindow();
    _logInfo("切换", `✅ 无感切换 #${prevIndex + 1}→#${targetIndex + 1} (第${S.switchCount}次, ${_getActiveWindowCount()}窗口)`);
    return true;
  } catch (e) {
    _logError("切换", `❌ 切换失败 #${targetIndex + 1}`, e.message);
    S.statusBar.text = prevBar;
    return false;
  } finally {
    S.switching = false;
    deps.updatePoolBar?.();
    _refreshPanel();
  }
}

/** Round-Robin fallback — 当_performSwitch失败时的最后兜底 */
export function _roundRobinFallback() {
  const accounts = S.am.getAll();
  if (accounts.length <= 1) return -1;
  for (let r = 1; r < accounts.length; r++) {
    const ci = (S.activeIndex + r) % accounts.length;
    if (S.am.isRateLimited(ci) || S.am.isExpired(ci) || _isAccountQuarantined(ci)) continue;
    const trialCd = _getTrialPoolCooldown(_readCurrentModelUid());
    if (trialCd && _isTrialLikeAccount(ci)) continue;
    return ci;
  }
  return (S.activeIndex + 1) % accounts.length;
}

// ═══ 号池引擎 ═══

/** 启动号池引擎 */
export function _startPoolEngine(context) {
  const scheduleNext = () => {
    const ms = _getAdaptivePollMs();
    S.poolTimer = setTimeout(async () => {
      try {
        await _poolTick(context);
      } catch (e) {
        _logError("号池", "心跳异常", e.message);
      }
      scheduleNext();
    }, ms);
  };
  setTimeout(async () => {
    await _poolTick(context);
    scheduleNext();
  }, 3000);
  _startQuotaWatcher(context);
}

/** 号池心跳 — 每次tick检查活跃账号，必要时自动轮转 */
async function _poolTick(context) {
  const accounts = S.am.getAll();
  if (accounts.length === 0) return;

  _mergeSchedulerFromShared();
  _detectCascadeTabs();

  const autoRotate = vscode.workspace.getConfiguration("wam").get("autoRotate", true);
  const threshold = _getPreemptiveThreshold();

  if (S.activeIndex < 0 || S.activeIndex >= accounts.length) {
    const switchResult = await _performSwitch(context, {
      excludeIndex: -1,
      threshold,
      targetPolicy: 'quota_first',
    });
    if (!switchResult.ok) _logWarn("号池", "无活跃账号且无可用账号");
    return;
  }

  if (S.am.isExpired(S.activeIndex)) {
    _logWarn("号池", `活跃账号 #${S.activeIndex + 1} 已过期 → 立即轮转`);
    if (autoRotate) {
      await _performSwitch(context, { threshold, targetPolicy: 'same_strategy' });
    }
    return;
  }

  const prevQuota = S.lastQuota;
  await deps.refreshOne(S.activeIndex);
  const curQuota = S.am.effectiveRemaining(S.activeIndex);
  S.lastQuota = curQuota;
  S.lastCheckTs = Date.now();

  const runtime = _getAccountRuntime();
  if (runtime && curQuota !== null && curQuota !== undefined) {
    runtime.quotaHistory.push({ ts: Date.now(), remaining: curQuota });
    if (runtime.quotaHistory.length > SLOPE_WINDOW * 2) {
      runtime.quotaHistory = runtime.quotaHistory.slice(-SLOPE_WINDOW);
    }
  }

  const quotaChanged = prevQuota !== null && prevQuota !== undefined && curQuota !== prevQuota;
  if (curQuota !== null) _trackVelocity(curQuota);
  if (quotaChanged) {
    _trackMessageRate();
    _trackHourlyMsg();
    if (curQuota < prevQuota) {
      const currentModel = _readCurrentModelUid();
      if (isOpusModel(currentModel)) {
        _trackOpusMsg(S.activeIndex);
        const opusCount = _getOpusMsgCount(S.activeIndex);
        const tierBudget = getModelBudget(currentModel);
        const tierLabel = isThinking1MModel(currentModel) ? 'Thinking-1M' : isThinkingModel(currentModel) ? 'Thinking' : 'Regular';
        _logInfo('Opus守卫', `#${S.activeIndex + 1} 已发${opusCount}/${tierBudget}条 (${tierLabel})${opusCount >= tierBudget ? ' → 达到预算上限,即将切号!' : ''}`);
      }
    }
    const vel = _getVelocity();
    const acct = S.am.get(S.activeIndex);
    const emailPrefix = acct?.email?.split('@')[0] || '?';
    const quotaDelta = curQuota - prevQuota;
    _logInfo("额度监控", `#${S.activeIndex + 1} ${emailPrefix}: ${prevQuota}% → ${curQuota}% (${quotaDelta > 0 ? '+' : ''}${quotaDelta}) | 消息速率=${_getCurrentMsgRate()}条/min 消耗速度=${vel.toFixed(1)}%/min 并发对话=${S.cascadeTabCount}`);
    _activateBoost();
    deps.updatePoolBar?.();
    _refreshPanel();
  }

  // ═══ 响应式切换 (按账号类型差异化阈值) ═══
  const quotaDrop = prevQuota !== null && curQuota !== null ? prevQuota - curQuota : 0;
  const reactiveDropMin = getReactiveDropMin(_isTrialLikeAccount(S.activeIndex), _getActiveSelectionMode());
  if (
    quotaChanged && curQuota < prevQuota && quotaDrop >= reactiveDropMin &&
    autoRotate && Date.now() - S.lastReactiveSwitchTs > REACTIVE_SWITCH_CD
  ) {
    const otherClaimed = new Set(_getOtherWindowAccountEmails());
    const stableCandidates = [];
    for (let i = 0; i < accounts.length; i++) {
      if (i === S.activeIndex) continue;
      const email = _normalizeEmail(accounts[i]?.email);
      if (!email || otherClaimed.has(email)) continue;
      if (S.am.isRateLimited(i) || S.am.isExpired(i)) continue;
      const rem = S.am.effectiveRemaining(i);
      if (rem === null || rem === undefined || rem <= threshold) continue;
      const snap = S.allQuotaSnapshot.get(i);
      if ((snap && snap.remaining === rem) || !snap) {
        stableCandidates.push({ index: i, remaining: rem });
      }
    }
    if (stableCandidates.length > 0) {
      stableCandidates.sort((a, b) => {
        const aUrg = S.am.getExpiryUrgency(a.index);
        const bUrg = S.am.getExpiryUrgency(b.index);
        const aTier = aUrg < 0 ? 2 : aUrg;
        const bTier = bUrg < 0 ? 2 : bUrg;
        if (aTier !== bTier) return aTier - bTier;
        return b.remaining - a.remaining;
      });
      S.lastReactiveSwitchTs = Date.now();
      const reactiveSwitch = await _performSwitch(context, {
        threshold,
        targetPolicy: 'quota_first',
        candidates: stableCandidates,
      });
      if (reactiveSwitch.ok) return;
    }
  }

  // ═══ 全池扫描 ═══
  const fullScanInterval = S.burstMode ? FULL_SCAN_INTERVAL_BURST : _isBoost() ? FULL_SCAN_INTERVAL_BOOST : FULL_SCAN_INTERVAL_NORMAL;
  if (Date.now() - S.lastFullScanTs > fullScanInterval) {
    S.lastFullScanTs = Date.now();
    _logInfo("全池扫描", `开始刷新全部${accounts.length}个账号额度...`);
    await deps.refreshAll();
    for (let i = 0; i < accounts.length; i++) {
      const rem = S.am.effectiveRemaining(i);
      const prev = S.allQuotaSnapshot.get(i);
      if (prev && prev.remaining !== rem) {
        const acct = S.am.get(i);
        const emailPrefix = acct?.email?.split('@')[0] || '?';
        const delta = rem !== null && prev.remaining !== null ? rem - prev.remaining : null;
        const deltaStr = delta !== null ? ` (${delta > 0 ? '+' : ''}${delta})` : '';
        _logInfo("全池扫描", `#${i + 1} ${emailPrefix}: 额度 ${prev.remaining}% → ${rem}%${deltaStr}`);
      }
      S.allQuotaSnapshot.set(i, { remaining: rem, checkedAt: Date.now() });
    }
    _refreshPanel();
  }

  // ═══ 预防性轮转 ═══
  if (autoRotate) {
    const trialPoolActive = !!_getTrialPoolCooldown(_readCurrentModelUid());
    const downgradeActive = S.downgradeLockUntil > 0 && Date.now() < S.downgradeLockUntil;
    if (trialPoolActive && downgradeActive) {
      // 静默模式
    } else if (trialPoolActive && Date.now() - S.lastTrialPoolCooldownFailTs < TRIAL_POOL_COOLDOWN_RETRY_CD) {
      // 防抖
    } else {
      const decision = evaluateActiveAccount({ accounts, threshold, curQuota });
      if (decision.action === 'switch_account') {
        if (decision.reason.startsWith('ufef_urgent')) S.lastUfefSwitchTs = Date.now();
        if (decision.reason.startsWith('opus_budget_guard')) {
          const currentModel = _readCurrentModelUid();
          const opusCount = _getOpusMsgCount(S.activeIndex);
          const tierBudget = getModelBudget(currentModel);
          S.opusGuardSwitchCount++;
          const dynamicCooldown = _getOpusDynamicCooldown(S.activeIndex);
          for (const variant of OPUS_VARIANTS) {
            S.am.markModelRateLimited(S.activeIndex, variant, dynamicCooldown, { trigger: 'opus_budget_guard' });
          }
          _pushRateLimitEvent({ type: 'per_model', trigger: 'opus_budget_guard', model: currentModel, msgs: opusCount, budget: tierBudget, tier: isThinking1MModel(currentModel) ? 'T1M' : isThinkingModel(currentModel) ? 'T' : 'R' });

          const opusAvailable = _countOpusAvailableTrials(S.activeIndex);
          if (opusAvailable === 0) {
            _logWarn('Opus守卫', `全池Trial Opus预算耗尽(${opusCount}/${tierBudget}条,无候选) → 主动降级到Sonnet`);
            const downgraded = await _downgradeFromTrialPressure(`[OPUS_GUARD] 全池Opus预算耗尽(已用${opusCount}/${tierBudget}条)`);
            if (downgraded) {
              _activateBoost();
              deps.updatePoolBar?.();
              _refreshPanel();
              return;
            }
          } else {
            _logInfo('Opus守卫', `Opus预算触发切号: ${opusCount}/${tierBudget}条, 可用Trial候选=${opusAvailable}个, 冷却=${dynamicCooldown}s`);
          }
        }
        _logInfo("调度决策", `预防性切号: ${decision.reason}`);
        const isOpusGuard = decision.reason.startsWith('opus_budget_guard');
        const switchResult = await _performSwitch(context, {
          threshold,
          targetPolicy: decision.targetPolicy || 'same_strategy',
          opusBudgetFilter: isOpusGuard,
        });
        if (!switchResult.ok) {
          if (isOpusGuard) {
            _logWarn('Opus守卫', '切号失败,降级到Sonnet作为最后防线');
            const downgraded = await _downgradeFromTrialPressure('[OPUS_GUARD] 切号失败,降级兜底');
            if (downgraded) {
              _activateBoost();
              deps.updatePoolBar?.();
              _refreshPanel();
              return;
            }
          }
          if (trialPoolActive) S.lastTrialPoolCooldownFailTs = Date.now();
          deps.updatePoolBar?.();
          _logWarn("调度决策", "预防性切号失败: 所有账号额度不足或预热失败");
        }
      }
    }
  }

  deps.updatePoolBar?.();
}

/** 号池轮转命令 */
export async function _doPoolRotate(context, isPanic = false) {
  if (S.switching) return;
  const accounts = S.am.getAll();
  if (accounts.length === 0) {
    vscode.commands.executeCommand("wam.openPanel");
    return;
  }

  const threshold = _getPreemptiveThreshold();

  if (isPanic && S.activeIndex >= 0) {
    S.statusBar.text = "$(zap) 即时切换...";
    const t0 = Date.now();
    _logWarn("轮转", `紧急切换: 标记 #${S.activeIndex + 1} 限流 → 用缓存选最优`);
    if (!S.am.isRateLimited(S.activeIndex)) {
      S.am.markRateLimited(S.activeIndex, 300, { model: "unknown", trigger: "panic_rotate" });
    }
    const panicSwitch = await _performSwitch(context, {
      threshold, targetPolicy: 'same_strategy', panic: true, allowThresholdFallback: true,
    });
    if (panicSwitch.ok) {
      _logInfo("轮转", `✅ 紧急切换完成: → #${panicSwitch.index + 1} (耗时${Date.now() - t0}ms)`);
      deps.updatePoolBar?.();
      _refreshPanel();
      setTimeout(() => deps.refreshAll?.().then(() => { deps.updatePoolBar?.(); _refreshPanel(); }).catch(() => {}), 5000);
      return;
    }
    if (accounts.length > 1) {
      const next = _roundRobinFallback();
      if (next >= 0) await _seamlessSwitch(context, next);
      _logInfo("轮转", `✅ 紧急轮转: → #${next + 1} (耗时${Date.now() - t0}ms)`);
    }
    deps.updatePoolBar?.();
    _refreshPanel();
    return;
  }

  S.statusBar.text = "$(sync~spin) 轮转中...";
  const rotateResult = await _performSwitch(context, {
    threshold, targetPolicy: 'same_strategy', refreshPool: true,
  });
  if (rotateResult.ok) {
    deps.updatePoolBar?.();
    _refreshPanel();
    return;
  } else if (S.am.allDepleted(threshold)) {
    S.statusBar.text = "$(warning) 号池耗尽";
    S.statusBar.color = new vscode.ThemeColor("errorForeground");
    vscode.window.showWarningMessage("WAM: 所有账号额度不足。SWE-1.5模型免费无限使用。", "确定");
  } else {
    if (accounts.length > 1) {
      const next = _roundRobinFallback();
      if (next >= 0) await _seamlessSwitch(context, next);
    }
  }
  deps.updatePoolBar?.();
  _refreshPanel();
}
