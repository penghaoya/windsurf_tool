/**
 * 防御层 — L1-L5限流检测、限流分类、容量探测
 * L1: Context Key轮询
 * L3: cachedPlanInfo缓存配额监控
 * L5: gRPC CheckUserMessageRateLimit主动容量探测
 */
import vscode from 'vscode';
import http from 'http';
import {
  TIER_RL_RE, UPGRADE_PRO_RE, ABOUT_HOUR_RE, MODEL_UNREACHABLE_RE,
  PROVIDER_ERROR_RE, GLOBAL_TRIAL_RL_RE, HOUR_WINDOW, TIER_MSG_CAP_ESTIMATE,
  TIER_CAP_WARN_RATIO, GLOBAL_TRIAL_POOL_COOLDOWN_SEC, OPUS_VARIANTS,
  SONNET_FALLBACK, CAPACITY_CHECK_INTERVAL, CAPACITY_CHECK_FAST,
  CAPACITY_CHECK_THINKING, CAPACITY_PREEMPT_REMAINING, APIKEY_CACHE_TTL,
  L5_NODATA_SLOWDOWN_AFTER, L5_NODATA_MAX_INTERVAL, RATE_LIMIT_CONTEXTS,
  isOpusModel, getModelBudget, getModelVariants,
} from '../shared/config.js';
import {
  S, deps, _getAccountRuntime, _getCapacityState,
  _setAccountQuarantine, _getTrialPoolCooldown, _armTrialPoolCooldown,
  _isTrialLikeAccount, _getPreemptiveThreshold, _getActiveSelectionMode,
  _logInfo, _logWarn, _isBoost, _activateBoost, _refreshPanel,
  _getAccountEmail,
} from './state.js';
import {
  _readCurrentModelUid, _switchModelUid,
  _resetOpusMsgLog, _downgradeFromTrialPressure,
} from './model.js';
import {
  _getOtherWindowAccountEmails, _mergeSchedulerFromShared,
} from './window.js';

// ═══ 限流分类 ═══

/** 分类限流类型 — 四重闸门路由
 *  Gate 1/2: quota (D%/W%耗尽) → 账号切换
 *  Gate 3: per_model (单模型桶满) → 模型变体轮转 → 账号切换 → 降级
 *  Gate 4: tier_cap (层级硬限) → 跳过模型轮转, 直接账号切换
 */
export function _classifyRateLimit(errorText, contextKey) {
  if (!errorText && !contextKey) return 'unknown';
  const text = (errorText || '') + ' ' + (contextKey || '');
  if (MODEL_UNREACHABLE_RE.test(text) || PROVIDER_ERROR_RE.test(text)) {
    return 'tier_cap';
  }
  if (GLOBAL_TRIAL_RL_RE.test(text)) {
    return 'tier_cap';
  }
  if (TIER_RL_RE.test(text) || (UPGRADE_PRO_RE.test(text) && /rate\s*limit/i.test(text))) {
    return 'tier_cap';
  }
  if (ABOUT_HOUR_RE.test(text)) return 'tier_cap';
  if (/for\s*this\s*model/i.test(text) || /model.*rate.*limit/i.test(text)) {
    return 'per_model';
  }
  if (contextKey && (contextKey.includes('modelRateLimited') || contextKey.includes('messageRateLimited'))) {
    return 'per_model';
  }
  if (/quota/i.test(text) && /exhaust|exceed/i.test(text)) return 'quota';
  if (contextKey && contextKey.includes('quota')) return 'quota';
  if (contextKey && (contextKey.includes('permissionDenied') || contextKey.includes('rateLimited'))) {
    const model = S.currentModelUid || _readCurrentModelUid();
    if (isOpusModel(model)) return 'per_model';
  }
  return 'unknown';
}

// ═══ 消息追踪 ═══

/** 追踪每小时消息数(用于Gate 4预测) */
export function _trackHourlyMsg() {
  const runtime = _getAccountRuntime();
  if (!runtime) return;
  runtime.hourlyMsgLog.push({ ts: Date.now() });
  const cutoff = Date.now() - HOUR_WINDOW;
  runtime.hourlyMsgLog = runtime.hourlyMsgLog.filter((m) => m.ts > cutoff);
}

