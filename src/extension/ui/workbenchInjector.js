/**
 * Workbench Interceptor Injector v24.0
 *
 * Injects the rate-limit interceptor script into Windsurf's workbench.html.
 * This enables the UI signal bridge to detect rate-limit errors directly
 * from the Cascade output and trigger instant account switching.
 *
 * Architecture (ported from windsurf-pool enhancementInjector):
 *   workbench.html → <script> interceptor → detects error → localStorage signal
 *   sidebar webview → signal bridge → extension host → panic switch → result back
 */

import vscode from 'vscode';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { _logInfo, _logWarn, _logError } from '../core/state.js';
import { getWorkbenchInterceptorScript } from './signalBridge.js';

// ═══ Markers ═══

const BLOCK_START = '<!-- wam-interceptor-start -->';
const BLOCK_END = '<!-- wam-interceptor-end -->';
const VERSION_PREFIX = '<!-- wam-interceptor-v';
const VERSION_SUFFIX = ' -->';

// ═══ Path detection ═══

function getWorkbenchHtmlPath() {
  const appRoot = vscode.env.appRoot;
  const candidates = [
    path.join(appRoot, 'out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html'),
    path.join(appRoot, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.html'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ═══ Version hash ═══

function getScriptHash() {
  const content = getWorkbenchInterceptorScript();
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

// ═══ CSP patching ═══

function ensureCSP(html) {
  const m = html.match(/script-src\s+[^;]*/);
  if (!m) return html;
  if (m[0].includes("'unsafe-inline'")) return html;
  return html.replace(/(script-src\s+[^;]*)/, "$1 'unsafe-inline'");
}

// ═══ Core operations ═══

/**
 * Inject the interceptor into workbench.html.
 * Backs up original on first injection.
 * Returns { injected, needRestart, error? }
 */
export function installInterceptor() {
  const workbenchPath = getWorkbenchHtmlPath();
  if (!workbenchPath) {
    return { injected: false, needRestart: false, error: '未找到 workbench.html' };
  }

  let html;
  try {
    html = fs.readFileSync(workbenchPath, 'utf8');
  } catch (e) {
    return { injected: false, needRestart: false, error: `读取失败: ${e.message}` };
  }

  const hash = getScriptHash();
  const versionMarker = `${VERSION_PREFIX}${hash}${VERSION_SUFFIX}`;

  // Already up to date?
  if (html.includes(versionMarker)) {
    return { injected: true, needRestart: false };
  }

  // Backup original (only first time)
  const originPath = workbenchPath + '.wam-origin';
  if (!fs.existsSync(originPath)) {
    try {
      fs.copyFileSync(workbenchPath, originPath);
      _logInfo('注入器', `已备份 workbench.html → ${path.basename(originPath)}`);
    } catch (e) {
      return { injected: false, needRestart: false, error: `备份失败: ${e.message}` };
    }
  }

  // Remove old injection block
  let newHtml = html;
  const startIdx = newHtml.indexOf(BLOCK_START);
  const endIdx = newHtml.indexOf(BLOCK_END);
  if (startIdx >= 0 && endIdx >= 0) {
    newHtml = newHtml.substring(0, startIdx) + newHtml.substring(endIdx + BLOCK_END.length);
  }

  // Patch CSP
  newHtml = ensureCSP(newHtml);

  // Build injection block
  const scriptContent = getWorkbenchInterceptorScript();
  const injection = `\n${BLOCK_START}\n` +
    `${versionMarker}\n` +
    `<script>\n${scriptContent}\n</script>\n` +
    `${BLOCK_END}\n`;

  newHtml = newHtml.replace('</body>', injection + '</body>');

  try {
    fs.writeFileSync(workbenchPath, newHtml, 'utf8');
    _logInfo('注入器', `interceptor 已注入 (hash=${hash})`);
    return { injected: true, needRestart: true };
  } catch (e) {
    // Permission error — try with sudo hint
    if (e.code === 'EACCES') {
      return { injected: false, needRestart: false, error: `权限不足 — 请以管理员身份运行 Windsurf，或手动修改 ${workbenchPath}` };
    }
    return { injected: false, needRestart: false, error: `写入失败: ${e.message}` };
  }
}

/**
 * Restore the original workbench.html from backup.
 */
export function uninstallInterceptor() {
  const workbenchPath = getWorkbenchHtmlPath();
  if (!workbenchPath) return { restored: false, error: '未找到 workbench.html' };

  const originPath = workbenchPath + '.wam-origin';
  if (!fs.existsSync(originPath)) {
    return { restored: false, error: '未找到备份文件 (.wam-origin)' };
  }

  try {
    fs.copyFileSync(originPath, workbenchPath);
    _logInfo('注入器', '已恢复原始 workbench.html');
    return { restored: true };
  } catch (e) {
    return { restored: false, error: `恢复失败: ${e.message}` };
  }
}

/**
 * Check current injection status.
 */
export function getInjectionStatus() {
  const workbenchPath = getWorkbenchHtmlPath();
  if (!workbenchPath) return { injected: false, path: null };

  try {
    const html = fs.readFileSync(workbenchPath, 'utf8');
    const injected = html.includes(BLOCK_START);
    const match = html.match(/<!-- wam-interceptor-v([a-f0-9]+) -->/);
    return {
      injected,
      hash: match ? match[1] : null,
      path: workbenchPath,
      currentHash: getScriptHash(),
      needsUpdate: injected && match && match[1] !== getScriptHash(),
    };
  } catch {
    return { injected: false, path: workbenchPath };
  }
}

// ═══ Command registration ═══

export function registerInterceptorCommands(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('wam.installInterceptor', async () => {
      const result = installInterceptor();
      if (result.error) {
        vscode.window.showErrorMessage(`WAM: 注入失败 — ${result.error}`);
        return;
      }
      if (!result.needRestart) {
        vscode.window.showInformationMessage('WAM: Interceptor 已是最新，无需更新。');
        return;
      }
      const action = await vscode.window.showInformationMessage(
        'WAM: Interceptor 已注入到 workbench.html，重启后生效。',
        '立即重启',
      );
      if (action === '立即重启') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }),

    vscode.commands.registerCommand('wam.uninstallInterceptor', async () => {
      const result = uninstallInterceptor();
      if (result.error) {
        vscode.window.showErrorMessage(`WAM: 恢复失败 — ${result.error}`);
        return;
      }
      const action = await vscode.window.showInformationMessage(
        'WAM: 已恢复原始 workbench.html，重启后生效。',
        '立即重启',
      );
      if (action === '立即重启') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }),

    vscode.commands.registerCommand('wam.interceptorStatus', () => {
      const status = getInjectionStatus();
      if (status.injected) {
        const msg = status.needsUpdate
          ? `Interceptor 已注入但版本过期 (${status.hash} → ${status.currentHash})，建议重新注入。`
          : `Interceptor 已注入 (hash=${status.hash})，状态正常。`;
        vscode.window.showInformationMessage(`WAM: ${msg}`);
      } else {
        vscode.window.showWarningMessage('WAM: Interceptor 未注入。执行 "WAM: 安装 Interceptor" 以启用自动重试。');
      }
    }),
  );

  // Auto-install/auto-update on startup.
  // why: workbench.html injection is the ONLY reliable signal path for Cascade
  // rate-limit detection (extension host can't see renderer fetch nor LS gRPC
  // child-process traffic). If we don't auto-install, users get a non-functional
  // panic-switch by default. Behavior:
  //   - not injected      → install + prompt reload
  //   - injected, outdated → re-install + prompt reload
  //   - injected, current  → no-op
  // Respects wam.cascadeMonitorEnabled to allow opting out.
  const enabled = vscode.workspace.getConfiguration('wam').get('cascadeMonitorEnabled', true);
  if (!enabled) {
    _logInfo('注入器', '跳过自动注入 (wam.cascadeMonitorEnabled=false)');
    return;
  }
  const status = getInjectionStatus();
  if (!status.path) {
    _logWarn('注入器', '未找到 workbench.html — 跳过自动注入');
    return;
  }
  if (status.injected && !status.needsUpdate) {
    _logInfo('注入器', `Interceptor 已就绪 (hash=${status.hash})`);
    return;
  }
  const reason = !status.injected ? '首次部署' : `版本升级 ${status.hash}→${status.currentHash}`;
  _logInfo('注入器', `自动注入 — ${reason}`);
  const result = installInterceptor();
  if (result.error) {
    _logError('注入器', `自动注入失败: ${result.error}`);
    vscode.window.showWarningMessage(
      `WAM: Interceptor 自动注入失败 — ${result.error}。限流自动切号/重试功能不可用，请手动运行 "WAM: 安装 Interceptor"。`,
    );
    return;
  }
  if (result.needRestart) {
    _logInfo('注入器', `${reason}完成，等待重启`);
    vscode.window.showInformationMessage(
      `WAM: Interceptor 已${status.injected ? '更新' : '注入'}到 workbench.html，重启窗口后限流自动切号即可生效。`,
      '立即重启',
      '稍后',
    ).then(action => {
      if (action === '立即重启') vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
  }
}
