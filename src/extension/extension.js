/**
 * 无感号池引擎 v1.0.0 — 主入口 + 胶水层
 *
 * 道: 用户是号池，不是单个账号。切换必须在rate limit之前发生。
 *
 * 架构:
 *   认证: Firebase → idToken → provideAuthTokenToAuthProvider → session
 *   额度: QUOTA(daily%+weekly%) | CREDITS(固定积分) → effective=min(D,W)
 *   指纹: 6个ID轮转(切号前写入→LS重启读取=热重置)
 *   注入: S0=idToken → S1=OTAT → S2=apiKey → S3=DB直写
 *   预防: L5 gRPC容量探测(CheckUserMessageRateLimit)为本，辅以阈值/斜率/限流检测
 *
 * 模块化:
 *   config.js       — 常量/正则/模型辅助函数
 *   engineState.js  — 共享可变状态 + 调度运行时 + 日志 + deps注册
 *   windowCoord.js  — 多窗口心跳/共享状态读写
 *   modelManager.js — Opus守卫/模型降级/变体轮转
 *   defenseLayer.js — L1-L5检测/限流分类/容量探测
 *   scheduler.js    — _poolTick/evaluateActiveAccount/_performSwitch
 */
import vscode from 'vscode';
import { AccountManager } from './accountManager.js';
import { AuthService } from './authService.js';
import { openAccountPanel, AccountViewProvider } from './webviewProvider.js';
import {
  readFingerprint,
  resetFingerprint,
  ensureComplete as ensureFingerprintComplete,
  hotVerify,
} from './fingerprintManager.js';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { getStateDbPath, dbReadKey, dbDeleteKey, dbTransaction, dbUpdateKeys } from './sqliteHelper.js';

// ═══ 模块导入 ═══
import {
  CONCURRENT_TAB_SAFE, TIER_MSG_CAP_ESTIMATE,
  OPUS_VARIANTS, SONNET_FALLBACK, GLOBAL_TRIAL_RL_RE,
  isOpusModel, isThinkingModel, isThinking1MModel, getModelBudget,
} from './config.js';
import {
  S, schedulerState, deps,
  _getAccountRuntime, _getCapacityState,
  _getAccountQuarantineByEmail, _getAccountEmail,
  _clearAccountQuarantine, _isTrialLikeAccount, _getTrialPoolCooldown,
  _getPreemptiveThreshold, _normalizeEmail,
  _dropAccountRuntimeByEmail, _resetAccountRuntimeByEmail,
  _logInfo, _logWarn, _logError, _isBoost, _activateBoost, _refreshPanel,
} from './engineState.js';
import {
  _registerWindow, _deregisterWindow, _startWindowCoordinator,
  _getOtherWindowAccountEmails, _getActiveWindowCount,
  _heartbeatWindow, _syncSchedulerToShared,
  _getWindsurfGlobalStoragePath,
} from './windowCoord.js';
import {
  _readCurrentModelUid, _resetOpusMsgLog,
  _getOpusMsgCount, _downgradeFromTrialPressure,
} from './modelManager.js';
import {
  _getHourlyMsgCount, _isNearTierCap,
  _getCachedApiKey, _invalidateApiKeyCache,
  _startQuotaWatcher,
} from './defenseLayer.js';
import {
  _startPoolEngine, _performSwitch, _seamlessSwitch,
  _doPoolRotate, _roundRobinFallback,
  _trackMessageRate, _slopePredict, _getVelocity, _isHighVelocity,
  _detectCascadeTabs,
} from './scheduler.js';

// ═══ deps 注册 (打破循环依赖) ═══
function _wireDeps() {
  deps.loginToAccount = _loginToAccount;
  deps.refreshOne = _refreshOne;
  deps.refreshAll = _refreshAll;
  deps.doPoolRotate = _doPoolRotate;
  deps.updatePoolBar = _updatePoolBar;
  deps.syncSchedulerToShared = _syncSchedulerToShared;
  deps.performSwitch = _performSwitch;
  deps.trackMessageRate = _trackMessageRate;
}

// ========== Activation ==========

function activate(context) {
  // 仅在 Windsurf 中激活，VS Code 等其他宿主静默跳过
  const appName = (vscode.env.appName || '').toLowerCase();
  if (!appName.includes('windsurf')) {
    return;
  }
  try {
    _activate(context);
  } catch (e) {
    _logError("启动", "激活失败", e.message);
  }
}

