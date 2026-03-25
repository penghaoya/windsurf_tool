/**
 * 模型管理器
 * Opus守卫、模型降级/恢复、变体轮转、消息预算追踪
 */
import vscode from 'vscode';
import {
  OPUS_VARIANTS, SONNET_FALLBACK, OPUS_BUDGET_WINDOW, OPUS_COOLDOWN_DEFAULT,
  isOpusModel, isThinkingModel, isThinking1MModel, getModelBudget, getModelBudgetForTier,
} from '../shared/config.js';
import {
  S, _getAccountRuntime, _getCapacityState, _isTrialLikeAccount, _logInfo, _logWarn,
} from './state.js';

// ═══ 模型UID读取 ═══

/** 读取当前活跃模型UID (从state.vscdb windsurfConfigurations/codeium.windsurf)
 *  降级锁期间不从DB读取,防止覆盖降级后的模型状态 */
export function _readCurrentModelUid() {
  if (S.downgradeLockUntil > 0 && Date.now() < S.downgradeLockUntil && S.currentModelUid) {
    return S.currentModelUid;
  }
  if (S.downgradeLockUntil > 0 && Date.now() >= S.downgradeLockUntil) {
    S.downgradeLockUntil = 0;
  }
  try {
    if (!S.auth) return S.currentModelUid;
    const cw = S.auth.readCachedValue && S.auth.readCachedValue('codeium.windsurf');
    if (cw) {
      const d = JSON.parse(cw);
      const uids = d['windsurf.state.lastSelectedCascadeModelUids'];
      if (Array.isArray(uids) && uids.length > 0) {
        S.currentModelUid = uids[0];
        return S.currentModelUid;
      }
    }
  } catch {}
  return S.currentModelUid || 'claude-opus-4-6-thinking-1m';
}

// ═══ 模型切换 ═══

/** 切换Windsurf当前模型UID (写入state.vscdb windsurfConfigurations) */
export async function _switchModelUid(targetUid) {
  if (!targetUid || Date.now() - S.lastModelSwitch < 5000) return false;
  S.lastModelSwitch = Date.now();
  try {
    await vscode.commands.executeCommand('windsurf.cascadeSetModel', targetUid);
    S.currentModelUid = targetUid;
    _logInfo('模型切换', `✅ 已切换到: ${targetUid}`);
    return true;
  } catch (e1) {
    try {
      if (S.auth && S.auth.writeModelSelection) {
        S.auth.writeModelSelection(targetUid);
        S.currentModelUid = targetUid;
        _logInfo('模型切换', `✅ 已切换(DB直写): ${targetUid}`);
        return true;
      }
    } catch {}
    _logWarn('模型切换', `❌ 切换失败: ${targetUid}`, e1.message);
    return false;
  }
}

// ═══ Opus消息预算追踪 ═══

/** 追踪Opus消息 — 在quota%下降且当前模型=Opus时调用 */
export function _trackOpusMsg(accountIndex) {
  const runtime = _getAccountRuntime(accountIndex);
  if (!runtime) return;
  runtime.opusMsgLog.push({ ts: Date.now() });
  const cutoff = Date.now() - OPUS_BUDGET_WINDOW;
  runtime.opusMsgLog = runtime.opusMsgLog.filter((m) => m.ts > cutoff);
}

/** 获取当前账号在窗口内的Opus消息数 */
export function _getOpusMsgCount(accountIndex) {
  const runtime = _getAccountRuntime(accountIndex, false);
  if (!runtime) return 0;
  const cutoff = Date.now() - OPUS_BUDGET_WINDOW;
  return runtime.opusMsgLog.filter((m) => m.ts > cutoff).length;
}

/** 获取提前切号阈值 — budget>1时提前1条,留buffer完成切号
 *  v16.0: 账号类型感知 — Pro账号预算是Trial的3倍 (500 credits/月 vs 100/2周) */
export function _getPreemptAt(modelUid, accountIndex) {
  const isTrial = accountIndex !== undefined ? _isTrialLikeAccount(accountIndex) : true;
  const budget = getModelBudgetForTier(modelUid, isTrial);
  return budget > 1 ? budget - 1 : budget;
}

/** 判断是否达到Opus消息预算 */
export function _isNearOpusBudget(accountIndex) {
  const modelUid = S.currentModelUid || _readCurrentModelUid();
  const count = _getOpusMsgCount(accountIndex);
  return count >= _getPreemptAt(modelUid, accountIndex);
}

/** 获取动态Opus冷却时间 — L5实际值优先,固定值兜底 */
export function _getOpusDynamicCooldown(accountIndex) {
  const capacity = _getCapacityState(accountIndex, false);
  const lastResult = capacity?.lastResult;
  if (lastResult && lastResult.resetsInSeconds > 0 && (Date.now() - (capacity?.lastCheck || 0)) < 120000) {
    return Math.max(lastResult.resetsInSeconds, 300);
  }
  return OPUS_COOLDOWN_DEFAULT;
}

/** 切号后重置该账号的Opus消息计数 */
export function _resetOpusMsgLog(accountIndex) {
  const runtime = _getAccountRuntime(accountIndex);
  if (runtime) runtime.opusMsgLog = [];
}

// ═══ 模型降级 ═══

/** Trial压力降级: Opus → Sonnet */
export async function _downgradeFromTrialPressure(reason) {
  const currentModel = _readCurrentModelUid();
  if (!isOpusModel(currentModel) || currentModel === SONNET_FALLBACK) return false;
  const switched = await _switchModelUid(SONNET_FALLBACK);
  if (switched) {
    S.downgradeLockUntil = Date.now() + 120000;
    S.preDowngradeModelUid = currentModel;
    S.autoDowngradedFromOpus = true;
    _resetOpusMsgLog(S.activeIndex);
    for (const variant of OPUS_VARIANTS) {
      S.am.clearModelRateLimit && S.am.clearModelRateLimit(S.activeIndex, variant);
    }
    _logWarn('模型降级', `${reason} → 降级到${SONNET_FALLBACK}，避免Trial账号互切 (降级锁120s)`);
  }
  return switched;
}