/** 获取当前小时消息数 */
export function _getHourlyMsgCount() {
  const runtime = _getAccountRuntime(S.activeIndex, false);
  if (!runtime) return 0;
  const cutoff = Date.now() - HOUR_WINDOW;
  return runtime.hourlyMsgLog.filter((m) => m.ts > cutoff).length;
}

/** 判断是否接近Gate 4层级上限 */
export function _isNearTierCap() {
  const capacity = _getCapacityState(S.activeIndex, false);
  const lastResult = capacity?.lastResult;
  const isNoData = lastResult && lastResult.messagesRemaining < 0;
  const realMax = capacity?.realMaxMessages ?? -1;
  const effectiveCap = realMax > 0 ? realMax : (isNoData ? 15 : TIER_MSG_CAP_ESTIMATE);
  return _getHourlyMsgCount() >= effectiveCap * TIER_CAP_WARN_RATIO;
}

// ═══ Gate 4: 层级限流处理 ═══

/** 账号层级硬限处理 — 跳过模型轮转, 直接账号切换 */
export async function _handleTierRateLimit(context, resetSeconds, details = {}) {
  S.tierRateLimitCount++;
  const logPrefix = `[TIER_RL #${S.tierRateLimitCount}]`;
  _logWarn('层级限流', `${logPrefix} 账号层级硬限! 小时消息=${_getHourlyMsgCount()}条, 冷却=${resetSeconds}s`);
  const cooldown = resetSeconds || 3600;
  const currentModel = _readCurrentModelUid();
  const messageText = String(details.message || '');
  const isGlobalTrial = GLOBAL_TRIAL_RL_RE.test(messageText);
  S.am.markRateLimited(S.activeIndex, cooldown, {
    model: 'all',
    trigger: details.trigger || 'tier_rate_limit',
    type: 'tier_cap',
  });
  _setAccountQuarantine(S.activeIndex, cooldown, isGlobalTrial ? 'global_trial_rate_limit' : 'tier_cap', {
    trigger: details.trigger || 'tier_rate_limit',
  });
  if (isGlobalTrial) {
    _armTrialPoolCooldown(currentModel, Math.min(cooldown, GLOBAL_TRIAL_POOL_COOLDOWN_SEC), 'global_trial_rate_limit', {
      model: currentModel,
    });
    if (await _downgradeFromTrialPressure(`${logPrefix} Trial全局限流`)) {
      return { action: 'fallback_model', cooldown, to: SONNET_FALLBACK };
    }
  }
  _pushRateLimitEvent({
    type: 'tier_cap',
    trigger: details.trigger || 'tier_rate_limit',
    cooldown,
    hourlyMsgs: _getHourlyMsgCount(),
    globalTrial: isGlobalTrial,
  });
  _activateBoost();
  await deps.doPoolRotate(context, true);
  const runtime = _getAccountRuntime();
  if (runtime) runtime.hourlyMsgLog = [];
  return { action: 'tier_account_switch', cooldown };
}

// ═══ Gate 3: Per-Model限流处理 ═══