function _activate(context) {
  // deps 注册 (必须在所有模块使用 deps 之前)
  _wireDeps();

  // 设置上下文键，让 package.json 的 when 条件生效（侧边栏/命令仅 Windsurf 可见）
  vscode.commands.executeCommand('setContext', 'windsurf-tools.active', true);

  // ═══ 结构化日志通道 (v6.2 P1: 用户可见) ═══
  S.outputChannel = vscode.window.createOutputChannel("Windsurf小助手");
  context.subscriptions.push(S.outputChannel);
  _logInfo(
    "启动",
    "WAM 号池引擎 v13.1 启动中...",
  );

  // 指纹完整性
  try {
    const r = ensureFingerprintComplete();
    if (r.fixed.length > 0) _logInfo("指纹", `已补全缺失的设备ID: ${r.fixed.join(", ")}`);
  } catch (e) {
    _logWarn("指纹", "补全检查跳过", e.message);
  }

  const storagePath = context.globalStorageUri.fsPath;
  S.am = new AccountManager(storagePath);
  S.auth = new AuthService(storagePath);
  S.am.startWatching();

  // ═══ 状态栏：号池视图 ═══
  S.statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  S.statusBar.command = "wam.openPanel";
  S.statusBar.tooltip = "号池管理 · 点击查看";
  context.subscriptions.push(S.statusBar);

  // 恢复状态
  const savedIndex = context.globalState.get("wam-current-index", -1);
  const accounts = S.am.getAll();
  if (savedIndex >= 0 && savedIndex < accounts.length)
    S.activeIndex = savedIndex;
  _updatePoolBar();
  S.statusBar.show();

  // 恢复代理
  const savedMode = context.globalState.get("wam-proxy-mode", null);
  if (savedMode) S.auth.setMode(savedMode);

  // 后台代理探测
  setTimeout(() => {
    if (!S.auth) return;
    S.auth
      .reprobeProxy()
      .then((r) => {
        if (r.port > 0) context.globalState.update("wam-proxy-mode", r.mode);
        _updatePoolBar();
        _logInfo("代理", `探测完成 → 模式:${r.mode} 端口:${r.port}`);
      })
      .catch((e) => {
        _logWarn("代理", "探测失败", e.message);
      });
  }, 1200);

  // ═══ 侧边栏 ═══
  const sidebarProvider = new AccountViewProvider(
    context.extensionUri,
    S.am,
    S.auth,
    (action, arg) => _handleAction(context, action, arg),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "windsurf-assistant.assistantView",
      sidebarProvider,
    ),
  );
  S.panelProvider = sidebarProvider;

  // ═══ 命令集 (精简 — 用户无需感知单个账号) ═══
  context.subscriptions.push(
    vscode.commands.registerCommand("wam.switchAccount", () =>
      _doPoolRotate(context),
    ),
    vscode.commands.registerCommand("wam.refreshCredits", () =>
      _doRefreshPool(context),
    ),
    vscode.commands.registerCommand("wam.openPanel", () => {
      const result = openAccountPanel(
        context,
        S.am,
        S.auth,
        (a, b) => _handleAction(context, a, b),
        S.panel,
      );
      if (result) S.panel = result.panel;
    }),
    vscode.commands.registerCommand("wam.switchMode", () =>
      _doSwitchMode(context),
    ),
    vscode.commands.registerCommand("wam.reprobeProxy", async () => {
      const r = await S.auth.reprobeProxy();
      context.globalState.update("wam-proxy-mode", r.mode);
      _updatePoolBar();
    }),
    vscode.commands.registerCommand("wam.resetFingerprint", () =>
      _doResetFingerprint(),
    ),
    vscode.commands.registerCommand("wam.panicSwitch", () =>
      _doPoolRotate(context, true),
    ),
    vscode.commands.registerCommand("wam.batchAdd", () => _doBatchAdd()),
    vscode.commands.registerCommand("wam.refreshAllCredits", () =>
      _doRefreshPool(context),
    ),
    vscode.commands.registerCommand("wam.smartRotate", () =>
      _doPoolRotate(context),
    ),
    vscode.commands.registerCommand("wam.importAccounts", () =>
      _doImport(context),
    ),
    vscode.commands.registerCommand("wam.initWorkspace", () =>
      _doInitWorkspace(context),
    ),
  );

  // ═══ 号池引擎启动 ═══
  _startPoolEngine(context);
  // ═══ 多窗口协调 (v6.3) ═══
  _startWindowCoordinator(context);
  // ═══ 并发Tab感知 (v6.4) ═══
  _detectCascadeTabs();
  const proxyInfo = S.auth.getProxyStatus();
  const winCount = _getActiveWindowCount();
  _logInfo(
    "启动",
    `✅ 号池引擎就绪 v13.1 | 账号: ${accounts.length}个 | 代理: ${proxyInfo.mode}:${proxyInfo.port} | 窗口: ${winCount}个 | 对话: ${S.cascadeTabCount}个${S.burstMode ? ' (BURST防护)' : ''}`,
  );
  _logInfo(
    "启动",
    `检测层: L1=上下文键(2s) L3=缓存配额(10s) L5=gRPC探测(Thinking:3s/加速:15s/正常:45s) | Trial防御+模型降级`,
  );
}

// ========== Refresh Helpers ==========

/** Refresh one account's usage/credits. Returns { credits, usageInfo }
 *  v5.11.0: Supplements QUOTA data from cachedPlanInfo when API doesn't return daily% */
async function _refreshOne(index) {
  const account = S.am.get(index);
  if (!account) return { credits: undefined };
  try {
    const usageInfo = await S.auth.getUsageInfo(account.email, account.password);
    if (usageInfo) {
      // v5.11.0+v6.9: Supplement from cachedPlanInfo for active account (single read)
      if (index === S.activeIndex && S.auth) {
        try {
          const cached = S.auth.readCachedQuota();
          if (cached) {
            // Supplement daily% if billingStrategy=quota but API didn't return it
            if (usageInfo.billingStrategy === "quota" && !usageInfo.daily && cached.daily !== null) {
              usageInfo.daily = {
                used: Math.max(0, 100 - cached.daily),
                total: 100,
                remaining: cached.daily,
              };
              if (cached.weekly !== null)
                usageInfo.weekly = {
                  used: Math.max(0, 100 - cached.weekly),
                  total: 100,
                  remaining: cached.weekly,
                };
              if (cached.resetTime) usageInfo.resetTime = cached.resetTime;
              if (cached.weeklyReset) usageInfo.weeklyReset = cached.weeklyReset;
              if (cached.extraBalance)
                usageInfo.extraBalance = cached.extraBalance;
              usageInfo.mode = "quota";
              _logInfo(
                "额度补充",
                `#${index + 1} 从缓存配额补充: 天=${cached.daily}% 周=${cached.weekly}%`,
              );
            }
            // Always supplement plan dates (official alignment)
            if (cached.planStart && !usageInfo.planStart)
              usageInfo.planStart = cached.planStart;
            if (cached.planEnd && !usageInfo.planEnd)
              usageInfo.planEnd = cached.planEnd;
            if (cached.plan && !usageInfo.plan) usageInfo.plan = cached.plan;
          }
        } catch (e) { _logWarn('额度补充', `cachedPlanInfo读取失败: ${e.message}`); }
      }
      S.am.updateUsage(index, usageInfo);
      return { credits: usageInfo.credits, usageInfo };
    }
  } catch (e) { _logWarn('刷新', `getUsageInfo失败: ${e.message}`); }
  try {
    const credits = await S.auth.getCredits(account.email, account.password);
    if (credits !== undefined) S.am.updateCredits(index, credits);
    return { credits };
  } catch (e) { _logWarn('刷新', `getCredits失败: ${e.message}`); }
  return { credits: undefined };
}

/** Refresh all accounts with parallel batching. Optional progress callback(i, total).
 *  Concurrency=3 balances speed vs API rate limits. ~3x faster than sequential. */
async function _refreshAll(progressFn) {
  const accounts = S.am.getAll();
  const CONCURRENCY = 3;
  let completed = 0;
  for (let batch = 0; batch < accounts.length; batch += CONCURRENCY) {
    const slice = accounts.slice(batch, batch + CONCURRENCY);
    const promises = slice.map((_, j) => {
      const idx = batch + j;
      return _refreshOne(idx).then(() => {
        completed++;
        if (progressFn) progressFn(completed - 1, accounts.length);
      });
    });
    await Promise.allSettled(promises);
  }
}

// ========== 号池状态栏 ==========

