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
import { AccountManager } from './accountManager.js';

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
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
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

    this._am.onChange(() => this._pushState());

    // 切换 tab 回来时自动推送状态
    if (webviewView.onDidChangeVisibility) {
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) this._pushState();
      });
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
    setTimeout(() => this._pushState(), 50);
    setTimeout(() => this._pushState(), 300);
    setTimeout(() => this._pushState(), 800);
  }

  // ═══ 状态推送 (Extension Host → Vue) ═══

  _pushState() {
    if (!this._view || !this._ready) return;
    const accounts = this._am.getAll();
    const currentIndex = this._onAction ? this._onAction('getCurrentIndex') : -1;
    const cfg = vscode.workspace.getConfiguration('wam');
    const threshold = cfg.get('preemptiveThreshold', 15);
    const pool = this._am.getPoolStats ? this._am.getPoolStats(threshold) : { total: accounts.length, available: 0, depleted: 0, rateLimited: 0, health: 0, avgDaily: null, avgWeekly: null };
    const activeQuota = this._am.getActiveQuota ? this._am.getActiveQuota(currentIndex) : null;
    const switchCount = this._onAction ? (this._onAction('getSwitchCount') || 0) : 0;

    // 为每个账号附加计算属性 (Vue 侧只做展示，不做业务逻辑)
    const enriched = accounts.map((a, i) => ({
      ...a,
      effective: this._am.effectiveRemaining(i),
      isExpired: this._am.isExpired ? this._am.isExpired(i) : false,
      planDays: this._am.getPlanDaysRemaining ? this._am.getPlanDaysRemaining(i) : null,
      urgency: this._am.getExpiryUrgency ? this._am.getExpiryUrgency(i) : -1,
      rateLimitInfo: this._am.getRateLimitInfo ? this._am.getRateLimitInfo(i) : null,
    }));

    // 补充 activeQuota 的紧急度
    if (activeQuota && currentIndex >= 0) {
      activeQuota.urgency = this._am.getExpiryUrgency ? this._am.getExpiryUrgency(currentIndex) : -1;
    }

    this._view.webview.postMessage({
      type: 'state',
      accounts: enriched,
      currentIndex,
      pool,
      activeQuota,
      threshold,
      switchCount,
    });
  }

  // ═══ 消息路由 (Vue → Extension Host) ═══

  async _handleMessage(msg) {
    const act = this._onAction;
    switch (msg.type) {
      case 'requestState':
        this._pushState();
        break;
      case 'remove':
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
      case 'login':
        if (msg.index !== undefined && act) {
          this._setLoading(true);
          await act('login', msg.index);
          this._setLoading(false);
          this._pushState();
        }
        break;
      case 'preview':
        if (msg.text) {
          const accounts = AccountManager.parseAccounts(msg.text);
          if (this._view) this._view.webview.postMessage({ type: 'previewResult', accounts });
        }
        break;
      case 'batchAdd':
        if (msg.text && act) {
          this._setLoading(true);
          const result = await act('batchAdd', msg.text);
          if (result && result.added > 0) {
            this._toast(`+${result.added} 账号，验证中...`);
            this._pushState();
            await act('refreshAll');
            this._toast('验证完成');
          } else if (result && result.skipped > 0) {
            this._toast(`${result.skipped} 个已存在`, true);
          } else {
            this._toast('未识别到有效账号', true);
          }
          this._setLoading(false);
          this._pushState();
        }
        break;
      case 'refresh':
      case 'refreshAllAndRotate':
        if (act) { this._setLoading(true); await act('refreshAll'); this._setLoading(false); this._toast('刷新完成'); this._pushState(); }
        break;
      case 'smartRotate':
        if (act) { this._setLoading(true); await act('smartRotate'); this._setLoading(false); this._pushState(); }
        break;
      case 'panicSwitch':
        if (act) { this._setLoading(true); await act('panicSwitch'); this._setLoading(false); this._pushState(); }
        break;
      case 'setMode':
        if (msg.mode && act) { act('setMode', msg.mode); this._pushState(); }
        break;
      case 'reprobeProxy':
        if (act) { this._setLoading(true); await act('reprobeProxy'); this._setLoading(false); this._pushState(); }
        break;
      case 'resetFingerprint':
        if (act) act('resetFingerprint');
        break;
      case 'removeEmpty':
        this._removeEmpty(); this._pushState();
        break;
      case 'toggleDetail':
        break; // Vue侧自行管理展开状态
      case 'setProxyPort':
        if (msg.port !== undefined) { const p = parseInt(msg.port); if (p > 0 && p < 65536 && act) act('setProxyPort', p); this._pushState(); }
        break;
      case 'setAutoRotate':
        if (act) act('setAutoRotate', msg.value);
        this._pushState();
        break;
      case 'setCreditThreshold':
      case 'setPreemptiveThreshold':
        if (act) act('setPreemptiveThreshold', msg.value);
        this._pushState();
        break;
      case 'exportAccounts':
        if (act) act('exportAccounts');
        break;
      case 'importAccounts':
        if (act) { await act('importAccounts'); this._pushState(); }
        break;
      case 'refreshOne':
        if (msg.index !== undefined && act) {
          this._setLoading(true);
          await act('refreshOne', msg.index);
          this._setLoading(false);
          this._toast('刷新完成');
          this._pushState();
        }
        break;
      case 'clearRateLimit':
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
      case 'copyPwd':
        if (msg.index !== undefined) {
          const account = this._am.get(msg.index);
          if (account && this._view) this._view.webview.postMessage({ type: 'pwdResult', index: msg.index, email: account.email, pwd: account.password });
        }
        break;
    }
  }

  _removeEmpty() {
    const accounts = this._am.getAll();
    let removed = 0;
    for (let i = accounts.length - 1; i >= 0; i--) {
      const a = accounts[i];
      if (/test|x\.com|example/i.test(a.email) || (a.credits !== undefined && a.credits <= 0)) {
        this._am.remove(i); removed++;
      }
    }
    this._toast(`已清理 ${removed} 个无效账号`);
  }

  refresh() { this._pushState(); }
  _toast(msg, isError) { if (this._view) this._view.webview.postMessage({ type: 'toast', msg, isError: !!isError }); }
  _setLoading(on) { if (this._view) this._view.webview.postMessage({ type: 'loading', on }); }
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
  panel.onDidDispose(() => { provider._view = null; });
  return { panel, provider };
}

export { AccountViewProvider, openAccountPanel };
