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
 *   shared/config.js         — 常量/正则/模型辅助函数
 *   core/state.js            — 共享可变状态 + 调度运行时 + 日志 + deps注册
 *   core/window.js           — 多窗口心跳/共享状态读写
 *   core/model.js            — Opus守卫/模型降级/变体轮转
 *   core/defense.js          — L1-L5检测/限流分类/容量探测
 *   core/scheduler.js        — _poolTick/evaluateActiveAccount/_performSwitch
 *   services/authInjector.js — 认证注入链
 *   ui/statusbar.js          — 状态栏渲染
 *   ui/actions.js            — Webview 动作路由
 *   ui/wisdom.js             — 智慧模板部署
 */
import vscode from 'vscode';
import { AccountManager } from './services/account.js';
import { AuthService } from './services/auth.js';
import { openAccountPanel, AccountViewProvider } from './ui/webview.js';
import {
  resetFingerprint,
  ensureComplete as ensureFingerprintComplete,
} from './services/fingerprint.js';
import { createAuthInjector } from './services/authInjector.js';
import { createActionHandler } from './ui/actions.js';
import { _updatePoolBar as renderStatusBar } from './ui/statusbar.js';
import { _doInitWorkspace } from './ui/wisdom.js';

import {
  S,
  deps,
  _getPreemptiveThreshold,
  _logInfo,
  _logWarn,
  _logError,
  _logDebug,
  _refreshPanel,
  _configureFileLogger,
} from './core/state.js';
import { L5_ENABLED } from './shared/config.js';
import { usageFromCachedQuota } from './shared/quota.js';
import {
  _deregisterWindow,
  _getActiveWindowCount,
  _startWindowCoordinator,
  _syncSchedulerToShared,
} from './core/window.js';
import {
  _startPoolEngine, _performSwitch, _seamlessSwitch,
  _doPoolRotate,
  _trackMessageRate,
  _detectCascadeTabs,
} from './core/scheduler.js';
import {
  configureRefreshQueue,
  enqueueRefresh,
  enqueueRefreshAll,
  getRefreshQueueStatus,
} from './core/refreshQueue.js';

const authInjector = createAuthInjector({
  refreshOne: _refreshOne,
  updatePoolBar: renderStatusBar,
});

const { injectAuth, _checkAccount, _loginToAccount } = authInjector;
const BATCH_IMPORT_VERIFY_LANE = 'batch_import_verify';
const BATCH_IMPORT_VERIFY_GAP_MS = 3000;
const BATCH_IMPORT_ENQUEUE_DELAY_MS = 1500;
const AUTH_REFRESH_CIRCUIT_MS = 30 * 60 * 1000;

function _usageBelongsToAccount(account, usageInfo) {
  const observed = usageInfo?.userEmail ? String(usageInfo.userEmail).trim().toLowerCase() : null;
  if (!observed) return true;
  return observed === String(account?.email || '').trim().toLowerCase();
}

function _isAuthRateLimitError(resultOrError) {
  const text = String(resultOrError?.error || resultOrError?.message || resultOrError || '').toLowerCase();
  return (
    text.includes('too_many_attempts_try_later') ||
    text.includes('too-many-requests') ||
    text.includes('too many requests') ||
    text.includes('http 429') ||
    (text.includes('firebase') && text.includes('429'))
  );
}

function _isLowPriorityRefresh(job = {}) {
  return job.priority === 'low' || job.reason === 'full_scan' || job.reason === 'panic_post_refresh';
}

function _tripRefreshCircuit(reason) {
  S.refreshCircuitUntil = Date.now() + AUTH_REFRESH_CIRCUIT_MS;
  S.refreshCircuitReason = reason || 'auth_rate_limited';
  _logWarn('刷新熔断', `检测到认证限流，低优先级批量刷新暂停${Math.round(AUTH_REFRESH_CIRCUIT_MS / 60000)}分钟 (${S.refreshCircuitReason})`);
}

function _refreshJobOptions(index, options = {}) {
  const account = S.am?.get(index);
  const email = account?.email ? account.email.trim() : null;
  return {
    ...options,
    key: email ? email.toLowerCase() : `index:${index}`,
    email,
  };
}