function _updatePoolBar() {
  if (!S.statusBar || !S.am) return;
  const accounts = S.am.getAll();
  const threshold = _getPreemptiveThreshold();
  const capacityState = _getCapacityState(S.activeIndex, false);
  const lastCapacityResult = capacityState?.lastResult || null;
  const probeFailCount = capacityState?.failCount || 0;
  if (accounts.length === 0) {
    S.statusBar.text = "$(add) 添加账号";
    S.statusBar.color = new vscode.ThemeColor("disabledForeground");
    S.statusBar.tooltip = "号池为空，点击添加账号";
    return;
  }

  const pool = S.am.getPoolStats(threshold);
  const mode = S.auth ? S.auth.getProxyStatus().mode : "?";
  const modeIcon = mode === "relay" ? "☁" : "⚡";

  // v8.2: Clean plain-text quota display (天/周)
  let quotaDisplay = "?";
  let isLow = false;
  if (pool.avgDaily !== null) {
    const dPct = Math.min(100, pool.avgDaily);
    const wPct = pool.avgWeekly !== null ? Math.min(100, pool.avgWeekly) : null;
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

  // 号池健康度
  const poolTag = `${pool.available}/${pool.total}`;
  const boost = _isBoost() ? "⚡" : "";
  const burst = S.burstMode ? "🔥" : "";
  const auto = vscode.workspace.getConfiguration("wam").get("autoRotate", true)
    ? ""
    : "⏸";

  const winCount = _getActiveWindowCount();
  const winTag = winCount > 1 ? ` W${winCount}` : "";
  const tabTag =
    S.cascadeTabCount > CONCURRENT_TAB_SAFE ? ` T${S.cascadeTabCount}` : "";
  S.statusBar.text = `${modeIcon} ${quotaDisplay} ${poolTag}${winTag}${tabTag}${burst}${boost}${auto}`;
  S.statusBar.color = isLow
    ? new vscode.ThemeColor("errorForeground")
    : pool.available === 0
      ? new vscode.ThemeColor("errorForeground")
      : S.burstMode
        ? new vscode.ThemeColor("editorWarning.foreground")
        : new vscode.ThemeColor("testing.iconPassed");

  // v8.4: Official Plan Info style tooltip (MarkdownString)
  const slopeInfo = _slopePredict();
  const vel = _getVelocity();
  const hourlyCount = _getHourlyMsgCount();
  const currentModel = S.currentModelUid || _readCurrentModelUid();

  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.supportHtml = true;
  const L = (...s) => md.appendMarkdown(s.join('') + '\n\n');
  const _fmtDate = (ts) => { const d = new Date(ts); return `${d.getMonth()+1}月${d.getDate()}日 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };

  // ── Active Account (mirrors official Plan Info) ──
  if (S.activeIndex >= 0) {
    const q = S.am.getActiveQuota(S.activeIndex);
    const a = S.am.get(S.activeIndex);
    if (q && a) {
      L(`**${q.plan || '计划'}**`);
      L(`额度按 天/周 重置`);
      if (q.planDays !== null) {
        if (q.planDays > 0) L(`计划剩余 **${q.planDays} 天**`);
        else L(`计划 **已过期**`);
      }
      L(`---`);
      if (q.daily !== null) {
        const used = Math.max(0, 100 - q.daily);
        L(`**天额度已用：** &nbsp;&nbsp; **${used}%**`);
        if (q.dailyResetRaw) L(`重置于 ${_fmtDate(q.dailyResetRaw)}`);
        else if (q.resetCountdown) L(`${q.resetCountdown} 后重置`);
      }
      if (q.weekly !== null) {
        const wUsed = Math.max(0, 100 - q.weekly);
        L(`**周额度已用：** &nbsp;&nbsp; **${wUsed}%**`);
        if (q.weeklyReset) L(`重置于 ${_fmtDate(q.weeklyReset)}`);
        else if (q.weeklyResetCountdown) L(`${q.weeklyResetCountdown} 后重置`);
      }
      if (q.extraBalance !== null) L(`**额外余额：** &nbsp;&nbsp;&nbsp; **$${q.extraBalance.toFixed(2)}**`);
      L(`---`);
      L(`**${q.plan || '计划'}**`);
      L(`${a.email}`);
    }
  }

  // ── Pool Aggregate ──
  L(`---`);
  const poolStatus = [`**${pool.available}**可用 / **${pool.total}**总计`];
  if (pool.depleted > 0) poolStatus.push(`${pool.depleted}耗尽`);
  if (pool.rateLimited > 0) poolStatus.push(`${pool.rateLimited}限流`);
  if (pool.expired > 0) poolStatus.push(`${pool.expired}过期`);
  L(`**号池** &nbsp; ${poolStatus.join(' · ')}`);
  if (pool.avgEffective !== null) L(`均剩 **${pool.avgEffective}%** (${pool.effectiveCount}个账号均值)`);
  if (pool.avgDaily !== null) {
    const parts = [`天 **${pool.avgDaily}%**`];
    if (pool.avgWeekly !== null) parts.push(`周 **${pool.avgWeekly}%**`);
    L(parts.join(' &nbsp; '));
  }
  if (pool.urgentCount > 0) L(`⚠ ${pool.urgentCount}个紧急(≤3天)`);
  if (pool.preResetWasteCount > 0) L(`⚠ ${pool.preResetWasteCount}个即将浪费${pool.preResetWasteTotal}%额度`);

  // ── Runtime & Defense (structured rows) ──
  const hasRuntime = vel > 0 || hourlyCount > 0 || S.switchCount > 0 || slopeInfo !== null || winCount > 1 || S.cascadeTabCount > 1 || S.burstMode;
  const hasDefense = (isOpusModel(currentModel) && S.activeIndex >= 0) || lastCapacityResult || probeFailCount > 0;
  if (hasRuntime) {
    L(`---`);
    L(`**实时监控**`);
    if (vel > 0) L(`消耗速度 &nbsp; **${vel.toFixed(1)}%/min**${_isHighVelocity() ? ' ⚡高速' : ''}`);
    if (hourlyCount > 0) L(`小时消息 &nbsp; **${hourlyCount}/${TIER_MSG_CAP_ESTIMATE}**${_isNearTierCap() ? ' ⚠接近上限' : ''}`);
    if (slopeInfo !== null) L(`趋势预测 &nbsp; **${slopeInfo}%**`);
    if (S.switchCount > 0) L(`已切换 &nbsp; **${S.switchCount}次**`);
    if (winCount > 1) L(`活跃窗口 &nbsp; **${winCount}个**`);
    if (S.cascadeTabCount > 1) L(`并发对话 &nbsp; **${S.cascadeTabCount}个**`);
    if (S.burstMode) L(`🔥 **BURST防护模式**`);
  }
  if (hasDefense) {
    L(`---`);
    L(`**防御状态**`);
    if (isOpusModel(currentModel) && S.activeIndex >= 0) {
      const opusCount = _getOpusMsgCount(S.activeIndex);
      const tierBudget = getModelBudget(currentModel);
      const tierLabel = isThinking1MModel(currentModel) ? 'T1M' : isThinkingModel(currentModel) ? 'T' : 'R';
      L(`Opus预算 &nbsp; **${opusCount}/${tierBudget}条** (${tierLabel})`);
    }
    if (lastCapacityResult) {
      const cap = lastCapacityResult;
      const capIcon = cap.hasCapacity ? '✓' : '✗';
      const capRem = cap.messagesRemaining >= 0 ? cap.messagesRemaining : '?';
      const capMax = cap.maxMessages >= 0 ? cap.maxMessages : '?';
      L(`L5容量 &nbsp; ${capIcon} **${capRem}/${capMax}条** (第${S.capacityProbeCount}次探测)`);
    }
    if (probeFailCount > 0) L(`探测失败 &nbsp; **${probeFailCount}次**连续`);
  }
  L(`---`);
  L(`${mode} · 阈值${threshold}% · 10层防御`);
  S.statusBar.tooltip = md;
}

// ========== 号池命令 (v6.0 精简) ==========

/** 刷新号池 — 全部账号额度 + 自动轮转 */
async function _doRefreshPool(context) {
  const accounts = S.am.getAll();
  if (accounts.length === 0) return;
  S.statusBar.text = "$(sync~spin) 刷新号池...";
  await _refreshAll((i, n) => {
    S.statusBar.text = `$(sync~spin) ${i + 1}/${n}...`;
  });
  // 刷新后自动轮转
  const threshold = _getPreemptiveThreshold();
  if (
    vscode.workspace.getConfiguration("wam").get("autoRotate", true) &&
    S.activeIndex >= 0
  ) {
    const decision = S.am.shouldSwitch(S.activeIndex, threshold);
    if (decision.switch) {
      await _performSwitch(context, { threshold, targetPolicy: 'same_strategy' });
    }
  }
  _updatePoolBar();
  _refreshPanel();
}

// ========== Core: Auth Infrastructure ==========

/** Discover the correct auth injection command at runtime */
async function _discoverAuthCommand() {
  if (S.discoveredAuthCmd) return S.discoveredAuthCmd;
  const allCmds = await vscode.commands.getCommands(true);
  const candidates = [
    ...allCmds.filter(
      (c) => /provideAuthToken.*AuthProvider/i.test(c) && !/Shit/i.test(c),
    ),
    ...allCmds.filter((c) => /provideAuthToken.*Shit/i.test(c)),
    ...allCmds.filter(
      (c) =>
        /windsurf/i.test(c) &&
        /auth/i.test(c) &&
        /token/i.test(c) &&
        c !== "windsurf.loginWithAuthToken",
    ),
  ];
  const seen = new Set();
  const unique = candidates.filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });
  _logInfo(
    "认证",
    `发现${unique.length}个认证命令: [${unique.join(", ")}]`,
  );
  if (unique.length > 0) S.discoveredAuthCmd = unique;
  return unique;
}

/**
 * SAFE: Check account credentials and refresh credits.
 * Does Firebase login + GetPlanStatus only. Does NOT touch Windsurf auth.
 */
async function _checkAccount(context, index) {
  const account = S.am.get(index);
  if (!account) return { ok: false };

  const result = await _refreshOne(index);
  S.activeIndex = index;
  context.globalState.update("wam-current-index", index);
  _updatePoolBar();

  return { ok: true, credits: result.credits, usageInfo: result.usageInfo };
}

/**
 * DISRUPTIVE: Inject auth token into Windsurf to switch active account.
 * WARNING: This WILL disconnect any active Cascade conversation.
 *
 * v5.8.0 Strategy (reverse-engineered from Windsurf 1.108.2):
 *   S0: idToken → PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER (PRIMARY)
 *   S1: OneTimeAuthToken → command (FALLBACK — relay only, legacy)
 *   S2: registerUser apiKey → command (LAST RESORT)
 */
async function injectAuth(context, index) {
  const account = S.am.get(index);
  if (!account) return { ok: false };

  // ═══ v11.0 指纹轮转 + 会话过渡 ═══
  const config = vscode.workspace.getConfiguration("wam");
  if (config.get("rotateFingerprint", true)) {
    _rotateFingerprintForSwitch();
    S.hotResetCount++;
    _logInfo("热重置", `指纹已轮转 (第${S.hotResetCount}次)`);
    // v14.0: 指纹writeFileSync是同步的,200ms足够OS刷新缓冲区
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  let injected = false;
  let method = "none";
  const discoveredCmds = await _discoverAuthCommand();

  // Strategy 0 (PRIMARY — Windsurf 1.108.2+): idToken direct
  try {
    const loginResult = await S.auth.login(account.email, account.password, false);
    const idToken = loginResult?.ok ? loginResult.idToken : await S.auth.getFreshIdToken(account.email, account.password);
    if (idToken) {
      try {
        const result = await vscode.commands.executeCommand(
          "windsurf.provideAuthTokenToAuthProvider",
          idToken,
        );
        if (result && result.error) {
          _logWarn(
            "注入",
            `[S0] 命令返回错误: ${JSON.stringify(result.error)}`,
          );
        } else {
          injected = true;
          method = "S0-provideAuth-idToken";
          _logInfo(
            "注入",
            `[S0] 已注入idToken → 会话: ${result?.session?.account?.label || "未知"}`,
          );
        }
      } catch (e) {
        _logWarn("注入", `[S0] 主命令失败: ${e.message}`);
      }
      // Try discovered commands with idToken
      if (!injected) {
        for (const cmd of discoveredCmds || []) {
          if (injected) break;
          try {
            const result = await vscode.commands.executeCommand(cmd, idToken);
            if (result && result.error) {
              _logWarn(
                "注入",
                `[S0-发现] ${cmd} 返回错误: ${JSON.stringify(result.error)}`,
              );
            } else {
              injected = true;
              method = `S0-${cmd}-idToken`;
              _logInfo("注入", `[S0-发现] 已通过${cmd}注入idToken`);
            }
          } catch {}
        }
      }
    }
  } catch (e) {
    _logWarn("注入", "[S0] idToken注入失败", e.message);
  }

  // Strategy 1 (FALLBACK): OneTimeAuthToken via relay
  if (!injected) {
    try {
      const authToken = await S.auth.getOneTimeAuthToken(
        account.email,
        account.password,
      );
      if (authToken && authToken.length >= 30 && authToken.length <= 200) {
        try {
          await vscode.commands.executeCommand(
            "windsurf.provideAuthTokenToAuthProvider",
            authToken,
          );
          injected = true;
          method = "S1-provideAuth-otat";
          _logInfo(
            "注入",
            "[S1] 已注入OneTimeAuthToken",
          );
        } catch {}
        if (!injected) {
          for (const cmd of discoveredCmds || []) {
            if (injected) break;
            try {
              await vscode.commands.executeCommand(cmd, authToken);
              injected = true;
              method = `S1-${cmd}-otat`;
              _logInfo(
                "注入",
                `[S1-发现] 已通过${cmd}注入OneTimeAuthToken`,
              );
            } catch {}
          }
        }
        if (injected) _writeAuthFilesCompat(authToken);
      }
    } catch (e) {
      _logWarn("注入", "[S1] OneTimeAuthToken降级失败", e.message);
    }
  }

  // Strategy 2: registerUser apiKey via command
  if (!injected) {
    try {
      const regResult = await S.auth.registerUser(
        account.email,
        account.password,
      );
      if (regResult && regResult.apiKey) {
        for (const cmd of discoveredCmds || []) {
          if (injected) break;
          try {
            await vscode.commands.executeCommand(cmd, regResult.apiKey);
            injected = true;
            method = `S2-${cmd}-apiKey`;
            _logInfo("注入", `[S2] 已通过${cmd}注入apiKey`);
          } catch (e) {
            _logError("注入", `[S2] ${cmd}失败`, e.message);
          }
        }
        // Strategy 3 (DB DIRECT-WRITE)
        if (!injected) {
          const dbResult = _dbInjectApiKey(regResult.apiKey);
          if (dbResult.ok) {
            injected = true;
            method = "S3-db-inject";
            _logInfo(
              "注入",
              `[S3] DB直写: ${dbResult.oldPrefix}→${dbResult.newPrefix}`,
            );
            setTimeout(async () => {
              const reload = await vscode.window.showInformationMessage(
                "WAM: 账号已切换(DB注入)。需要重新加载窗口使新账号生效。",
                "立即重载",
                "稍后",
              );
              if (reload === "立即重载") {
                vscode.commands.executeCommand("workbench.action.reloadWindow");
              }
            }, 500);
          } else {
            _logWarn("注入", `[S3] DB注入失败: ${dbResult.error}`);
          }
        }
      }
    } catch (e) {
      _logWarn("注入", "[S2/S3] registerUser+DB降级失败", e.message);
    }
  }

  // ═══ POST-INJECTION STATE REFRESH SEQUENCE ═══
  if (injected) {
    await _postInjectionRefresh();
  }

  return { ok: injected, injected, method };
}

/** Login to account: inject auth → adaptive verify */
async function _loginToAccount(context, index) {
  const account = S.am.get(index);
  if (!account) return;

  S.activeIndex = index;
  context.globalState.update("wam-current-index", index);

  const apiKeyBefore = _readAuthApiKeyPrefix();
  const injectResult = await injectAuth(context, index);

  if (injectResult.injected) {
    const changed = await _waitForApiKeyChange(apiKeyBefore, 2000);
    _logInfo(
      "登录",
      `✅ ${injectResult.method} → #${index + 1} | apiKey ${changed ? "已更新" : "未变"}`,
    );
  }

  S.am.incrementLoginCount(index);
  _updatePoolBar();
}

