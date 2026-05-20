/**
 * UI Signal Bridge v24.0
 *
 * Detects rate-limit errors directly from Windsurf's Cascade UI output and
 * triggers instant (panic) account switching + auto-retry.
 *
 * Architecture (ported from windsurf-pool-7.7.0):
 *   workbench (injected script) → localStorage['wam-signal']
 *   sidebar webview (1s poll)   → postMessage({type:'poolSignal'})
 *   extension host              → panicSwitch → write result back
 *   workbench                   → read result → auto-click retry button
 *
 * The bridge script is injected into the sidebar webview HTML.
 * The workbench-side interceptor is deployed via wisdom or manual injection.
 */

import { _logInfo, _logWarn, S } from '../core/state.js';
import { _doPoolRotate } from '../core/scheduler.js';

// ═══ Constants ═══

const SIGNAL_KEY = 'wam-signal';
const RESULT_KEY = 'wam-result';
const SIGNAL_MAX_AGE_MS = 60_000;

// ═══ Sidebar webview bridge script (injected into HTML) ═══

/**
 * Returns JS to inject into the sidebar webview.
 * Polls localStorage for rate-limit signals from the workbench interceptor,
 * forwards them to extension host via postMessage.
 */
export function getSignalBridgeScript() {
  return `
  (function() {
    var SIGNAL_KEY = '${SIGNAL_KEY}';
    var RESULT_KEY = '${RESULT_KEY}';
    var lastSignalTs = 0;

    function pollSignal() {
      try {
        var raw = localStorage.getItem(SIGNAL_KEY);
        if (!raw) return;
        var signal = JSON.parse(raw);
        if (!signal || !signal.ts) return;
        if (signal.ts <= lastSignalTs) return;
        if (Date.now() - signal.ts > ${SIGNAL_MAX_AGE_MS}) { lastSignalTs = signal.ts; return; }
        lastSignalTs = signal.ts;
        vscode.postMessage({ type: 'poolSignal', data: signal });
      } catch(e) {}
    }

    setInterval(pollSignal, 1000);

    document.addEventListener('visibilitychange', function() {
      if (!document.hidden) pollSignal();
    });

    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'poolResult') {
        try {
          localStorage.setItem(RESULT_KEY, JSON.stringify(e.data.data));
        } catch(ex) {}
      }
    });
  })();
`;
}

// ═══ Workbench interceptor script (for wisdom deployment) ═══

/**
 * Returns JS that should be injected into the Windsurf workbench page.
 * It monitors Cascade output for rate-limit error messages and writes
 * a signal to localStorage for the bridge to pick up.
 *
 * Also reads switch results and auto-clicks the retry button.
 */