async function _runRefreshJob(index, job = {}) {
  const preferLocal = job.reason === 'full_scan' || job.reason === 'switch_preheat' || job.reason === 'manual_full_scan';
  // During password-channel circuit-break, low-priority jobs may still run cache-only
  // (cache reads + active-account apiKey are not affected by Firebase auth rate limits).
  const circuitTripped = _isLowPriorityRefresh(job) && S.refreshCircuitUntil > Date.now();
  const refreshOptions = { preferLocal, reason: job.reason, cacheOnly: circuitTripped };
  if (job.email) {
    const current = S.am.findByEmail(job.email);
    if (!current) {
      _logWarn('刷新队列', `账号已不存在，跳过 ${job.email}`);
      return { skipped: true, reason: 'account_missing', index: -1, email: job.email };
    }
    const result = await _refreshOne(current.index, refreshOptions);
    if (_isAuthRateLimitError(result)) _tripRefreshCircuit(result.error);
    return { ...result, index: current.index, email: job.email };
  }
  const result = await _refreshOne(index, refreshOptions);
  if (_isAuthRateLimitError(result)) _tripRefreshCircuit(result.error);
  return { ...result, index };
}

const _handleAction = createActionHandler({
  checkAccount: _checkAccount,
  doBatchAdd: _doBatchAdd,
  doExport: _doExport,
  doImport: _doImport,
  doRefreshPool: _doRefreshPool,
  doResetFingerprint: _doResetFingerprint,
  refreshOne: (index) => enqueueRefresh(index, _refreshJobOptions(index, { priority: 'high', reason: 'manual_refresh_one' })),
  refreshPanel: _refreshPanel,
  updatePoolBar: renderStatusBar,
});

// ═══ deps 注册 (打破循环依赖) ═══
function _wireDeps() {
  configureRefreshQueue({
    worker: _runRefreshJob,
    concurrency: 3,
    // enqueue events intentionally silent — downstream [额度] line carries the signal
  });
  deps.loginToAccount = _loginToAccount;
  deps.refreshOne = (index, options) => enqueueRefresh(index, _refreshJobOptions(index, options));
  deps.refreshAll = _refreshAll;
  deps.getRefreshQueueStatus = getRefreshQueueStatus;
  deps.doPoolRotate = _doPoolRotate;
  deps.updatePoolBar = _updatePoolBar;
  deps.syncSchedulerToShared = _syncSchedulerToShared;
  deps.performSwitch = _performSwitch;
  deps.trackMessageRate = _trackMessageRate;
}