/** v14.0: 自适应等待apiKey变化 */
async function _waitForApiKeyChange(oldPrefix, maxWaitMs = 2000) {
  const interval = 200;
  const maxAttempts = Math.ceil(maxWaitMs / interval);
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, interval));
    if (_readAuthApiKeyPrefix() !== oldPrefix) return true;
  }
  return false;
}

// ========== Auth File Compatibility (v4.0) ==========
function _writeAuthFilesCompat(authToken) {
  if (!authToken || authToken.length < 30 || authToken.length > 60) return;
  try {
    const gsPath = _getWindsurfGlobalStoragePath();
    if (!fs.existsSync(gsPath)) return;
    const authData = JSON.stringify(
      {
        authToken,
        token: authToken,
        api_key: authToken,
        timestamp: Date.now(),
      },
      null,
      2,
    );
    fs.writeFileSync(path.join(gsPath, "windsurf-auth.json"), authData, "utf8");
    fs.writeFileSync(path.join(gsPath, "cascade-auth.json"), authData, "utf8");
    _logInfo("认证", "认证文件已写入(跨扩展兼容)");
  } catch (e) {
    _logWarn("认证", "认证文件写入跳过", e.message);
  }
}

// ========== Post-Injection State Refresh ==========

async function _postInjectionRefresh() {
  try {
    // Step 1: 清除旧的cachedPlanInfo
    _clearCachedPlanInfo();

    // Step 2+3: 并行执行PlanInfo刷新和认证会话刷新
    const refreshTasks = [
      vscode.commands.executeCommand("windsurf.updatePlanInfo").catch(() => {}),
      vscode.commands.executeCommand("windsurf.refreshAuthenticationSession").catch(() => {}),
    ];
    await Promise.allSettled(refreshTasks);
    _logInfo("注入后刷新", "已并行刷新PlanInfo+认证会话");

    // Step 4: 短暂等待Windsurf内部状态同步
    await new Promise((r) => setTimeout(r, 500));

    // Step 5: 验证apiKey已更新
    const newApiKey = _readAuthApiKeyPrefix();
    _logInfo("注入后刷新", `刷新后apiKey: ${newApiKey?.slice(0, 16) || "未知"}`);

    // Step 6: 异步验证热重置
    if (S.lastRotatedIds) {
      setTimeout(() => {
        try {
          const verify = hotVerify(S.lastRotatedIds);
          if (verify.verified) {
            S.hotResetVerified++;
            _logInfo("热重置", `✅ 验证成功 (#${S.hotResetVerified}/${S.hotResetCount})`);
          }
        } catch {}
      }, 3000);
    }
  } catch (e) {
    _logWarn("注入后刷新", "刷新序列异常(非关键)", e.message);
  }
}