/** Per-model rate limit 三级突破 */
export async function _handlePerModelRateLimit(context, modelUid, resetSeconds) {
  S.modelRateLimitCount++;
  const logPrefix = `[MODEL_RL #${S.modelRateLimitCount}]`;
  const effectiveCooldown = isOpusModel(modelUid) ? Math.max(resetSeconds || 0, 1500) : (resetSeconds || 1200);
  _logWarn('模型限流', `${logPrefix} 检测到模型级限流: 模型=${modelUid}, 服务端冷却=${resetSeconds}s, 实际冷却=${effectiveCooldown}s`);

  if (isOpusModel(modelUid)) {
    for (const variant of OPUS_VARIANTS) {
      S.am.markModelRateLimited(S.activeIndex, variant, effectiveCooldown, { trigger: 'per_model_rate_limit' });
    }
    _resetOpusMsgLog(S.activeIndex);
  } else {
    S.am.markModelRateLimited(S.activeIndex, modelUid, effectiveCooldown, { trigger: 'per_model_rate_limit' });
  }

  if (isOpusModel(modelUid)) {
    _logInfo('模型限流', `${logPrefix} Opus共享桶 → 跳过变体轮转, 直接切换账号`);
  } else {
    const modelVariants = getModelVariants(modelUid);
    const availableVariant = modelVariants.length > 1
      ? S.am.findAvailableModelVariant(S.activeIndex, modelVariants)
      : null;
    if (availableVariant && availableVariant !== modelUid) {
      _logInfo('模型限流', `${logPrefix} L1变体轮转: ${modelUid} → ${availableVariant}`);
      await _switchModelUid(availableVariant);
      return { action: 'variant_switch', from: modelUid, to: availableVariant };
    }
  }

  // L2: 换账号继续用同模型
  const threshold = _getPreemptiveThreshold();
  const modelCandidates = S.am.findBestForModel(
    modelUid,
    S.activeIndex,
    threshold,
    _getOtherWindowAccountEmails(),
    { preferredMode: _getActiveSelectionMode() },
  );
  if (modelCandidates.length > 0) {
    const switchResult = await deps.performSwitch(context, {
      threshold,
      targetPolicy: 'same_model',
      modelUid,
      candidates: modelCandidates,
    });
    if (switchResult.ok) {
      _logInfo('模型限流', `${logPrefix} L2切换账号: → #${switchResult.index + 1} 继续使用${modelUid}`);
      _pushRateLimitEvent({ type: 'per_model', trigger: 'opus_guard_reactive', model: modelUid, cooldown: effectiveCooldown, switchTo: switchResult.index + 1 });
      return { action: 'account_switch', to: switchResult.index, model: modelUid };
    }
  }
  _logInfo('模型限流', `${logPrefix} L2全部不可用 → 尝试L3降级`);

  // L3: 智能降级到Sonnet
  if (isOpusModel(modelUid)) {
    _logWarn('模型限流', `${logPrefix} L3降级: 所有账号Opus均已限流 → 降级到${SONNET_FALLBACK}`);
    await _switchModelUid(SONNET_FALLBACK);
    await deps.doPoolRotate(context, true);
    return { action: 'fallback', from: modelUid, to: SONNET_FALLBACK };
  }

  await deps.doPoolRotate(context, true);
  return { action: 'account_rotate', model: modelUid };
}

// ═══ apiKey缓存 ═══

export function _getCachedApiKey() {
  if (S.cachedApiKey && Date.now() - S.cachedApiKeyTs < APIKEY_CACHE_TTL) {
    return S.cachedApiKey;
  }
  try {
    const key = S.auth?.readCurrentApiKey();
    if (key && key.length > 10) {
      S.cachedApiKey = key;
      S.cachedApiKeyTs = Date.now();
      return key;
    }
  } catch {}
  return S.cachedApiKey;
}

export function _invalidateApiKeyCache() {
  S.cachedApiKey = null;
  S.cachedApiKeyTs = 0;
}

// ═══ Layer 5: 主动容量探测 ═══

