/**
 * 模型管理器
 * 模型降级/恢复、变体轮转
 */
import vscode from 'vscode';
import {
  OPUS_VARIANTS, SONNET_FALLBACK, SWE_FREE_FALLBACK,
  isOpusModel, isTierFree,
} from '../shared/config.js';
import {
  S, _isTrialLikeAccount, _getPlanTier, _logInfo, _logWarn,
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

// ═══ 模型降级 ═══

/** Free/Trial压力降级: Opus → SWE-1.5(Free账号) 或 Sonnet(付费账号)
 *  v17.0: Free账号优先降级到 SWE-1.5 (零quota消耗),付费账号降级到 Sonnet */
export async function _downgradeFromTrialPressure(reason) {
  const currentModel = _readCurrentModelUid();
  if (!isOpusModel(currentModel) || currentModel === SONNET_FALLBACK) return false;
  const tier = _getPlanTier(S.activeIndex);
  const fallback = isTierFree(tier) ? SWE_FREE_FALLBACK : SONNET_FALLBACK;
  const switched = await _switchModelUid(fallback);
  if (switched) {
    S.downgradeLockUntil = Date.now() + 120000;
    S.preDowngradeModelUid = currentModel;
    S.autoDowngradedFromOpus = true;
    for (const variant of OPUS_VARIANTS) {
      S.am.clearModelRateLimit && S.am.clearModelRateLimit(S.activeIndex, variant);
    }
    _logWarn('模型降级', `${reason} → 降级到${fallback} (${isTierFree(tier) ? 'Free账号→零消耗' : '付费账号'}) 降级锁120s`);
  }
  return switched;
}