function _clearCachedPlanInfo() {
  try {
    const dbPath = getStateDbPath();
    if (!fs.existsSync(dbPath)) return;
    if (dbDeleteKey(dbPath, 'windsurf.settings.cachedPlanInfo')) {
      _logInfo("缓存", "已清除state.vscdb中的cachedPlanInfo");
    } else {
      _logWarn("缓存", "缓存清除跳过(非关键)");
    }
  } catch (e) {
    _logWarn("缓存", "清除cachedPlanInfo异常", e.message);
  }
}

function _dbInjectApiKey(newApiKey) {
  try {
    const dbPath = getStateDbPath();
    if (!fs.existsSync(dbPath))
      return { ok: false, error: "state.vscdb not found" };

    const currentJson = dbReadKey(dbPath, 'windsurfAuthStatus');
    if (!currentJson)
      return { ok: false, error: "windsurfAuthStatus not found" };

    const data = JSON.parse(currentJson);
    const oldPrefix = (data.apiKey || "").substring(0, 20);
    data.apiKey = newApiKey;

    const ok = dbTransaction(dbPath, [
      { type: 'write', key: 'windsurfAuthStatus', value: JSON.stringify(data) },
      { type: 'delete', key: 'windsurf.settings.cachedPlanInfo' },
    ]);
    if (!ok) return { ok: false, error: "write failed" };

    const newPrefix = newApiKey.substring(0, 20);
    _logInfo("数据库", `apiKey更新: ${oldPrefix}→${newPrefix}`);
    return { ok: true, oldPrefix, newPrefix };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function _readAuthApiKeyPrefix() {
  try {
    const dbPath = getStateDbPath();
    if (!fs.existsSync(dbPath)) return null;
    const raw = dbReadKey(dbPath, 'windsurfAuthStatus');
    if (!raw) return null;
    const d = JSON.parse(raw);
    return (d.apiKey || "").substring(0, 20) || null;
  } catch {
    return null;
  }
}

// ========== Fingerprint Rotation on Switch ==========

function _rotateFingerprintForSwitch() {
  try {
    const result = resetFingerprint({ backup: false });
    if (!result.ok) {
      _logWarn("指纹", "轮转失败", result.error);
      return;
    }
    const oldId = result.old["storage.serviceMachineId"]?.slice(0, 8) || "?";
    const newId = result.new["storage.serviceMachineId"]?.slice(0, 8) || "?";
    S.lastRotatedIds = result.new;
    _logInfo("指纹", `已轮转: ${oldId}→${newId} (已保存待验证)`);

    const dbPath = getStateDbPath();
    if (!fs.existsSync(dbPath)) return;

    const dbKeys = [
      "storage.serviceMachineId",
      "telemetry.devDeviceId",
      "telemetry.machineId",
      "telemetry.macMachineId",
      "telemetry.sqmId",
    ];
    const pairs = dbKeys
      .filter((k) => result.new[k])
      .map((k) => ({ key: k, value: result.new[k] }));

    if (pairs.length === 0) return;

    try {
      if (dbUpdateKeys(dbPath, pairs)) {
        _logInfo("指纹", "state.vscdb已更新(运行时生效)");
      } else {
        _logWarn("指纹", "state.vscdb更新跳过(非关键)");
      }
    } catch (e) {
      _logWarn("指纹", "state.vscdb更新跳过(非关键)", e.message);
    }
  } catch (e) {
    _logWarn("指纹", "指纹轮转异常(非关键)", e.message);
  }
}

// ========== Webview动作处理器 ==========

function _handleAction(context, action, arg) {
  switch (action) {
    case "login":
      return _seamlessSwitch(context, arg);
    case "checkAccount":
      return _checkAccount(context, arg);
    case "explicitSwitch":
      return _seamlessSwitch(context, arg);
    case "refreshAll":
      return _doRefreshPool(context);
    case "refreshOne":
      return _refreshOne(arg).then(() => {
        _updatePoolBar();
        _refreshPanel();
      });
    case "clearRateLimit":
      if (arg !== undefined) {
        S.am.clearRateLimit(arg);
        _clearAccountQuarantine(arg);
        // v13.1: 清限流时也清Trial池冷却+降级锁,允许恢复Opus
        schedulerState.poolCooldowns.clear();
        _syncSchedulerToShared();
        S.downgradeLockUntil = 0;
        S.lastTrialPoolCooldownFailTs = 0;
        _updatePoolBar();
        _refreshPanel();
      }
      return;
    case "getCurrentIndex":
      return S.activeIndex;
    case "getProxyStatus":
      return S.auth ? S.auth.getProxyStatus() : { mode: "?", port: 0 };
    case "getPoolStats":
      return S.am.getPoolStats(_getPreemptiveThreshold());
    case "getActiveQuota":
      return S.am.getActiveQuota(S.activeIndex);
    case "getSwitchCount":
      return S.switchCount;
    case "getAccountBlocked": {
      if (arg === undefined || arg === null) return null;
      const quarantine = _getAccountQuarantineByEmail(_getAccountEmail(arg));
      const modelUid = S.currentModelUid || _readCurrentModelUid();
      const poolCd = _isTrialLikeAccount(arg) ? _getTrialPoolCooldown(modelUid) : null;
      if (!quarantine && !poolCd) return null;
      return {
        quarantined: quarantine ? { until: quarantine.until, reason: quarantine.reason || null } : null,
        poolCooled: poolCd ? { until: poolCd.until, reason: poolCd.reason || null } : null,
      };
    }
    case "setMode":
      if (S.auth && arg) {
        S.auth.setMode(arg);
        context.globalState.update("wam-proxy-mode", arg);
        _updatePoolBar();
        _refreshPanel();
      }
      return;
    case "setProxyPort":
      if (S.auth && arg) {
        S.auth.setPort(arg);
        context.globalState.update("wam-proxy-mode", "local");
        _updatePoolBar();
        _refreshPanel();
      }
      return;
    case "reprobeProxy":
      if (S.auth)
        return S.auth.reprobeProxy().then((r) => {
          context.globalState.update("wam-proxy-mode", r.mode);
          _updatePoolBar();
          _refreshPanel();
          return r;
        });
      return;
    case "exportAccounts":
      return _doExport(context);
    case "importAccounts":
      return _doImport(context);
    case "resetFingerprint":
      return _doResetFingerprint();
    case "panicSwitch":
      return _doPoolRotate(context, true);
    case "batchAdd":
      return _doBatchAdd(arg);
    case "refreshAllAndRotate":
      return _doRefreshPool(context);
    case "getFingerprint":
      return readFingerprint();
    case "smartRotate":
      return _doPoolRotate(context);
    case "setAutoRotate":
      if (arg !== undefined)
        vscode.workspace
          .getConfiguration("wam")
          .update("autoRotate", !!arg, true);
      return;
    case "setCreditThreshold":
    case "setPreemptiveThreshold":
      if (arg !== undefined) {
        const next = Math.max(0, Math.min(100, Number(arg) || 0));
        return vscode.workspace
          .getConfiguration("wam")
          .update("preemptiveThreshold", next, true)
          .then(() => {
            _updatePoolBar();
            _refreshPanel();
          });
      }
      return;
  }
}

// ========== 号池其他命令 ==========

async function _doResetFingerprint() {
  const confirm = await vscode.window.showWarningMessage(
    "重置设备指纹？下次切号时自动热生效(无需重启Windsurf)。",
    "重置",
    "取消",
  );
  if (confirm !== "重置") return;
  const result = resetFingerprint();
  if (result.ok) {
    S.lastRotatedIds = result.new;
    vscode.window.showInformationMessage(
      "WAM: ✅ 指纹已重置，下次切号时热生效(无需重启)。",
    );
  } else {
    vscode.window.showErrorMessage(`WAM: 重置失败: ${result.error}`);
  }
}

async function _doImport(context) {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "WAM Backup": ["json"] },
    title: "导入号池备份",
  });
  if (!uris || !uris.length) return;
  try {
    const r = S.am.importFromFile(uris[0].fsPath);
    vscode.window.showInformationMessage(
      `WAM: 导入 +${r.added} ↻${r.updated} =${r.total}`,
    );
    _refreshPanel();
  } catch (e) {
    vscode.window.showErrorMessage(`WAM: 导入失败: ${e.message}`);
  }
}

