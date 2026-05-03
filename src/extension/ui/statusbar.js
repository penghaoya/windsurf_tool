import vscode from 'vscode';
import {
  CONCURRENT_TAB_SAFE,
  TIER_MSG_CAP_ESTIMATE,
} from '../shared/config.js';
import {
  S,
  _getCapacityState,
  _getPreemptiveThreshold,
  _isBoost,
} from '../core/state.js';
import {
  _getVelocity,
  _isHighVelocity,
  _slopePredict,
} from '../core/scheduler.js';
import { _getHourlyMsgCount, _isNearTierCap } from '../core/defense.js';
import { _readCurrentModelUid } from '../core/model.js';
import { _getActiveWindowCount } from '../core/window.js';

let _lastTooltipFingerprint = '';

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
  const acctTag = S.activeIndex >= 0 ? `#${S.activeIndex + 1}` : '';

  // Active account quota (what the user is consuming RIGHT NOW)
  let activeDisplay = '';
  let activeEffective = null;
  if (S.activeIndex >= 0) {
    const aq = S.am.getActiveQuota(S.activeIndex);
    if (aq) {
      if (aq.daily !== null) {
        const parts = [`天${aq.daily}`];
        if (aq.weekly !== null) parts.push(`周${aq.weekly}`);
        activeDisplay = parts.join('·');
        activeEffective = aq.weekly !== null ? Math.min(aq.daily, aq.weekly) : aq.daily;
      } else if (aq.credits !== null) {
        activeDisplay = `${aq.credits}分`;
        activeEffective = aq.credits;
      }
    }
  }

  const quotaDisplay = activeDisplay || `${pool.health}%`;
  const isLow = activeEffective !== null ? activeEffective <= 10 : pool.health <= 10;

  const badTag = pool.depleted > 0 ? `-${pool.depleted}` : '';
  const poolTag = `${pool.available}/${pool.total}${badTag}`;
  const boost = _isBoost() ? '⚡' : '';
  const burst = S.burstMode ? '🔥' : '';
  const auto = vscode.workspace.getConfiguration('wam').get('autoRotate', true)
    ? ''
    : '⏸';

  const winCount = _getActiveWindowCount();
  const winTag = winCount > 1 ? ` W${winCount}` : '';
  const tabTag =
    S.cascadeTabCount > CONCURRENT_TAB_SAFE ? ` T${S.cascadeTabCount}` : '';
  const pendingTag = S.pendingSwitchIndex >= 0 ? ' ?' : '';
  S.statusBar.text = `${modeIcon} ${acctTag} ${quotaDisplay} ${poolTag}${winTag}${tabTag}${pendingTag}${burst}${boost}${auto}`;
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

  // Tooltip fingerprint: skip rebuild if data unchanged (avoid MarkdownString churn in boost mode)
  const fp = `${S.activeIndex}|${S.pendingSwitchIndex}|${pool.available}|${pool.total}|${pool.depleted}|${pool.rateLimited}|${pool.expired}|${pool.avgDaily}|${pool.avgWeekly}|${pool.avgEffective}|${pool.urgentCount}|${vel.toFixed(1)}|${hourlyCount}|${slopeInfo}|${S.switchCount}|${winCount}|${S.cascadeTabCount}|${S.burstMode}|${currentModel}|${lastCapacityResult?.messagesRemaining}|${lastCapacityResult?.hasCapacity}|${probeFailCount}|${S.capacityProbeCount}|${mode}|${threshold}`;
  if (fp === _lastTooltipFingerprint) return;
  _lastTooltipFingerprint = fp;

  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.supportHtml = true;
  const L = (...segments) => md.appendMarkdown(segments.join('') + '\n\n');

  if (S.activeIndex >= 0) {
    const quota = S.am.getActiveQuota(S.activeIndex);
    const account = S.am.get(S.activeIndex);
    if (quota && account) {
      // Line 1: Plan + days remaining
      const planLabel = quota.plan || '计划';
      const daysLabel = quota.planDays !== null
        ? (quota.planDays > 0 ? ` · ${quota.planDays}天剩余` : ' · **已过期**')
        : '';
      L(`**${planLabel}**${daysLabel}`);
      L(`${account.email}`);
      L('---');
      // Quota: show remaining % with compact reset
      const fmtTime = (ts) => {
        const d = new Date(ts);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      };
      if (quota.daily !== null) {
        const resetPart = quota.dailyResetRaw ? ` &nbsp; ↻${fmtTime(quota.dailyResetRaw)}` : '';
        L(`天 **${quota.daily}%**${resetPart}`);
      }
      if (quota.weekly !== null) {
        const resetPart = quota.weeklyReset ? ` &nbsp; ↻${fmtTime(quota.weeklyReset)}` : '';
        L(`周 **${quota.weekly}%**${resetPart}`);
      }
      if (quota.extraBalance !== null) {
        L(`余额 **$${quota.extraBalance.toFixed(2)}**`);
      }
    }
  }
  if (S.pendingSwitchIndex >= 0) {
    const pendingAccount = S.am.get(S.pendingSwitchIndex);
    if (pendingAccount) {
      L('---');
      L(`待确认 &nbsp; **#${S.pendingSwitchIndex + 1}** ${pendingAccount.email}`);
    }
  }

  L('---');
  const poolParts = [`**${pool.available}/${pool.total}**`];
  if (pool.depleted > 0) poolParts.push(`${pool.depleted}耗尽`);
  if (pool.rateLimited > 0) poolParts.push(`${pool.rateLimited}限流`);
  if (pool.expired > 0) poolParts.push(`${pool.expired}过期`);
  L(`号池 ${poolParts.join(' · ')}`);
  if (pool.avgDaily !== null) {
    const parts = [`天均 **${pool.avgDaily}%**`];
    if (pool.avgWeekly !== null) parts.push(`周均 **${pool.avgWeekly}%**`);
    L(parts.join(' &nbsp; '));
  } else if (pool.avgEffective !== null) {
    L(`均剩 **${pool.avgEffective}%**`);
  }
  if (pool.urgentCount > 0) L(`⚠ ${pool.urgentCount}个≤3天到期`);
  if (pool.preResetWasteCount > 0) {
    const avgWaste = Math.round(pool.preResetWasteTotal / pool.preResetWasteCount);
    L(`⚠ ${pool.preResetWasteCount}个账号均剩${avgWaste}%将随重置浪费`);
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
  L(`${mode} · 阈值${threshold}%`);
  S.statusBar.tooltip = md;
}
