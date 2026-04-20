/**
 * 号池仪表盘 v7.0.0 — Vue 3 + Vite ESM 重构
 *
 * 核心: 用户看到的是号池，不是单个账号。
 * UI 由 src/webview/ (Vue 3 + Vite) 构建产物渲染。
 * 本模块仅负责: 加载 Vue 产物 + 消息路由 + 状态推送。
 */
import vscode from 'vscode';
import path from 'path';
import fs from 'fs';
import { ACTION, MSG } from '../shared/messageTypes.js';

function _getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}

class AccountViewProvider {
  constructor(extensionUri, accountManager, authService, onAction) {
    this._extensionUri = extensionUri;
    this._am = accountManager;
    this._auth = authService;
    this._onAction = onAction;
    this._view = null;
    this._ready = false;
    this._statePushTimer = null;
    this._lastStateFingerprint = '';
    this._statePushDelay = 80;
    this._disposeAccountChange = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    this._lastStateFingerprint = '';
    this._clearStatePushTimer();
    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist/webview');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [distUri]
    };
    this._mountVueApp();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try { await this._handleMessage(msg); } catch (e) {
        console.error('WAM webview error:', e.message);
        this._toast(`错误: ${e.message}`, true);
      }
    });

    this._bindAccountChange();

    // 切换 tab 回来时自动推送状态
    if (webviewView.onDidChangeVisibility) {
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) this._pushState({ force: true });
      });
    }
    if (webviewView.onDidDispose) {
      webviewView.onDidDispose(() => this._disposeView());
    }
  }

  // ═══ Vue 产物加载 ═══

  _mountVueApp() {
    if (!this._view) return;
    const webview = this._view.webview;
    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist/webview');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'index.js'));
    const nonce = _getNonce();

    // 检测 CSS 文件是否存在
    let styleTag = '';
    const cssPath = path.join(this._extensionUri.fsPath, 'dist/webview', 'index.css');
    if (fs.existsSync(cssPath)) {
      const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'index.css'));
      styleTag = `<link href="${styleUri}" rel="stylesheet">`;
    }

    webview.html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
  ${styleTag}
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;

    // 首次推送状态 (多次延迟确保 Vue 挂载完成后收到数据)
    this._ready = true;
    setTimeout(() => this._pushState({ force: true }), 50);
    setTimeout(() => this._pushState({ force: true }), 300);
    setTimeout(() => this._pushState({ force: true }), 800);
  }

  // ═══ 状态推送 (Extension Host → Vue) ═══

  _pushState(options = {}) {
    const force = options.force === true;
    if (!this._view || !this._ready) return;
    if (force) {
      this._clearStatePushTimer();
      this._emitState(true);
      return;
    }
    if (this._statePushTimer) return;
    this._statePushTimer = setTimeout(() => {
      this._statePushTimer = null;
      this._emitState(false);
    }, this._statePushDelay);
  }

  _emitState(force = false) {
    if (!this._view || !this._ready) return;
    const accounts = this._am.getAll();
    const currentIndex = this._onAction ? this._onAction('getCurrentIndex') : -1;
    const cfg = vscode.workspace.getConfiguration('wam');
    const threshold = cfg.get('preemptiveThreshold', 15);
    const pool = this._am.getPoolStats ? this._am.getPoolStats(threshold) : { total: accounts.length, available: 0, depleted: 0, rateLimited: 0, health: 0, avgDaily: null, avgWeekly: null };
    const activeQuota = this._am.getActiveQuota ? this._am.getActiveQuota(currentIndex) : null;
    const switchCount = this._onAction ? (this._onAction('getSwitchCount') || 0) : 0;
    const switchStatus = this._onAction ? (this._onAction('getSwitchStatus') || null) : null;

    // 为每个账号附加计算属性 (Vue 侧只做展示，不做业务逻辑)
    const enriched = accounts.map((a, i) => {
      const dailyRem = this._am.getDailyRemaining ? this._am.getDailyRemaining(i) : null;
      return {
        index: i,
        email: a.email,
        credits: a.credits,
        usage: a.usage || null,
        rateLimit: a.rateLimit || null,
        authError: a.authError || null,
        loginCount: a.loginCount || 0,
        addedAt: a.addedAt || null,
        effective: this._am.effectiveRemaining(i),
        isExpired: this._am.isExpired ? this._am.isExpired(i) : false,
        planDays: this._am.getPlanDaysRemaining ? this._am.getPlanDaysRemaining(i) : null,
        planEnd: a.usage?.planEnd || null,
        urgency: this._am.getExpiryUrgency ? this._am.getExpiryUrgency(i) : -1,
        rateLimitInfo: this._am.getRateLimitInfo ? this._am.getRateLimitInfo(i) : null,
        invalidAuth: this._am.isInvalidAuth ? this._am.isInvalidAuth(i) : false,
        schedulerBlocked: this._onAction ? this._onAction('getAccountBlocked', i) : null,
        dailyDepleted: dailyRem !== null && dailyRem <= 5,
      };
    });

    // 补充 activeQuota 的紧急度
    if (activeQuota && currentIndex >= 0) {
      activeQuota.urgency = this._am.getExpiryUrgency ? this._am.getExpiryUrgency(currentIndex) : -1;
    }

    const payload = {
      type: MSG.STATE,
      accounts: enriched,
      currentIndex,
      pool,
      activeQuota,
      threshold,
      switchCount,
      switchStatus,
    };
    const fingerprint = JSON.stringify(payload);
    if (!force && fingerprint === this._lastStateFingerprint) return;
    this._lastStateFingerprint = fingerprint;
    this._view.webview.postMessage(payload);
  }

  _clearStatePushTimer() {
    if (!this._statePushTimer) return;
    clearTimeout(this._statePushTimer);
    this._statePushTimer = null;
  }

  _disposeView() {
    this._clearStatePushTimer();
    if (this._disposeAccountChange) {
      this._disposeAccountChange();
      this._disposeAccountChange = null;
    }
    this._view = null;
    this._ready = false;
    this._lastStateFingerprint = '';
  }

  _bindAccountChange() {
    if (this._disposeAccountChange) this._disposeAccountChange();
    this._disposeAccountChange = this._am.onChange(() => this._pushState());
  }

  // ═══ 消息路由 (Vue → Extension Host) ═══

  async _handleMessage(msg) {
    const act = this._onAction;
    switch (msg.type) {
      case ACTION.REQUEST_STATE:
        this._pushState({ force: true });
        break;
      case ACTION.REMOVE:
        if (msg.index !== undefined) {
          const currentIndex = act ? act('getCurrentIndex') : -1;
          if (currentIndex >= 0 && msg.index === currentIndex) {
            this._toast('当前激活账号无法移除，请先切换到其他账号');
          } else {
            this._am.remove(msg.index);
            this._pushState();
          }
        }
        break;
      case ACTION.LOGIN:
        if (msg.index !== undefined && act) {
          await this._runRequest(msg, () => act('login', msg.index));
        }
        break;
      case ACTION.BATCH_ADD:
        if (msg.text && act) {
          await this._runRequest(msg, async () => {
            const result = await act('batchAdd', msg.text);
            if (result && result.added > 0) {
              const queued = result.validation?.queued || result.added;
              this._toast(`+${result.added} 账号，已进入慢速验证队列(${queued})`);
              this._pushState();
            } else if (result && result.skipped > 0) {
              this._toast(`${result.skipped} 个已存在`, true);
            } else {
              this._toast('未识别到有效账号', true);
            }
            return result;
          });
        }
        break;
      case ACTION.REFRESH:
      case ACTION.REFRESH_ALL_AND_ROTATE:
        if (act) {
          await this._runRequest(msg, async () => {
            const result = await act('refreshAll');
            this._toast('刷新完成');
            return result;
          });
        }
        break;
      case ACTION.SMART_ROTATE:
        if (act) await this._runRequest(msg, () => act('smartRotate'));
        break;
      case ACTION.PANIC_SWITCH:
        if (act) await this._runRequest(msg, () => act('panicSwitch'));
        break;
      case ACTION.SET_MODE:
        if (msg.mode && act) { act('setMode', msg.mode); this._pushState(); }
        break;
      case ACTION.REPROBE_PROXY:
        if (act) await this._runRequest(msg, () => act('reprobeProxy'));
        break;
      case ACTION.SHOW_LOGS:
        if (act) act('showLogs');
        break;
      case ACTION.RESET_FINGERPRINT:
        if (act) act('resetFingerprint');
        break;
      case ACTION.REMOVE_EMPTY:
        this._removeEmpty(); this._pushState();
        break;
      case ACTION.TOGGLE_DETAIL:
        break; // Vue侧自行管理展开状态
      case ACTION.SET_PROXY_PORT:
        if (msg.port !== undefined) { const p = parseInt(msg.port); if (p > 0 && p < 65536 && act) act('setProxyPort', p); this._pushState(); }
        break;
      case ACTION.SET_AUTO_ROTATE:
        if (act) act('setAutoRotate', msg.value);
        this._pushState();
        break;
      case 'setCreditThreshold':
      case ACTION.SET_PREEMPTIVE_THRESHOLD:
        if (act) act('setPreemptiveThreshold', msg.value);
        this._pushState();
        break;
      case ACTION.EXPORT_ACCOUNTS:
        if (act) act('exportAccounts');
        break;
      case ACTION.IMPORT_ACCOUNTS:
        if (act) await this._runRequest(msg, () => act('importAccounts'));
        break;
      case ACTION.REFRESH_ONE:
        if (msg.index !== undefined && act) {
          await this._runRequest(msg, async () => {
            const result = await act('refreshOne', msg.index);
            this._toast('刷新完成');
            return result;
          });
        }
        break;
      case ACTION.CLEAR_RATE_LIMIT:
        if (msg.index !== undefined) {
          if (act) {
            await act('clearRateLimit', msg.index);
          } else {
            this._am.clearRateLimit(msg.index);
          }
          this._toast('已解除限流标记');
          this._pushState();
        }
        break;
      case ACTION.COPY_PWD:
        if (msg.index !== undefined) {
          const account = this._am.get(msg.index);
          if (account && this._view) {
            this._view.webview.postMessage({
              type: MSG.PWD_RESULT,
              index: msg.index,
              email: account.email,
              pwd: account.password,
            });
          }
        }
        break;
    }
  }

  async _runRequest(msg, fn) {
    try {
      const result = await this._withLoading(fn);
      this._pushState();
      this._sendActionResult(msg.requestId, { ok: true, result });
      return result;
    } catch (e) {
      this._toast(`错误: ${e.message}`, true);
      this._sendActionResult(msg.requestId, { ok: false, error: e.message });
      return null;
    }
  }

  async _withLoading(fn) {
    this._setLoading(true);
    try {
      return await fn();
    } finally {
      this._setLoading(false);
    }
  }

  _sendActionResult(requestId, payload) {
    if (!requestId || !this._view) return;
    this._view.webview.postMessage({
      type: MSG.ACTION_RESULT,
      requestId,
      ...payload,
    });
  }

  _removeEmpty() {
    const accounts = this._am.getAll();
    let removed = 0;
    for (let i = accounts.length - 1; i >= 0; i--) {
      const a = accounts[i];
      if (/^test[@.]|@test\.|@example\.|@example\.com$/i.test(a.email) || (a.credits !== undefined && a.credits <= 0 && !a.usage?.daily)) {
        this._am.remove(i); removed++;
      }
    }
    this._toast(`已清理 ${removed} 个无效账号`);
  }

  refresh() { this._pushState(); }
  _toast(msg, isError) { if (this._view) this._view.webview.postMessage({ type: MSG.TOAST, msg, isError: !!isError }); }
  _setLoading(on) { if (this._view) this._view.webview.postMessage({ type: MSG.LOADING, on }); }
  // 兼容原接口
  _render() { this._pushState(); }
}

/** 在编辑器区域打开管理面板 */
function openAccountPanel(context, am, auth, onAction, existingPanel) {
  if (existingPanel) {
    try { existingPanel.reveal(vscode.ViewColumn.One); return null; } catch {}
  }
  const panel = vscode.window.createWebviewPanel(
    'wam.panel', '无感切号 · 账号管理', vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist/webview')] }
  );
  const provider = new AccountViewProvider(
    context.extensionUri, am, auth, onAction
  );
  const fakeView = { webview: panel.webview };
  Object.defineProperty(fakeView.webview, 'options', { set() {}, get() { return { enableScripts: true }; } });
  provider.resolveWebviewView(fakeView);
  panel.onDidDispose(() => provider._disposeView());
  return { panel, provider };
}

export { AccountViewProvider, openAccountPanel };