async function _doExport(context) {
  if (S.am.count() === 0) return;
  try {
    const fpath = S.am.exportToFile(context.globalStorageUri.fsPath);
    vscode.window
      .showInformationMessage(`WAM: ✅ 已导出 ${S.am.count()} 个账号`, "打开目录")
      .then((sel) => {
        if (sel)
          vscode.commands.executeCommand(
            "revealFileInOS",
            vscode.Uri.file(fpath),
          );
      });
  } catch (e) {
    vscode.window.showErrorMessage(`WAM: 导出失败: ${e.message}`);
  }
}

async function _doSwitchMode(context) {
  const status = S.auth.getProxyStatus();
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "$(globe) 本地代理",
        description: `端口 ${status.port}`,
        value: "local",
      },
      { label: "$(cloud) 网络中转", description: "无需VPN", value: "relay" },
    ],
    { placeHolder: `当前: ${status.mode}` },
  );
  if (pick) {
    S.auth.setMode(pick.value);
    context.globalState.update("wam-proxy-mode", pick.value);
    _updatePoolBar();
    _refreshPanel();
  }
}

async function _doBatchAdd(textFromWebview) {
  let text = textFromWebview;
  if (!text) {
    text = await vscode.window.showInputBox({
      prompt: "粘贴卖家消息，自动识别账号密码",
      placeHolder: "支持: 卡号/卡密 | 账号/密码 | email:pass | email----pass",
      value: "",
    });
  }
  if (!text) return { added: 0, skipped: 0 };

  const result = S.am.addBatch(text);
  if (result.added > 0) {
    _logInfo("批量添加", `已添加${result.added}个账号(智能解析)`);
  }
  _refreshPanel();
  return result;
}

