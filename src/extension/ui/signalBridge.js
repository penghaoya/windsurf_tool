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

import vscode from 'vscode';
import { _logInfo, _logWarn, S } from '../core/state.js';
import { _doPoolRotate } from '../core/scheduler.js';
import { _parseResetSeconds } from '../core/defense.js';

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

    // Wait for Vue app to acquire vscode API and expose it on window
    function getVscode() {
      if (window.__wamVscode) return window.__wamVscode;
      try {
        // Fallback: try to acquire if Vue hasn't yet
        if (typeof acquireVsCodeApi === 'function') {
          window.__wamVscode = acquireVsCodeApi();
          return window.__wamVscode;
        }
      } catch (e) {}
      return null;
    }

    function pollSignal() {
      try {
        var raw = localStorage.getItem(SIGNAL_KEY);
        if (!raw) return;
        var signal = JSON.parse(raw);
        if (!signal || !signal.ts) return;
        if (signal.ts <= lastSignalTs) return;
        if (Date.now() - signal.ts > ${SIGNAL_MAX_AGE_MS}) { lastSignalTs = signal.ts; return; }
        var vscode = getVscode();
        if (!vscode) return;
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

  function matchPattern(text) {
    if (!text) return false;
    for (var j = 0; j < RATE_LIMIT_PATTERNS.length; j++) {
      if (RATE_LIMIT_PATTERNS[j].test(text)) return true;
    }
    return false;
  }

  function checkForRateLimit() {
    try {
      var messages = document.querySelectorAll(
        '.error-message, .cascade-error, [class*="error"], [class*="warning"], [class*="rate-limit"]'
      );
      for (var i = messages.length - 1; i >= Math.max(0, messages.length - 8); i--) {
        var text = messages[i].textContent || '';
        if (matchPattern(text)) { emitSignal(text); return; }
      }
      // Fallback: scan recent text nodes near bottom of cascade panel.
      var bodyText = (document.body && document.body.innerText) || '';
      if (bodyText.length > 4000) bodyText = bodyText.slice(-4000);
      if (matchPattern(bodyText)) emitSignal(bodyText.slice(-500));
    } catch(e) {}
  }

  // Hook window.fetch — primary path. Cascade UI in renderer hits server.codeium.com
  // and the local LS HTTP/2 endpoint via fetch; streaming bodies are clone()-able.
  // why: this catches rate-limit errors at the network layer before they render.
  try {
    var origFetch = window.fetch;
    if (typeof origFetch === 'function' && !window.__wamFetchHooked) {
      window.__wamFetchHooked = true;
      window.fetch = function() {
        var p = origFetch.apply(this, arguments);
        try {
          var url = arguments[0];
          var urlStr = typeof url === 'string' ? url : (url && (url.url || url.href)) || '';
          var isTarget = /codeium\\.com|windsurf\\.com|localhost|127\\.0\\.0\\.1/i.test(urlStr);
          if (!isTarget) return p;
          return p.then(function(resp) {
            try {
              if (!resp || !resp.clone) return resp;
              var clone = resp.clone();
              var rdr = clone.body && clone.body.getReader && clone.body.getReader();
              if (!rdr) return resp;
              var dec = new TextDecoder();
              var acc = '';
              var hit = false;
              function pump() {
                rdr.read().then(function(r) {
                  if (r.done || hit) return;
                  try {
                    var t = dec.decode(r.value, { stream: true });
                    acc += t;
                    if (acc.length > 16384) acc = acc.slice(-16384);
                    if (matchPattern(t) || matchPattern(acc)) {
                      hit = true;
                      emitSignal(t || acc.slice(-500));
                      return;
                    }
                  } catch(e) {}
                  pump();
                }).catch(function(){});
              }
              pump();
            } catch(e) {}
            return resp;
          }, function(err) {
            try { if (err && matchPattern(err.message || String(err))) emitSignal(err.message || String(err)); } catch(e) {}
            throw err;
          });
        } catch(e) {}
        return p;
      };
    }
  } catch(e) {}

  // Hook XMLHttpRequest — fallback path for non-fetch HTTP clients.
  try {
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype && !XHR.prototype.__wamHooked) {
      XHR.prototype.__wamHooked = true;
      var origOpen = XHR.prototype.open;
      var origSend = XHR.prototype.send;
      XHR.prototype.open = function(method, url) {
        try { this.__wamUrl = url; } catch(e) {}
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function() {
        try {
          var self = this;
          var url = self.__wamUrl || '';
          if (/codeium\\.com|windsurf\\.com|localhost|127\\.0\\.0\\.1/i.test(url)) {
            self.addEventListener('load', function() {
              try {
                var txt = '';
                try { txt = self.responseText || ''; } catch(e) {}
                if (matchPattern(txt)) emitSignal(txt.slice(0, 500));
              } catch(e) {}
            });
          }
        } catch(e) {}
        return origSend.apply(this, arguments);
      };
    }
  } catch(e) {}

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

  // Check if auto-continue is enabled
  const enabled = vscode.workspace.getConfiguration('wam').get('autoContinueOnRateLimit', true);
  if (!enabled) {
    _logInfo('信号桥', `收到UI信号但 autoContinueOnRateLimit=false, 忽略`);
    return;
  }

  _logInfo('信号桥', `收到UI信号: ${signal.type} (detail: ${(signal.detail || '').slice(0, 100)})`);

  respond({ type: 'retrying', ts: t0 });

  try {
    // Mark current account as rate-limited before switching
    if (S.activeIndex >= 0) {
      const cooldown = _parseResetSeconds(signal.detail) || 300;
      S.am.markRateLimited(S.activeIndex, cooldown, {
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
