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
  _refreshPanel,
} from './core/state.js';
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

const authInjector = createAuthInjector({
  refreshOne: _refreshOne,
  updatePoolBar: renderStatusBar,
});

const { injectAuth, _checkAccount, _loginToAccount } = authInjector;

const _handleAction = createActionHandler({
  checkAccount: _checkAccount,
  doBatchAdd: _doBatchAdd,
  doExport: _doExport,
  doImport: _doImport,
  doRefreshPool: _doRefreshPool,
  doResetFingerprint: _doResetFingerprint,
  refreshOne: _refreshOne,
  refreshPanel: _refreshPanel,
  updatePoolBar: renderStatusBar,
});

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