export function getWorkbenchInterceptorScript() {
  return `
(function() {
  var SIGNAL_KEY = '${SIGNAL_KEY}';
  var RESULT_KEY = '${RESULT_KEY}';
  var RATE_LIMIT_PATTERNS = [
    /all API providers are over their global rate limit/i,
    /overall message rate limit/i,
    /message rate limit/i,
    /rate limit.*for this model/i,
    /Permission denied.*rate limit/i,
    /quota.*exhaust/i,
    /You've reached.*limit/i,
  ];
  var lastResultTs = 0;
  var lastSignalTs = 0;
  var MIN_SIGNAL_GAP = 5000;

  function checkForRateLimit() {
    try {
      var messages = document.querySelectorAll(
        '.error-message, .cascade-error, [class*="error"], [class*="warning"]'
      );
      for (var i = messages.length - 1; i >= Math.max(0, messages.length - 5); i--) {
        var text = messages[i].textContent || '';
        for (var j = 0; j < RATE_LIMIT_PATTERNS.length; j++) {
          if (RATE_LIMIT_PATTERNS[j].test(text)) {
            emitSignal(text);
            return;
          }
        }
      }
    } catch(e) {}
  }

  function emitSignal(errorText) {
    var now = Date.now();
    if (now - lastSignalTs < MIN_SIGNAL_GAP) return;
    lastSignalTs = now;
    var type = /quota.*exhaust/i.test(errorText) ? 'quota-exhausted'
      : /overall.*rate/i.test(errorText) || /global rate/i.test(errorText) ? 'rate-limited'
      : /for this model/i.test(errorText) ? 'model-rate-limited'
      : 'rate-limited';
    try {
      localStorage.setItem(SIGNAL_KEY, JSON.stringify({
        type: type,
        ts: now,
        detail: (errorText || '').slice(0, 500),
      }));
    } catch(e) {}
  }

  function checkResult() {
    try {
      var raw = localStorage.getItem(RESULT_KEY);
      if (!raw) return;
      var result = JSON.parse(raw);
      if (!result || !result.ts) return;
      if (result.ts <= lastResultTs) return;
      if (Date.now() - result.ts > 30000) { lastResultTs = result.ts; return; }
      lastResultTs = result.ts;
      if (result.type === 'switched') {
        showNotification('WAM: 已切换到 ' + (result.email || '新账号') + '，正在重试...');
        setTimeout(autoRetry, 1500);
      } else if (result.type === 'switch-failed') {
        showNotification('WAM: 切号失败 - ' + (result.error || ''), true);
      }
    } catch(e) {}
  }

  function autoRetry() {
    try {
      var retryBtn = document.querySelector(
        'button[aria-label*="Retry"], button[aria-label*="retry"], ' +
        'button[title*="Retry"], button[title*="retry"], ' +
        '[class*="retry"], [data-testid*="retry"]'
      );
      if (retryBtn) {
        retryBtn.click();
        return;
      }
      var buttons = document.querySelectorAll('button');
      for (var i = buttons.length - 1; i >= 0; i--) {
        var t = (buttons[i].textContent || '').trim().toLowerCase();
        if (t === 'retry' || t === '重试' || t.includes('try again')) {
          buttons[i].click();
          return;
        }
      }
    } catch(e) {}
  }

  function showNotification(msg, isError) {
    try {
      var div = document.createElement('div');
      div.textContent = msg;
      div.style.cssText = 'position:fixed;top:12px;right:12px;z-index:99999;padding:8px 16px;' +
        'border-radius:6px;font-size:13px;color:#fff;max-width:400px;' +
        'background:' + (isError ? '#d32f2f' : '#2e7d32') + ';' +
        'box-shadow:0 2px 8px rgba(0,0,0,0.3);transition:opacity 0.3s;';
      document.body.appendChild(div);
      setTimeout(function() { div.style.opacity = '0'; }, 4000);
      setTimeout(function() { div.remove(); }, 4500);
    } catch(e) {}
  }

  setInterval(checkForRateLimit, 2000);
  setInterval(checkResult, 1000);
})();
`;
}

// ═══ Extension Host handler ═══

/**
 * Handle a poolSignal message from the webview bridge.
 * Triggers panic switch and sends result back.
 *
 * @param {object} signal - { type, ts, detail }
 * @param {object} context - vscode.ExtensionContext
 * @param {Function} respond - (data) => webview.postMessage({ type: 'poolResult', data })
 */
export async function handlePoolSignal(signal, context, respond) {
  const t0 = Date.now();
  _logInfo('信号桥', `收到UI信号: ${signal.type} (detail: ${(signal.detail || '').slice(0, 100)})`);

  respond({ type: 'retrying', ts: t0 });

  try {
    // Mark current account as rate-limited before switching
    if (S.activeIndex >= 0) {
      S.am.markRateLimited(S.activeIndex, 300, {
        model: 'current',
        trigger: `signal_bridge:${signal.type}`,
        type: 'tier_cap',
      });
    }

    await _doPoolRotate(context, true);

    const elapsed = Date.now() - t0;
    const newEmail = S.activeIndex >= 0 ? S.am.get(S.activeIndex)?.email : null;

    if (newEmail) {
      _logInfo('信号桥', `切号成功 → ${newEmail} (${elapsed}ms)`);
      respond({
        type: 'switched',
        ts: Date.now(),
        email: newEmail,
      });
    } else {
      _logWarn('信号桥', `切号失败: 无可用账号 (${elapsed}ms)`);
      respond({
        type: 'switch-failed',
        ts: Date.now(),
        error: `无可用账号 (${elapsed}ms)`,
      });
    }
  } catch (err) {
    const elapsed = Date.now() - t0;
    _logWarn('信号桥', `切号异常 (${elapsed}ms): ${err.message}`);
    respond({
      type: 'switch-failed',
      ts: Date.now(),
      error: `异常: ${err.message} (${elapsed}ms)`,
    });
  }
}