// ========== Init Workspace (智慧部署 + 源启动) ==========

async function _doInitWorkspace(context) {
  const wsFolders = vscode.workspace.workspaceFolders;
  const defaultPath =
    wsFolders && wsFolders.length > 0 ? wsFolders[0].uri.fsPath : "";

  const targetPath = await vscode.window.showInputBox({
    prompt: "目标工作区路径 (智慧部署)",
    placeHolder: defaultPath || "输入工作区绝对路径",
    value: defaultPath,
  });
  if (targetPath === undefined) return;

  const action = await vscode.window.showQuickPick(
    [
      { label: "🔍 扫描", description: "查看智慧模板安装状态", value: "scan" },
      {
        label: "⬇ 注入智慧框架",
        description: "部署规则+技能+工作流到目标工作区",
        value: "inject",
      },
      {
        label: "⬇ 注入(覆盖)",
        description: "覆盖已有文件重新注入",
        value: "inject_overwrite",
      },
      {
        label: "✨ 生成源启动提示词",
        description: "生成激活认知框架的初始提示词",
        value: "prompt",
      },
      {
        label: "🖥 检测环境",
        description: "检测IDE/OS/MCP/Python环境",
        value: "detect",
      },
      {
        label: "🌐 打开智慧部署器",
        description: "在浏览器打开 http://localhost:9876/",
        value: "browser",
      },
    ],
    { placeHolder: "选择操作", title: "工作区配置向导" },
  );

  if (!action) return;

  if (action.value === "browser") {
    vscode.env.openExternal(vscode.Uri.parse("http://localhost:9876/"));
    vscode.window.showInformationMessage(
      "WAM: 已打开智慧部署器 (需先启动: python 安全管理/windsurf_wisdom.py serve)",
    );
    return;
  }

  const base = "http://127.0.0.1:9876";
  const targ = targetPath.trim();

  const callApi = (apiPath, method = "GET", body = null) =>
    new Promise((resolve, reject) => {
      const url = new URL(base + apiPath);
      const bodyStr = body ? JSON.stringify(body) : null;
      const options = {
        hostname: url.hostname,
        port: parseInt(url.port) || 80,
        path: url.pathname + url.search,
        method,
        headers: bodyStr
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(bodyStr),
            }
          : {},
        timeout: 10000,
      };
      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (d) => {
          data += d;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ raw: data });
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });

  const tq = targ ? "?target=" + encodeURIComponent(targ) : "";

  try {
    if (action.value === "scan") {
      const r = await callApi("/api/scan" + tq);
      const ins = (r.exists || []).length;
      const mis = (r.missing || []).length;
      vscode.window
        .showInformationMessage(
          `WAM: 扫描 — ${ins}已安装 / ${mis}缺失\n${(r.missing || [])
            .slice(0, 5)
            .map((x) => "❌ " + x.key)
            .join(", ")}`,
          mis > 0 ? "注入缺失项" : "已完整",
        )
        .then((sel) => {
          if (sel === "注入缺失项") _doInitWorkspace(context);
        });
    } else if (
      action.value === "inject" ||
      action.value === "inject_overwrite"
    ) {
      const r = await callApi("/api/inject", "POST", {
        target: targ || undefined,
        overwrite: action.value === "inject_overwrite",
      });
      vscode.window.showInformationMessage(
        `WAM: 注入完成 — ${r.summary}\n注入项: ${(r.injected || [])
          .slice(0, 8)
          .map((x) => x.key)
          .join(", ")}`,
      );
    } else if (action.value === "prompt") {
      const r = await callApi("/api/prompt" + tq);
      const prompt = r.prompt || "";
      await vscode.env.clipboard.writeText(prompt);
      vscode.window
        .showInformationMessage(
          `WAM: 源启动提示词已生成并复制到剪贴板！(${r.ide} / ${(r.installed.rules || []).length}规则 / ${(r.installed.skills || []).length}技能)`,
          "打开智慧部署器",
        )
        .then((sel) => {
          if (sel === "打开智慧部署器")
            vscode.env.openExternal(vscode.Uri.parse("http://localhost:9876/"));
        });
    } else if (action.value === "detect") {
      const r = await callApi("/api/detect" + tq);
      const mcps = Object.entries(r.mcps_installed || {})
        .map(([k, v]) => (v ? "✅" : "❌") + k)
        .join(" ");
      vscode.window.showInformationMessage(
        `WAM: 环境 — IDE:${r.ide} OS:${r.os} Python:${r.python_ok ? "✅" : "❌"} 安全中枢:${r.security_hub_running ? "✅" : "❌"}\nMCP: ${mcps}`,
      );
    }
  } catch (e) {
    // Server unavailable → fall back to embedded bundle injection
    if (
      action.value === "inject" ||
      action.value === "inject_overwrite" ||
      action.value === "scan"
    ) {
      await _doEmbeddedWisdom(context, targ, action.value);
    } else {
      const choice = await vscode.window.showWarningMessage(
        "WAM: 智慧部署服务未运行。已切换到内置模板模式。\n可直接注入47个智慧模板(规则+技能+工作流)。",
        "内置注入",
        "启动服务器",
        "取消",
      );
      if (choice === "内置注入") {
        await _doEmbeddedWisdom(context, targ, "inject");
      } else if (choice === "启动服务器") {
        const terminal = vscode.window.createTerminal("智慧部署器");
        terminal.sendText("python 安全管理/windsurf_wisdom.py serve");
        terminal.show();
      }
    }
  }
}