/** 主动调用CheckUserMessageRateLimit获取精确容量 */
export async function _probeCapacity() {
  if (!S.auth || S.activeIndex < 0) return null;
  const capacityState = _getCapacityState();
  if (!capacityState) return null;

  if (capacityState.failCount >= 5) {
    if (Date.now() - capacityState.lastCheck < 60000) return capacityState.lastResult;
  }

  const apiKey = _getCachedApiKey();
  if (!apiKey) {
    _logWarn('L5探测', 'apiKey未获取，跳过容量探测');
    return null;
  }

  const modelUid = _readCurrentModelUid();
  if (!modelUid) return null;

  capacityState.lastCheck = Date.now();
  S.capacityProbeCount++;

  try {
    const result = await S.auth.checkRateLimitCapacity(apiKey, modelUid);
    if (result) {
      const hasUsefulData = result.messagesRemaining >= 0 || result.maxMessages >= 0 || !result.hasCapacity;
      if (hasUsefulData) {
        capacityState.failCount = 0;
        capacityState.consecutiveNoData = 0;
        capacityState.lastSuccessfulProbe = Date.now();
      } else {
        capacityState.failCount++;
        capacityState.consecutiveNoData = (capacityState.consecutiveNoData || 0) + 1;
      }
      capacityState.lastResult = result;

      if (result.maxMessages > 0 && result.maxMessages !== capacityState.realMaxMessages) {
        const old = capacityState.realMaxMessages;
        capacityState.realMaxMessages = result.maxMessages;
        _logInfo('L5探测', `服务端消息上限更新: ${old} → ${capacityState.realMaxMessages}条 (模型=${modelUid})`);
      }

      const modelShort = modelUid.replace('claude-', '').replace(/-\d{4}.*$/, '');
      if (!result.hasCapacity) {
        _logWarn('L5探测', `🚫 #${S.capacityProbeCount} 容量耗尽! 剩余${result.messagesRemaining}/${result.maxMessages}条 ${result.resetsInSeconds}s后恢复 (${modelShort}) → 即将切号`);
      } else if (hasUsefulData) {
        if (S.capacityProbeCount % 5 === 0 || result.messagesRemaining <= 2) {
          _logInfo('L5探测', `✅ #${S.capacityProbeCount} 剩余${result.messagesRemaining}/${result.maxMessages}条 (${modelShort})`);
        }
      } else {
        if (S.capacityProbeCount <= 1 || S.capacityProbeCount % 10 === 0) {
          _logInfo('L5探测', `✅ #${S.capacityProbeCount} 可用(无精确数据—Trial账号服务端不报告剩余条数) (${modelShort})`);
        }
      }

      return result;
    }
    capacityState.failCount++;
    return null;
  } catch (e) {
    capacityState.failCount++;
    _logWarn('L5探测', `探测失败 (第${capacityState.failCount}次): ${e.message}`);
    return null;
  }
}

/** 处理容量不足 — 立即切号 */
export async function _handleCapacityExhausted(context, capacityResult) {
  S.capacitySwitchCount++;
  const logPrefix = `[CAPACITY_RL #${S.capacitySwitchCount}]`;
  const cooldown = capacityResult.resetsInSeconds || 3600;
  const model = _readCurrentModelUid();

  _logWarn('L5探测', `${logPrefix} 容量不足! 可用=${capacityResult.hasCapacity} 剩余=${capacityResult.messagesRemaining}/${capacityResult.maxMessages}条 冷却=${cooldown}s`);

  const gateType = _classifyRateLimit(capacityResult.message, null);
  const isGlobalTrial = GLOBAL_TRIAL_RL_RE.test(String(capacityResult.message || ''));

  S.am.markRateLimited(S.activeIndex, cooldown, {
    model: model || 'current',
    trigger: 'capacity_probe',
    type: gateType || 'tier_cap',
    capacityData: {
      remaining: capacityResult.messagesRemaining,
      max: capacityResult.maxMessages,
      resets: capacityResult.resetsInSeconds,
    },
  });
  _setAccountQuarantine(S.activeIndex, cooldown, isGlobalTrial ? 'global_trial_rate_limit' : (gateType || 'tier_cap'), {
    trigger: 'capacity_probe',
    model,
  });
  if (isGlobalTrial) {
    _armTrialPoolCooldown(model, Math.min(cooldown, GLOBAL_TRIAL_POOL_COOLDOWN_SEC), 'global_trial_rate_limit', {
      model,
    });
  }

  _pushRateLimitEvent({
    type: gateType || 'tier_cap',
    trigger: 'capacity_probe_L5',
    cooldown,
    model,
    messagesRemaining: capacityResult.messagesRemaining,
    maxMessages: capacityResult.maxMessages,
    resetsInSeconds: capacityResult.resetsInSeconds,
    message: capacityResult.message,
    globalTrial: isGlobalTrial,
  });

  if (gateType === 'tier_cap' || gateType === 'unknown') {
    const runtime = _getAccountRuntime();
    if (runtime) runtime.hourlyMsgLog = [];
    if (isGlobalTrial && await _downgradeFromTrialPressure(`${logPrefix} Trial全局限流`)) {
      return { action: 'fallback_model', cooldown, to: SONNET_FALLBACK };
    }
    _invalidateApiKeyCache();
    _activateBoost();
    await deps.doPoolRotate(context, true);
    return { action: 'capacity_account_switch', cooldown };
  }

  if (gateType === 'per_model' && model) {
    _invalidateApiKeyCache();
    return await _handlePerModelRateLimit(context, model, cooldown);
  }

  _invalidateApiKeyCache();
  _activateBoost();
  await deps.doPoolRotate(context, true);
  return { action: 'capacity_rotate', cooldown };
}

