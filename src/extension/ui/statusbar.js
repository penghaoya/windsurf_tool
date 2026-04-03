import vscode from 'vscode';
import {
  CONCURRENT_TAB_SAFE,
  TIER_MSG_CAP_ESTIMATE,
  getModelBudgetForTier,
  isOpusModel,
  isThinking1MModel,
  isThinkingModel,
} from '../shared/config.js';
import {
  S,
  _getCapacityState,
  _getPreemptiveThreshold,
  _isBoost,
  _isTrialLikeAccount,
  _getPlanTier,
} from '../core/state.js';
import {
  _getVelocity,
  _isHighVelocity,
  _slopePredict,
} from '../core/scheduler.js';
import { _getHourlyMsgCount, _isNearTierCap } from '../core/defense.js';
import { _getOpusMsgCount, _readCurrentModelUid } from '../core/model.js';
import { _getActiveWindowCount } from '../core/window.js';

export function _updatePoolBar() {
  if (!S.statusBar || !S.am) return;
  const accounts = S.am.getAll();
  const threshold = _getPreemptiveThreshold();
  const capacityState = _getCapacityState(S.activeIndex, false);
  const lastCapacityResult = capacityState?.lastResult || null;
  const probeFailCount = capacityState?.failCount || 0;
  if (accounts.length === 0) {
    S.statusBar.text = '$(add) 添加账号';
    S.statusBar.color = new vscode.ThemeColor('disabledForeground');
    S.statusBar.tooltip = '号池为空，点击添加账号';
    return;
  }

  const pool = S.am.getPoolStats(threshold);
  const mode = S.auth ? S.auth.getProxyStatus().mode : '?';
  const modeIcon = mode === 'relay' ? '☁' : '⚡';

  let quotaDisplay = '?';
  let isLow = false;
  if (pool.avgDaily !== null) {
    const dPct = Math.min(100, pool.avgDaily);
    const wPct =
      pool.avgWeekly !== null ? Math.min(100, pool.avgWeekly) : null;
    const poolEffective = wPct !== null ? Math.min(dPct, wPct) : dPct;
    quotaDisplay = wPct !== null ? `天${dPct}%·周${wPct}%` : `天${dPct}%`;
    isLow = poolEffective <= 10;
  } else if (pool.avgCredits !== null) {
    quotaDisplay = `均${pool.avgCredits}分`;
    isLow = pool.avgCredits <= threshold;
  } else {
    quotaDisplay = `${pool.health}%`;
    isLow = pool.health <= 10;
  }

  const poolTag = `${pool.available}/${pool.total}`;
  const boost = _isBoost() ? '⚡' : '';
  const burst = S.burstMode ? '🔥' : '';
  const auto = vscode.workspace.getConfiguration('wam').get('autoRotate', true)
    ? ''
    : '⏸';

  const winCount = _getActiveWindowCount();
  const winTag = winCount > 1 ? ` W${winCount}` : '';
  const tabTag =
    S.cascadeTabCount > CONCURRENT_TAB_SAFE ? ` T${S.cascadeTabCount}` : '';
  S.statusBar.text = `${modeIcon} ${quotaDisplay} ${poolTag}${winTag}${tabTag}${burst}${boost}${auto}`;
  S.statusBar.color = isLow
    ? new vscode.ThemeColor('errorForeground')
    : pool.available === 0
      ? new vscode.ThemeColor('errorForeground')
      : S.burstMode
        ? new vscode.ThemeColor('editorWarning.foreground')
        : new vscode.ThemeColor('testing.iconPassed');

  const slopeInfo = _slopePredict();
  const vel = _getVelocity();
  const hourlyCount = _getHourlyMsgCount();
  const currentModel = S.currentModelUid || _readCurrentModelUid();

  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.supportHtml = true;
  const L = (...segments) => md.appendMarkdown(segments.join('') + '\n\n');
  const fmtDate = (ts) => {
    const date = new Date(ts);
    return `${date.getMonth() + 1}月${date.getDate()}日 ${String(
      date.getHours(),
    ).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };

  if (S.activeIndex >= 0) {
    const quota = S.am.getActiveQuota(S.activeIndex);
    const account = S.am.get(S.activeIndex);
    if (quota && account) {
      L(`**${quota.plan || '计划'}**`);
      L('额度按 天/周 重置');
      if (quota.planDays !== null) {
        if (quota.planDays > 0) L(`计划剩余 **${quota.planDays} 天**`);
        else L('计划 **已过期**');
      }
      L('---');
      if (quota.daily !== null) {
        const used = Math.max(0, 100 - quota.daily);
        L(`**天额度已用：** &nbsp;&nbsp; **${used}%**`);
        if (quota.dailyResetRaw) L(`重置于 ${fmtDate(quota.dailyResetRaw)}`);
        else if (quota.resetCountdown) L(`${quota.resetCountdown} 后重置`);
      }
      if (quota.weekly !== null) {
        const weeklyUsed = Math.max(0, 100 - quota.weekly);
        L(`**周额度已用：** &nbsp;&nbsp; **${weeklyUsed}%**`);
        if (quota.weeklyReset) L(`重置于 ${fmtDate(quota.weeklyReset)}`);
        else if (quota.weeklyResetCountdown) {
          L(`${quota.weeklyResetCountdown} 后重置`);
        }
      }
      if (quota.extraBalance !== null) {
        L(`**额外余额：** &nbsp;&nbsp;&nbsp; **$${quota.extraBalance.toFixed(2)}**`);
      }
      L('---');
      L(`**${quota.plan || '计划'}**`);
      L(`${account.email}`);
    }
  }

  L('---');
  const poolStatus = [`**${pool.available}**可用 / **${pool.total}**总计`];
  if (pool.depleted > 0) poolStatus.push(`${pool.depleted}耗尽`);
  if (pool.rateLimited > 0) poolStatus.push(`${pool.rateLimited}限流`);
  if (pool.expired > 0) poolStatus.push(`${pool.expired}过期`);
  L(`**号池** &nbsp; ${poolStatus.join(' · ')}`);
  if (pool.avgEffective !== null) {
    L(`均剩 **${pool.avgEffective}%** (${pool.effectiveCount}个账号均值)`);
  }
  if (pool.avgDaily !== null) {
    const parts = [`天 **${pool.avgDaily}%**`];
    if (pool.avgWeekly !== null) parts.push(`周 **${pool.avgWeekly}%**`);
    L(parts.join(' &nbsp; '));
  }
  if (pool.urgentCount > 0) L(`⚠ ${pool.urgentCount}个紧急(≤3天)`);
  if (pool.preResetWasteCount > 0) {
    L(`⚠ ${pool.preResetWasteCount}个即将浪费${pool.preResetWasteTotal}%额度`);
  }

  const hasRuntime =
    vel > 0 ||
    hourlyCount > 0 ||
    S.switchCount > 0 ||
    slopeInfo !== null ||
    winCount > 1 ||
    S.cascadeTabCount > 1 ||
    S.burstMode;
  const hasDefense =
    (isOpusModel(currentModel) && S.activeIndex >= 0) ||
    lastCapacityResult ||
    probeFailCount > 0;
  if (hasRuntime) {
    L('---');
    L('**实时监控**');
    if (vel > 0) {
      L(`消耗速度 &nbsp; **${vel.toFixed(1)}%/min**${_isHighVelocity() ? ' ⚡高速' : ''}`);
    }
    if (hourlyCount > 0) {
      L(
        `小时消息 &nbsp; **${hourlyCount}/${TIER_MSG_CAP_ESTIMATE}**${_isNearTierCap() ? ' ⚠接近上限' : ''}`,
      );
    }
    if (slopeInfo !== null) L(`趋势预测 &nbsp; **${slopeInfo}%**`);
    if (S.switchCount > 0) L(`已切换 &nbsp; **${S.switchCount}次**`);
    if (winCount > 1) L(`活跃窗口 &nbsp; **${winCount}个**`);
    if (S.cascadeTabCount > 1) L(`并发对话 &nbsp; **${S.cascadeTabCount}个**`);
    if (S.burstMode) L('🔥 **BURST防护模式**');
  }
  if (hasDefense) {
    L('---');
    L('**防御状态**');
    if (isOpusModel(currentModel) && S.activeIndex >= 0) {
      const opusCount = _getOpusMsgCount(S.activeIndex);
      const tier = _getPlanTier(S.activeIndex);
      const tierBudget = getModelBudgetForTier(currentModel, tier);
      const tierLabel = isThinking1MModel(currentModel)
        ? 'T1M'
        : isThinkingModel(currentModel)
          ? 'T'
          : 'R';
      L(`Opus预算 &nbsp; **${opusCount}/${tierBudget}条** (${tierLabel})`);
    }
    if (lastCapacityResult) {
      const icon = lastCapacityResult.hasCapacity ? '✓' : '✗';
      const hasNumbers = lastCapacityResult.messagesRemaining >= 0 || lastCapacityResult.maxMessages >= 0;
      if (hasNumbers) {
        const remaining = lastCapacityResult.messagesRemaining >= 0 ? lastCapacityResult.messagesRemaining : '?';
        const max = lastCapacityResult.maxMessages >= 0 ? lastCapacityResult.maxMessages : '?';
        L(`L5容量 &nbsp; ${icon} **${remaining}/${max}条** (第${S.capacityProbeCount}次探测)`);
      } else {
        const noData = capacityState?.consecutiveNoData || 0;
        const suffix = noData >= 5 ? ` 降频中(${noData}次无数据)` : '';
        L(`L5容量 &nbsp; ${icon} **可用**(无精确数据)${suffix}`);
      }
    }
    if (probeFailCount > 0) L(`探测失败 &nbsp; **${probeFailCount}次**连续`);
  }
  L('---');
  L(`${mode} · 阈值${threshold}% · 10层防御`);
  S.statusBar.tooltip = md;
}