function _updatePoolBar() {
  return renderStatusBar();
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
  _configureFileLogger(context.logUri?.fsPath);
  const _version = context.extension?.packageJSON?.version || '?';
  _logInfo(
    "启动",
    `WAM 号池引擎 v${_version} 启动中...`,
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
  S.auth.setLogger(
    (tag, msg) => _logInfo(tag, msg),
    (tag, msg) => _logWarn(tag, msg),
    (tag, msg) => _logDebug(tag, msg),
  );
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
  const savedPendingIndex = context.globalState.get("wam-pending-index", -1);
  const savedPendingEmail = context.globalState.get("wam-pending-email", null);
  const accounts = S.am.getAll();
  if (savedIndex >= 0 && savedIndex < accounts.length)
    S.activeIndex = savedIndex;
  const restoredPendingByEmail = savedPendingEmail ? S.am.findByEmail(savedPendingEmail) : null;
  const restoredPendingIndex = restoredPendingByEmail?.index ?? savedPendingIndex;
  if (restoredPendingIndex >= 0 && restoredPendingIndex < accounts.length) {
    S.pendingSwitchIndex = restoredPendingIndex;
    S.pendingSwitchEmail = savedPendingEmail || accounts[restoredPendingIndex]?.email || null;
    S.switchStatus = {
      ...S.switchStatus,
      phase: 'uncertain',
      pendingIndex: restoredPendingIndex,
      confirmedIndex: -1,
      targetEmail: S.pendingSwitchEmail,
      message: '等待运行时确认',
      updatedAt: Date.now(),
    };
    _logWarn('启动', `恢复待确认切换 #${restoredPendingIndex + 1}`);
  }
  _updatePoolBar();
  S.statusBar.show();

  // 恢复代理 — 模式 + 上次成功端口 (作为下次探测的快路径)
  const savedMode = context.globalState.get("wam-proxy-mode", null);
  if (savedMode) S.auth.setMode(savedMode);
  const savedPort = context.globalState.get("wam-proxy-port", 0);
  if (savedPort > 0) S.auth.setLastKnownPort(savedPort);

  // 后台代理探测
  setTimeout(() => {
    if (!S.auth) return;
    S.auth
      .reprobeProxy()
      .then((r) => {
        if (r.port > 0) {
          context.globalState.update("wam-proxy-mode", r.mode);
          // Only persist port when actually using local proxy (relay mode port is stale/meaningless)
          if (r.mode === "local") context.globalState.update("wam-proxy-port", r.port);
        }
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
      if (r.mode === "local" && r.port > 0) {
        context.globalState.update("wam-proxy-port", r.port);
      }
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
  // v20.3: 合并原本 2 行启动日志 — 检测层已由 defense.js 打印一次，此处不重复
  _logInfo(
    "启动",
    `✅ 就绪 v${_version} | 账号:${accounts.length} 代理:${proxyInfo.mode}:${proxyInfo.port} 窗口:${winCount} 对话:${S.cascadeTabCount}${S.burstMode ? ' (BURST)' : ''}`,
  );
}

// ========== Refresh Helpers ==========

/** Refresh one account's usage/credits. Returns { credits, usageInfo }
 *  v5.11.0: Supplements QUOTA data from cachedPlanInfo when API doesn't return daily% */
async function _refreshOne(index, options = {}) {
  const account = S.am.get(index);
  if (!account) return { ok: false, credits: undefined, errorType: 'account_missing' };
  try {
    if (options.preferLocal && S.auth?.readCachedQuota) {
      const cached = S.auth.readCachedQuota(account.email, {
        silent: true,
        source: options.reason || 'refresh',
      });
      if (cached) {
        const usageInfo = usageFromCachedQuota(cached, account.usage);
        S.am.updateUsage(index, usageInfo);
        return { ok: true, credits: usageInfo.credits, usageInfo, source: 'local' };
      }
    }
    // cacheOnly mode (circuit-tripped): only cache reads allowed, skip all network paths.
    if (options.cacheOnly) {
      return { ok: true, skipped: true, errorType: 'cache_miss', source: 'cache_only_skip' };
    }
    // v20.3: full_scan 场景走 quiet 模式 — 每账号详细日志降为 DEBUG，摘要由 scheduler 打印
    const authOptions = options.reason === 'full_scan' ? { ...options, quiet: true } : options;
    const usageInfo = await S.auth.getUsageInfo(account.email, account.password, authOptions);
    if (usageInfo?.ok === false) {
      if (usageInfo.cacheOnly) {
        return { ok: true, skipped: true, errorType: 'cache_miss' };
      }
      if (usageInfo.errorType === 'invalid_credentials') {
        S.am.markAuthError(index, 'invalid_credentials', usageInfo.error);
        _logWarn('账号验证', `#${index + 1} 登录凭据无效，已标记坏号`);
      }
      return { ok: false, credits: undefined, errorType: usageInfo.errorType, error: usageInfo.error };
    }
    if (usageInfo) {
      if (!_usageBelongsToAccount(account, usageInfo)) {
        _logWarn('额度写入', `拒绝写入 #${index + 1}: 返回账号=${usageInfo.userEmail || 'n/a'} 目标=${account.email}`);
        return { ok: false, credits: undefined, errorType: 'account_mismatch', error: 'quota_result_account_mismatch' };
      }
      // v5.11.0+v6.9: Supplement from cachedPlanInfo for active account (single read)
      if (index === S.activeIndex && S.auth) {
        try {
          const cached = S.auth.readCachedQuota(account.email);
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
      // v20.2: lazy fetch precise teamsTier from GetUserStatus (once per 24h per account)
      _maybeEnrichUserStatus(index).catch(() => {});
      return { ok: true, credits: usageInfo.credits, usageInfo };
    }
  } catch (e) { _logWarn('刷新', `getUsageInfo失败: ${e.message}`); }
  return { ok: false, credits: undefined, errorType: 'refresh_failed' };
}

/** v20.2: Enrich account.usage with precise teamsTier via GetUserStatus.
 *  Runs async after _refreshOne, only when stale. Failure is silent. */
const USER_STATUS_TTL = 24 * 60 * 60 * 1000;  // 24h
async function _maybeEnrichUserStatus(index) {
  // readCurrentApiKey() returns active session's key — only safe for active account
  if (index !== S.activeIndex) return;
  const account = S.am.get(index);
  if (!account?.usage) return;
  const age = Date.now() - (account.usage.teamsTierCheckedAt || 0);
  if (account.usage.teamsTier !== undefined && age < USER_STATUS_TTL) return;
  const apiKey = S.auth?.readCurrentApiKey?.();
  if (!apiKey) return;
  try {
    const status = await S.auth.getUserStatus(apiKey, { quiet: true });
    if (!status) return;
    const merged = {
      ...account.usage,
      teamsTier: status.teamsTier,
      tierName: status.tierName,
      tierLabel: status.tierLabel,
      teamsTierCheckedAt: Date.now(),
    };
    S.am.updateUsage(index, merged);
  } catch {}
}

/** Refresh all accounts through the shared queue.
 *  Manual callers await completion; scheduler can pass { wait:false } for background scans. */
async function _refreshAll(progressFn, options = {}) {
  const accounts = S.am.getAll();
  const indexes = Array.isArray(options.indexes)
    ? options.indexes.filter((index) => Number.isInteger(index) && index >= 0 && index < accounts.length)
    : accounts.map((_, index) => index);
  const priority = options.priority || 'normal';
  return enqueueRefreshAll(indexes, {
    priority,
    reason: options.reason || 'refresh_all',
    wait: options.wait !== false,
    enqueueDelayMs: options.enqueueDelayMs ?? (priority === 'low' ? 500 : 0),
    lane: options.lane || null,
    laneConcurrency: options.laneConcurrency,
    minStartGapMs: options.minStartGapMs,
    itemOptions: (index) => _refreshJobOptions(index),
    progressFn,
    onSettledIndex: options.onSettledIndex,
  });
}

function _enqueueBatchImportValidation(addedAccounts) {
  const emails = (addedAccounts || [])
    .map((account) => account?.email?.trim().toLowerCase())
    .filter(Boolean);
  if (emails.length === 0) return { queued: 0 };

  const indexes = [];
  const emailByIndex = new Map();
  for (const email of emails) {
    const current = S.am.findByEmail(email);
    if (current) {
      indexes.push(current.index);
      emailByIndex.set(current.index, email);
    }
  }
  if (indexes.length === 0) return { queued: 0 };

  _logInfo(
    '批量验证',
    `新增${indexes.length}个账号进入慢速后台队列: 单并发, 间隔${BATCH_IMPORT_VERIFY_GAP_MS / 1000}s`,
  );
  S.batchImportValidationRunning = (S.batchImportValidationRunning || 0) + 1;
  enqueueRefreshAll(indexes, {
    priority: 'low',
    reason: 'batch_import_verify',
    wait: false,
    lane: BATCH_IMPORT_VERIFY_LANE,
    laneConcurrency: indexes.length > 20 ? 1 : 2,
    minStartGapMs: BATCH_IMPORT_VERIFY_GAP_MS,
    enqueueDelayMs: BATCH_IMPORT_ENQUEUE_DELAY_MS,
    itemOptions: (index) => _refreshJobOptions(index, {
      key: emailByIndex.get(index),
      email: emailByIndex.get(index),
      priority: 'low',
      reason: 'batch_import_verify',
    }),
    onSettledIndex: () => {
      _updatePoolBar();
      _refreshPanel();
    },
  }).then((result) => {
    _logInfo(
      '批量验证',
      `慢速后台验证完成 total=${result?.total ?? indexes.length} ok=${result?.ok ?? 0} failed=${result?.failed ?? 0}`,
    );
    _updatePoolBar();
    _refreshPanel();
  }).catch((e) => {
    _logWarn('批量验证', `慢速后台验证异常: ${e.message}`);
  }).finally(() => {
    S.batchImportValidationRunning = Math.max(0, (S.batchImportValidationRunning || 1) - 1);
    if (!S.batchImportValidationRunning) {
      S.fullScanDeferredUntil = Math.max(S.fullScanDeferredUntil || 0, Date.now() + 120000);
    }
  });

  return { queued: indexes.length };
}

// ========== 号池命令 (v6.0 精简) ==========

/** 刷新号池 — 全部账号额度 + 自动轮转
 *  reason='manual_full_scan' 让 worker 启用 preferLocal，优先吃 cache，
 *  避免手动点刷新时发起 N 个 password 登录 → Firebase 限流 → 熝断。 */
async function _doRefreshPool(context) {
  const accounts = S.am.getAll();
  if (accounts.length === 0) return;
  S.statusBar.text = "$(sync~spin) 刷新号池...";
  await _refreshAll((i, n) => {
    S.statusBar.text = `$(sync~spin) ${i + 1}/${n}...`;
  }, { priority: 'low', reason: 'manual_full_scan' });
  // 刷新后自动轮转
  const threshold = _getPreemptiveThreshold();
  if (
    vscode.workspace.getConfiguration("wam").get("autoRotate", true) &&
    S.activeIndex >= 0
  ) {
    const decision = S.am.shouldSwitch(S.activeIndex, threshold);
    if (decision.switch) {
      await _performSwitch(context, { threshold, targetPolicy: 'same_strategy', source: `refresh_pool:${decision.reason}` });
    }
  }
  _updatePoolBar();
  _refreshPanel();
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
    const lines = S.am.getAll()
      .filter((account) => account?.email && account?.password)
      .map((account) => `${account.email}----${account.password}`);
    if (lines.length === 0) {
      vscode.window.showWarningMessage('WAM: 没有可导出的账号密码');
      return;
    }
    await vscode.env.clipboard.writeText(lines.join('\n'));
    _logInfo('导出', `已复制${lines.length}个账号到剪贴板`);
    vscode.window.showInformationMessage(`WAM: ✅ 已复制 ${lines.length} 个账号到剪贴板`);
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
    result.validation = _enqueueBatchImportValidation(result.accounts);
  }
  _refreshPanel();
  return result;
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