// ═══ 安全中枢 ═══

/** 推送限流事件到安全中枢 :9877 (非阻塞, 失败静默) */
export function _pushRateLimitEvent(eventData) {
  try {
    const payload = JSON.stringify({
      event: "rate_limit",
      timestamp: Date.now(),
      activeIndex: S.activeIndex,
      activeEmail: S.am?.get(S.activeIndex)?.email?.split("@")[0] || "?",
      windowId: S.windowId,
      cascadeTabs: S.cascadeTabCount,
      burstMode: S.burstMode,
      switchCount: S.switchCount,
      poolStats: S.am?.getPoolStats(_getPreemptiveThreshold()) || {},
      ...eventData,
    });
    const req = http.request({
      hostname: "127.0.0.1",
      port: 9877,
      method: "POST",
      path: "/api/wam/rate_limit_event",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 3000,
    });
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.write(payload);
    req.end();
    _logInfo(
      "安全中枢",
      `限流事件已推送 (类型=${eventData.type}, 触发=${eventData.trigger})`,
    );
  } catch {}
}

// ═══ 启动限流检测 ═══

/** 全感知限流检测启动 (L1 + L3 + L5) */
export function _startQuotaWatcher(context) {
  let _lastTriggered = 0;

  const _smartCooldown = (rlType, serverResetSec) => {
    if (serverResetSec && serverResetSec > 0) return serverResetSec;
    if (S.auth) {
      try {
        const cached = S.auth.readCachedRateLimit();
        if (cached && cached.resetsInSec && cached.resetsInSec > 0) {
          _logInfo("冷却", `从gate.vscdb获取实际冷却时间: ${cached.resetsInSec}s (类型=${cached.type})`);
          return cached.resetsInSec;
        }
      } catch {}
    }
    if (rlType === "message_rate") return 1500;
    if (rlType === "quota") return 3600;
    return 600;
  };

  const _extractResetSeconds = (text) => {
    if (!text) return null;
    const m = text.match(/resets?\s*in:?\s*(\d+)m(?:(\d+)s)?/i);
    if (m) return parseInt(m[1]) * 60 + (parseInt(m[2]) || 0);
    const s = text.match(/resets?\s*in:?\s*(\d+)s/i);
    if (s) return parseInt(s[1]);
    if (ABOUT_HOUR_RE.test(text)) return 3600;
    const h = text.match(/(?:resets?|try\s*again)\s*in:?\s*(\d+)\s*h/i);
    if (h) return parseInt(h[1]) * 3600;
    return null;
  };

  const _getDebounce = () => (S.burstMode ? 2000 : 5000);

  // ═══ Layer 1: Context Key检测 ═══
  const checkContextKeys = async () => {
    if (S.activeIndex < 0 || S.switching) return;
    for (const ctx of RATE_LIMIT_CONTEXTS) {
      try {
        const exceeded = await vscode.commands.executeCommand("getContext", ctx);
        if (exceeded && !S.switching && Date.now() - _lastTriggered > _getDebounce()) {
          _lastTriggered = Date.now();
          const rlType = ctx.includes("quota") || ctx.includes("Quota") ? "quota" : "message_rate";
          const cooldown = _smartCooldown(rlType);
          deps.trackMessageRate?.();
          _logWarn("限流检测", `L1检测到限流: ${ctx} (类型=${rlType}, 冷却=${cooldown}s, 并发=${S.cascadeTabCount}) → 立即轮转`);
          const currentModel = _readCurrentModelUid();
          const gateType = _classifyRateLimit(null, ctx);
          if (gateType === 'tier_cap') {
            _logWarn('限流检测', `L1→层级限流: 账号层级硬限 (${ctx})`);
            await _handleTierRateLimit(context, cooldown, { trigger: ctx, message: ctx });
            return;
          }
          if (gateType === 'per_model' && currentModel) {
            _logWarn('限流检测', `L1→模型限流: ${currentModel} (${ctx})`);
            await _handlePerModelRateLimit(context, currentModel, cooldown);
            return;
          }
          S.am.markRateLimited(S.activeIndex, cooldown, {
            model: currentModel || "current",
            trigger: ctx,
            type: rlType,
          });
          _pushRateLimitEvent({ type: rlType, trigger: ctx, cooldown, tabs: S.cascadeTabCount });
          _activateBoost();
          await deps.doPoolRotate(context, true);
          return;
        }
      } catch (e) {
        if (e.message && !e.message.includes("Unknown context") && !e.message.includes("not found")) {
          _logWarn("限流检测", `上下文键 ${ctx} 检测异常`, e.message);
        }
      }
    }
  };
  let ctxTimer = setInterval(checkContextKeys, 2000);
  const adaptiveCtxTimer = setInterval(() => {
    const targetMs = S.burstMode ? 1500 : 2000;
    clearInterval(ctxTimer);
    ctxTimer = setInterval(checkContextKeys, targetMs);
  }, 30000);
  context.subscriptions.push({
    dispose: () => { clearInterval(ctxTimer); clearInterval(adaptiveCtxTimer); },
  });

  // ═══ Layer 3: cachedPlanInfo实时监控 ═══
  const checkCachedQuota = async () => {
    if (S.activeIndex < 0 || S.switching || !S.auth) return;
    try {
      const cached = S.auth.readCachedQuota();
      if (cached && cached.exhausted && !S.switching && Date.now() - _lastTriggered > _getDebounce()) {
        _lastTriggered = Date.now();
        const cooldown = _smartCooldown("quota");
        _logWarn("限流检测", `L3缓存配额显示耗尽: 天=${cached.daily}% 周=${cached.weekly}% 冷却=${cooldown}s → 立即轮转`);
        S.am.markRateLimited(S.activeIndex, cooldown, {
          model: "current",
          trigger: "cachedPlanInfo_exhausted",
          type: "quota",
        });
        _pushRateLimitEvent({ type: "quota", trigger: "cachedPlanInfo_exhausted", cooldown, daily: cached.daily, weekly: cached.weekly });
        _activateBoost();
        await deps.doPoolRotate(context, true);
      }
    } catch (e) {
      _logWarn("限流检测", "L3缓存配额检查异常", e.message);
    }
  };
  const cacheTimer = setInterval(checkCachedQuota, S.burstMode ? 5000 : 10000);
  context.subscriptions.push({ dispose: () => clearInterval(cacheTimer) });

  // ═══ Layer 5: Active Rate Limit Capacity Probe ═══
  const checkCapacityProbe = async () => {
    if (S.activeIndex < 0 || S.switching || !S.auth) return;

    _mergeSchedulerFromShared();
    const modelUid = S.currentModelUid || _readCurrentModelUid();
    if (isOpusModel(modelUid) && _isTrialLikeAccount(S.activeIndex) && _getTrialPoolCooldown(modelUid)) {
      if (!S.switching && Date.now() > S.downgradeLockUntil) {
        _logWarn('L5探测', '❄ 检测到跨窗口Trial池冷却 → 主动降级Sonnet');
        await _downgradeFromTrialPressure('[L5跨窗口] 检测到Trial池冷却');
        deps.updatePoolBar?.();
        _refreshPanel();
        return;
      }
    }

    // 降级恢复
    if (S.autoDowngradedFromOpus && S.preDowngradeModelUid && !isOpusModel(modelUid)) {
      const poolCd = _getTrialPoolCooldown(S.preDowngradeModelUid);
      const downgradeExpired = !S.downgradeLockUntil || Date.now() > S.downgradeLockUntil;
      if (!poolCd && downgradeExpired && !S.switching) {
        const restored = await _switchModelUid(S.preDowngradeModelUid);
        if (restored) {
          _logInfo('模型恢复', `Trial池冷却已过期 → 恢复到${S.preDowngradeModelUid}`);
          S.autoDowngradedFromOpus = false;
          S.preDowngradeModelUid = null;
          _resetOpusMsgLog(S.activeIndex);
          deps.updatePoolBar?.();
          _refreshPanel();
          return;
        }
      }
    }

    // 自适应间隔
    const isThinking = isOpusModel(modelUid) && /thinking/i.test(modelUid);
    const capacityState = _getCapacityState();
    if (!capacityState) return;
    let interval = isThinking ? CAPACITY_CHECK_THINKING
      : (_isBoost() || S.burstMode) ? CAPACITY_CHECK_FAST : CAPACITY_CHECK_INTERVAL;
    const noDataCount = capacityState.consecutiveNoData || 0;
    if (noDataCount >= L5_NODATA_SLOWDOWN_AFTER) {
      const slowFactor = Math.min(noDataCount - L5_NODATA_SLOWDOWN_AFTER + 1, 4);
      interval = Math.min(interval * (1 + slowFactor), L5_NODATA_MAX_INTERVAL);
    }
    // v16.0: 容量自适应 — 剩余消息越少,探测越频繁 (防止最后几条消息撞限流)
    const lastResult = capacityState.lastResult;
    if (lastResult && lastResult.messagesRemaining >= 0) {
      if (lastResult.messagesRemaining <= 2) interval = Math.min(interval, 3000);
      else if (lastResult.messagesRemaining <= 5) interval = Math.min(interval, 8000);
      else if (lastResult.messagesRemaining <= 10) interval = Math.min(interval, 15000);
    }
    if (Date.now() - capacityState.lastCheck < interval) return;

    try {
      const capacity = await _probeCapacity();
      if (!capacity) return;

      if (!capacity.hasCapacity) {
        if (!S.switching && Date.now() - _lastTriggered > _getDebounce()) {
          _lastTriggered = Date.now();
          _logWarn('L5探测', `🚫 容量已耗尽 → 立即切号`);
          await _handleCapacityExhausted(context, capacity);
          return;
        }
      }

      if (capacity.messagesRemaining >= 0 && capacity.messagesRemaining <= CAPACITY_PREEMPT_REMAINING) {
        if (!S.switching && Date.now() - _lastTriggered > _getDebounce()) {
          _lastTriggered = Date.now();
          _logWarn('L5探测', `⚠️ 容量即将耗尽: 剩余${capacity.messagesRemaining}/${capacity.maxMessages}条 → 提前切号`);
          await _handleCapacityExhausted(context, capacity);
          return;
        }
      }
    } catch (e) {
      _logWarn('L5探测', `探测循环异常: ${e.message}`);
    }
  };
  const l5Timer = setTimeout(() => {
    checkCapacityProbe();
    const l5Interval = setInterval(checkCapacityProbe, CAPACITY_CHECK_THINKING);
    context.subscriptions.push({ dispose: () => clearInterval(l5Interval) });
  }, 10000);
  context.subscriptions.push({ dispose: () => clearTimeout(l5Timer) });

  _logInfo(
    "检测层",
    `已启动: L1=上下文键监听(${RATE_LIMIT_CONTEXTS.length}个键,每2s) | L3=缓存配额监控(每${S.burstMode ? '5' : '10'}s) | L5=gRPC容量探测(Thinking:${CAPACITY_CHECK_THINKING/1000}s/加速:${CAPACITY_CHECK_FAST/1000}s/正常:${CAPACITY_CHECK_INTERVAL/1000}s) | 防抖:${S.burstMode ? '2' : '5'}s`,
  );
}