// ========== Embedded Wisdom Bundle ==========

function _loadWisdomBundle(context) {
  try {
    const bundlePath = path.join(
      path.dirname(__dirname),
      "data",
      "wisdom_bundle.json",
    );
    if (fs.existsSync(bundlePath)) {
      return JSON.parse(fs.readFileSync(bundlePath, "utf8"));
    }
    const extPath = context.extensionPath || context.extensionUri?.fsPath;
    if (extPath) {
      const altPath = path.join(extPath, "data", "wisdom_bundle.json");
      if (fs.existsSync(altPath)) {
        return JSON.parse(fs.readFileSync(altPath, "utf8"));
      }
    }
  } catch (e) {
    _logError("WISDOM", "failed to load wisdom bundle", e.message);
  }
  return null;
}

async function _doEmbeddedWisdom(context, targetPath, action) {
  const bundle = _loadWisdomBundle(context);
  if (!bundle || !bundle.templates) {
    vscode.window.showErrorMessage("WAM: 智慧模板包未找到。请重新安装插件。");
    return;
  }

  const root =
    targetPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
  if (!root) {
    vscode.window.showWarningMessage("WAM: 未指定目标工作区。");
    return;
  }

  const templates = bundle.templates;
  const overwrite = action === "inject_overwrite";

  if (action === "scan") {
    let exists = 0,
      missing = 0;
    const missingList = [];
    for (const [key, tmpl] of Object.entries(templates)) {
      const fpath = path.join(root, tmpl.path);
      if (fs.existsSync(fpath)) {
        exists++;
      } else {
        missing++;
        missingList.push(key);
      }
    }
    const sel = await vscode.window.showInformationMessage(
      `WAM: 扫描(内置) — ${exists}已安装 / ${missing}缺失 / ${Object.keys(templates).length}总计\n` +
        `缺失: ${missingList.slice(0, 8).join(", ")}${missingList.length > 8 ? "..." : ""}`,
      missing > 0 ? "注入缺失项" : "已完整",
    );
    if (sel === "注入缺失项") {
      await _doEmbeddedWisdom(context, root, "inject");
    }
    return;
  }

  const catPick = await vscode.window.showQuickPick(
    [
      {
        label: "🌟 全部注入",
        description: `${Object.keys(templates).length}个模板`,
        value: "all",
      },
      {
        label: "📐 仅规则",
        description: "kernel + protocol (Agent行为框架)",
        value: "rule",
      },
      {
        label: "🎯 仅技能",
        description: "32个通用技能 (错误诊断/代码质量/Git等)",
        value: "skill",
      },
      {
        label: "🔄 仅工作流",
        description: "13个工作流 (审查/循环/开发等)",
        value: "workflow",
      },
      {
        label: "🔧 选择性注入",
        description: "手动选择要注入的模板",
        value: "pick",
      },
    ],
    { placeHolder: `注入到: ${root}`, title: "选择注入范围" },
  );
  if (!catPick) return;

  let selectedKeys;
  if (catPick.value === "all") {
    selectedKeys = Object.keys(templates);
  } else if (catPick.value === "pick") {
    const items = Object.entries(templates).map(([key, tmpl]) => ({
      label: `${tmpl.category === "rule" ? "📐" : tmpl.category === "skill" ? "🎯" : "🔄"} ${key}`,
      description: tmpl.desc.slice(0, 60),
      picked: true,
      key,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: "选择要注入的模板",
      title: `${items.length}个可用模板`,
    });
    if (!picked || picked.length === 0) return;
    selectedKeys = picked.map((p) => p.key);
  } else {
    selectedKeys = Object.entries(templates)
      .filter(([_, t]) => t.category === catPick.value)
      .map(([k]) => k);
  }

  let injected = 0,
    skipped = 0,
    errors = 0;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "WAM: 注入智慧模板",
      cancellable: false,
    },
    async (progress) => {
      for (let i = 0; i < selectedKeys.length; i++) {
        const key = selectedKeys[i];
        const tmpl = templates[key];
        if (!tmpl) continue;
        progress.report({
          message: `${key} (${i + 1}/${selectedKeys.length})`,
          increment: 100 / selectedKeys.length,
        });

        const fpath = path.join(root, tmpl.path);
        if (fs.existsSync(fpath) && !overwrite) {
          skipped++;
          continue;
        }

        try {
          const dir = path.dirname(fpath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(fpath, tmpl.content, "utf8");
          if (tmpl.supporting) {
            const parentDir = path.dirname(fpath);
            for (const [sfName, sfContent] of Object.entries(tmpl.supporting)) {
              fs.writeFileSync(path.join(parentDir, sfName), sfContent, "utf8");
            }
          }
          injected++;
        } catch (e) {
          errors++;
          _logError("WISDOM", `inject ${key} failed`, e.message);
        }
      }
    },
  );

  vscode.window.showInformationMessage(
    `WAM: 注入完成 — ${injected}成功 / ${skipped}跳过 / ${errors}失败\n` +
      `路径: ${root}/.windsurf/`,
  );
}

// ========== Deactivation ==========

function deactivate() {
  _deregisterWindow();
  if (S.poolTimer) { clearTimeout(S.poolTimer); S.poolTimer = null; }
  if (S.windowTimer) { clearInterval(S.windowTimer); S.windowTimer = null; }
  if (S.am) S.am.dispose();
  if (S.auth) S.auth.dispose();
  if (S.statusBar) S.statusBar.dispose();
}

export { activate, deactivate };
