/**
 * Cascade Monitor v26.0
 *
 * Dual-layer rate-limit signal interception (inspired by ai-switch-plugin):
 *
 *   Layer 1: Hook codeium.windsurf extension's LanguageServerClient prototype
 *            — intercepts Cascade method calls (sync throws + async rejects + stream chunks)
 *
 *   Layer 2: Hook globalThis.fetch + https.request + http.request + ClientRequest.emit
 *            — catches network-level errors to/from Windsurf backend
 *
 * Both layers feed into a unified classifyError → debounced panic switch.
 *
 * Unlike the v24.0 SignalBridge (workbench DOM scraping + localStorage relay),
 * this approach works in-process with zero UI injection, catching errors at the
 * source before they even render to the user.
 */

import vscode from 'vscode';
import https from 'node:https';
import http from 'node:http';
import http2 from 'node:http2';
import { S, _logInfo, _logWarn, _logDebug } from './state.js';
import { _parseResetSeconds } from './defense.js';
import { _doPoolRotate } from './scheduler.js';

// ═══ Constants ═══

const DEDUP_WINDOW_MS = 1500;
const AUTO_SWITCH_DEBOUNCE_MS = 30_000;
const TARGET_HOSTS = [
  'server.codeium.com',
  'server.self-serve.windsurf.com',
  'web-backend.windsurf.com',
  'windsurf.com',
  'register.windsurf.com',
];
const VERBOSE_CHUNK_PREVIEW = 240;
const VERBOSE_BODY_PREVIEW = 600;
const VERBOSE_MAX_CHUNKS_PER_STREAM = 50;
const VERBOSE_MAX_BODY_BYTES = 8192;

function _isVerbose() {
  return vscode.workspace.getConfiguration('wam').get('cascadeMonitorVerbose', false);
}

function _previewValue(v, max = VERBOSE_CHUNK_PREVIEW) {
  if (v == null) return String(v);
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) + `…(+${v.length - max})` : v;
  if (typeof v === 'object') {
    try {
      const json = JSON.stringify(v);
      return json.length > max ? json.slice(0, max) + `…(+${json.length - max})` : json;
    } catch { return '[unserializable]'; }
  }
  return String(v);
}

function _describeChunk(chunk) {
  if (chunk == null) return `<${chunk}>`;
  if (typeof chunk !== 'object') return `<${typeof chunk}> ${_previewValue(chunk, 120)}`;
  // Buffer / Uint8Array
  if (chunk instanceof Uint8Array || (chunk?.constructor?.name === 'Buffer')) {
    let txt = '';
    try { txt = Buffer.from(chunk).toString('utf-8'); } catch {}
    return `<bytes ${chunk.byteLength || chunk.length}> ${_previewValue(txt, 200)}`;
  }
  const keys = Object.keys(chunk);
  return `<obj keys=[${keys.slice(0, 12).join(',')}${keys.length > 12 ? `,+${keys.length - 12}` : ''}]> ${_previewValue(chunk, VERBOSE_CHUNK_PREVIEW)}`;
}

// ═══ Module state ═══

let _installed = false;
let _layer1Installed = false;
let _layer2Installed = false;
let _lastErrorTs = 0;
let _lastAutoSwitchTs = 0;
let _layer2Originals = null;
let _layer1Uninstall = null;
let _context = null;

// ═══ Stats (for diagnostic logging) ═══
const _stats = {
  l1Calls: 0,
  l1AsyncWraps: 0,
  l1StreamWraps: 0,
  l1Errors: 0,
  l1ChunkHits: 0,
  l2FetchCalls: 0,
  l2HttpsCalls: 0,
  l2HttpCalls: 0,
  l2ErrResponses: 0,
  l2BodyHits: 0,
  dispatches: 0,
  switches: 0,
  startedAt: Date.now(),
};
const _firstSeenMethods = new Set();
const _firstSeenHosts = new Set();
let _statsTimer = null;

function _logStatsSummary() {
  const uptime = Math.round((Date.now() - _stats.startedAt) / 1000);
  _logInfo(
    'CascadeMonitor',
    `[stats ${uptime}s] L1: calls=${_stats.l1Calls} async=${_stats.l1AsyncWraps} stream=${_stats.l1StreamWraps} chunkHits=${_stats.l1ChunkHits} errors=${_stats.l1Errors} | L2: fetch=${_stats.l2FetchCalls} https=${_stats.l2HttpsCalls} http=${_stats.l2HttpCalls} err4xx=${_stats.l2ErrResponses} bodyHits=${_stats.l2BodyHits} | dispatch=${_stats.dispatches} panic=${_stats.switches}`,
  );
}

// ═══ Error Classification ═══

/**
 * Classify error message into actionable category.
 * Returns: 'rate_limit' | 'permission' | 'auth' | 'network' | 'unknown'
 */
export function classifyError(msg) {
  if (!msg) return 'unknown';
  const s = String(msg).toLowerCase();
  if (
    s.includes('rate limit') || s.includes('rate-limit') ||
    s.includes('global rate') || s.includes('over their global') ||
    s.includes('quota') || s.includes('too many requests') || s.includes('429')
  ) return 'rate_limit';
  if (
    s.includes('permission denied') || s.includes('permission_denied') ||
    s.includes('forbidden') || s.includes('access denied') || s.includes('403')
  ) return 'permission';
  if (
    s.includes('unauthorized') || s.includes('invalid token') ||
    s.includes('token expired') || s.includes('invalid api key') ||
    s.includes('not authenticated') || s.includes('401')
  ) return 'auth';
  if (
    s.includes('timeout') || s.includes('econnreset') ||
    s.includes('econnrefused') || s.includes('etimedout')
  ) return 'network';
  return 'unknown';
}

// ═══ Capture log (统一信号捕获轨迹, 便于 grep "\[CAPTURE\]") ═══

let _captureSeq = 0;

/**
 * Centralized signal-capture log.
 * Every rate-limit/permission/auth signal that crosses the monitor produces
 * one uniform line that is easy to grep & analyze post-mortem.
 *
 * Format:
 *   [CAPTURE #N layer=L1|L2 src=<source> kind=<kind> activeIdx=K] msg="..." extra=...
 */
function _logCapture(layer, source, kind, message, extra = null) {
  _captureSeq++;
  const snippet = String(message ?? '').slice(0, 400).replace(/\s+/g, ' ');
  const extraStr = extra ? ` extra=${JSON.stringify(extra)}` : '';
  const activeEmail = S.activeIndex >= 0 ? (S.am?.get?.(S.activeIndex)?.email || '?') : 'none';
  const fn = (kind === 'rate_limit' || kind === 'permission' || kind === 'auth') ? _logWarn : _logInfo;
  fn(
    'CascadeMonitor',
    `[CAPTURE #${_captureSeq} layer=${layer} src=${source} kind=${kind} activeIdx=${S.activeIndex} email=${activeEmail.split('@')[0]}] msg="${snippet}"${extraStr}`,
  );
}

// ═══ Core dispatch ═══

function _dispatchError(source, kind, message) {
  const now = Date.now();
  _stats.dispatches++;
  const snippet = String(message).slice(0, 300).replace(/\s+/g, ' ');

  if (now - _lastErrorTs < DEDUP_WINDOW_MS) {
    _logDebug('CascadeMonitor', `[dedup] 距上次错误${now - _lastErrorTs}ms < ${DEDUP_WINDOW_MS}ms, 跳过 [${kind}] ${source}`);
    return;
  }
  _lastErrorTs = now;

  _logInfo('CascadeMonitor', `[dispatch] kind=${kind} source=${source} msg="${snippet}"`);

  // Only actionable errors trigger auto-switch
  if (kind !== 'rate_limit' && kind !== 'permission' && kind !== 'auth') {
    _logDebug('CascadeMonitor', `[skip] kind=${kind} 不触发切号`);
    return;
  }

  const enabled = vscode.workspace.getConfiguration('wam').get('cascadeMonitorEnabled', true);
  if (!enabled) {
    _logInfo('CascadeMonitor', `[skip] wam.cascadeMonitorEnabled=false`);
    return;
  }

  if (now - _lastAutoSwitchTs < AUTO_SWITCH_DEBOUNCE_MS) {
    _logInfo('CascadeMonitor', `[debounce] 距上次切号${Math.round((now - _lastAutoSwitchTs) / 1000)}s < ${AUTO_SWITCH_DEBOUNCE_MS / 1000}s, 跳过`);
    return;
  }
  _lastAutoSwitchTs = now;
  _stats.switches++;

  _logWarn('CascadeMonitor', `[panic-switch] 触发 kind=${kind} source=${source} activeIndex=${S.activeIndex}`);

  // Mark current account as rate-limited
  if (S.activeIndex >= 0) {
    const cooldown = _parseResetSeconds(message) || 300;
    _logInfo('CascadeMonitor', `[mark-rl] 标记 #${S.activeIndex + 1} 限流, cooldown=${cooldown}s`);
    S.am.markRateLimited(S.activeIndex, cooldown, {
      model: 'current',
      trigger: `cascade_monitor:${kind}`,
      type: kind === 'rate_limit' ? 'tier_cap' : kind,
    });
  }

  // Fire-and-forget panic switch
  const t0 = Date.now();
  _doPoolRotate(_context, true)
    .then(() => _logInfo('CascadeMonitor', `[panic-switch] 完成 (${Date.now() - t0}ms)`))
    .catch(err => _logWarn('CascadeMonitor', `[panic-switch] 失败 (${Date.now() - t0}ms): ${err.message}`));
}

// ═══ Layer 1: Hook codeium.windsurf extension ═══

function _looksLikeLSClient(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const proto = Object.getPrototypeOf(obj);
  if (!proto) return false;
  const methods = Object.getOwnPropertyNames(proto);
  const markers = ['cascade', 'trajectory', 'stream', 'send', 'message'];
  let hits = 0;
  for (const m of methods) {
    const lower = m.toLowerCase();
    if (markers.some(k => lower.includes(k))) hits++;
  }
  return hits >= 2;
}

/**
 * Resolve an export to a hookable target.
 * Returns { target, kind } where kind is:
 *   - 'instance': singleton/instance — hook own + proto chain on the instance
 *   - 'prototype': class constructor — hook the prototype directly (affects all instances)
 */
function _resolveClientTarget(exported) {
  if (!exported) return null;
  // Pattern A: singleton namespace with getInstance() → instance.client
  if (typeof exported.getInstance === 'function') {
    try {
      const inst = exported.getInstance();
      if (inst?.client && typeof inst.client === 'object') return { target: inst.client, kind: 'instance', why: 'getInstance().client' };
      if (inst && typeof inst === 'object') return { target: inst, kind: 'instance', why: 'getInstance()' };
    } catch (e) {
      _logDebug('CascadeMonitor', `_resolveClientTarget: getInstance() threw: ${e?.message}`);
    }
  }
  // Pattern B: exports.client directly
  if (exported.client && typeof exported.client === 'object') {
    return { target: exported.client, kind: 'instance', why: '.client' };
  }
  // Pattern C: function with prototype that has cascade-like methods (class constructor)
  if (typeof exported === 'function' && exported.prototype) {
    const proto = exported.prototype;
    const names = Object.getOwnPropertyNames(proto).filter(m => m !== 'constructor');
    const fnCount = names.filter(m => {
      try { return typeof proto[m] === 'function'; } catch { return false; }
    }).length;
    if (fnCount >= 3) {
      return { target: proto, kind: 'prototype', why: `class.prototype(${fnCount} fns)` };
    }
  }
  // Pattern D: object that itself looks like LSC
  if (typeof exported === 'object' && _looksLikeLSClient(exported)) {
    return { target: exported, kind: 'instance', why: 'looksLikeClient' };
  }
  // Pattern E: lazy factory function (arrow/async fn with no prototype, no getInstance)
  // why: Newer Windsurf wraps devClient as `() => clientInstance`. Calling it returns
  // the underlying instance. Sync call is safe — these are pure getters in practice.
  if (typeof exported === 'function' && !exported.prototype) {
    try {
      const result = exported();
      // Async factory → Promise<client>
      if (result && typeof result.then === 'function') {
        return { target: result, kind: 'promise', why: 'asyncFactory' };
      }
      if (result && typeof result === 'object') {
        if (result.client && typeof result.client === 'object') {
          return { target: result.client, kind: 'instance', why: 'factory().client' };
        }
        return { target: result, kind: 'instance', why: 'factory()' };
      }
    } catch (e) {
      _logDebug('CascadeMonitor', `Pattern E call failed: ${e?.message}`);
    }
  }
  return null;
}

function _hookPrototype(targetClass, keywords) {
  const proto = typeof targetClass === 'function' ? targetClass.prototype : null;
  if (!proto) {
    _logWarn('CascadeMonitor', `[L1:hookProto] targetClass 不是 function (typeof=${typeof targetClass}) — 无法 hook`);
    return null;
  }

  const originals = new Map();
  const allNames = Object.getOwnPropertyNames(proto).filter(m => m !== 'constructor');
  _logInfo('CascadeMonitor', `[L1:hookProto] prototype 共 ${allNames.length} 个属性: ${allNames.slice(0, 25).join(', ')}${allNames.length > 25 ? '...' : ''}`);

  const allMethods = allNames.filter(m => {
    try {
      const desc = Object.getOwnPropertyDescriptor(proto, m);
      const ok = desc && typeof desc.value === 'function' && desc.configurable !== false;
      if (!ok && allNames.length < 30) {
        _logDebug('CascadeMonitor', `[L1:hookProto] 跳过 ${m}: value=${typeof desc?.value} configurable=${desc?.configurable}`);
      }
      return ok;
    } catch { return false; }
  });
  _logInfo('CascadeMonitor', `[L1:hookProto] 其中 ${allMethods.length} 个可 hook (fn+configurable): ${allMethods.slice(0, 25).join(', ')}`);

  const methods = keywords && keywords.length > 0
    ? allMethods.filter(m => {
      const lower = m.toLowerCase();
      return keywords.some(k => lower.includes(k));
    })
    : allMethods;
  _logInfo('CascadeMonitor', `[L1:hookProto] 关键词过滤后: ${methods.length}/${allMethods.length} 个 (keywords=${keywords?.join(',') || 'ALL'})`);

  if (methods.length === 0) {
    _logWarn('CascadeMonitor', `[L1:hookProto] 0 个方法匹配关键词, 跳过`);
    return null;
  }

  for (const name of methods) {
    try {
      const original = proto[name];
      originals.set(name, original);

      proto[name] = function (...args) {
        _stats.l1Calls++;
        if (!_firstSeenMethods.has(name)) {
          _firstSeenMethods.add(name);
          _logInfo('CascadeMonitor', `[L1:first-call] ${name}(${args.length} args)`);
        }
        let result;
        try {
          result = original.apply(this, args);
        } catch (e) {
          _logWarn('CascadeMonitor', `[L1:sync-throw] ${name}: ${e?.message || e}`);
          _onMethodError(name, e);
          throw e;
        }
        return _wrapResult(result, name);
      };
    } catch {}
  }

  _logInfo('CascadeMonitor', `[L1:install] hooked ${originals.size} methods: ${[...originals.keys()].slice(0, 12).join(', ')}${originals.size > 12 ? '...' : ''}`);
  return () => {
    for (const [name, fn] of originals) {
      try { proto[name] = fn; } catch {}
    }
  };
}

function _wrapResult(result, methodName) {
  if (result == null) return result;
  // Promise
  if (result && typeof result.then === 'function') {
    _stats.l1AsyncWraps++;
    return result.then(
      v => v,
      e => {
        _logWarn('CascadeMonitor', `[L1:async-reject] ${methodName}: ${e?.message || e}`);
        _onMethodError(methodName, e);
        throw e;
      },
    );
  }
  // AsyncIterable (streaming)
  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    _stats.l1StreamWraps++;
    _logDebug('CascadeMonitor', `[L1:stream-wrap] ${methodName}`);
    return _wrapAsyncIterable(result, methodName);
  }
  return result;
}

function _wrapAsyncIterable(iterable, methodName) {
  const verbose = _isVerbose();
  const streamId = `${methodName}#${(_stats.l1StreamWraps).toString(36)}`;
  let chunkCount = 0;
  const t0 = Date.now();
  if (verbose) _logInfo('CascadeMonitor', `[L1:stream-open] ${streamId}`);
  return {
    [Symbol.asyncIterator]() {
      const iter = iterable[Symbol.asyncIterator]();
      return {
        async next() {
          try {
            const item = await iter.next();
            if (item.done) {
              if (verbose) _logInfo('CascadeMonitor', `[L1:stream-close] ${streamId} chunks=${chunkCount} dur=${Date.now() - t0}ms`);
            } else {
              chunkCount++;
              if (verbose && chunkCount <= VERBOSE_MAX_CHUNKS_PER_STREAM) {
                _logInfo('CascadeMonitor', `[L1:chunk] ${streamId} #${chunkCount} ${_describeChunk(item.value)}`);
              }
              _scanChunk(item.value, methodName);
            }
            return item;
          } catch (e) {
            if (verbose) _logWarn('CascadeMonitor', `[L1:stream-throw] ${streamId} chunks=${chunkCount}: ${e?.message || e}`);
            _onMethodError(methodName, e);
            throw e;
          }
        },
        return: (v) => typeof iter.return === 'function' ? iter.return(v) : { done: true, value: v },
        throw: (e) => typeof iter.throw === 'function' ? iter.throw(e) : Promise.reject(e),
      };
    },
  };
}

function _scanChunk(chunk, methodName) {
  if (!chunk || typeof chunk !== 'object') return;
  const fieldNames = ['error', 'errorMessage', 'error_message', 'error_state', 'failureReason', 'failure_reason', 'status'];
  for (const fname of fieldNames) {
    const f = chunk[fname];
    if (!f) continue;
    const msg = typeof f === 'object' ? (f.message ?? f.text ?? f.detail ?? JSON.stringify(f).slice(0, 300)) : String(f);
    if (msg && _looksLikeRateLimitError(msg)) {
      _stats.l1ChunkHits++;
      const kind = classifyError(msg);
      _logCapture('L1', `stream:${methodName}`, kind, msg, {
        field: fname,
        chunkKeys: Object.keys(chunk).slice(0, 12),
      });
      _onMethodError(`${methodName}<stream>`, new Error(msg));
      return;
    }
  }
}

function _looksLikeRateLimitError(s) {
  const lower = s.toLowerCase();
  return lower.includes('rate limit') || lower.includes('denied') ||
    lower.includes('quota') || lower.includes('forbidden') ||
    lower.includes('over their') || lower.includes('too many');
}

function _onMethodError(methodName, error) {
  _stats.l1Errors++;
  const msg = error instanceof Error ? error.message : String(error);
  const kind = classifyError(msg);
  if (kind === 'unknown' || kind === 'network') {
    _logDebug('CascadeMonitor', `[L1:classify-skip] ${methodName} kind=${kind} msg="${msg.slice(0, 150)}"`);
    return;
  }
  // stream-error path already produced [CAPTURE] in _scanChunk; avoid duplicate.
  if (!methodName.endsWith('<stream>')) {
    _logCapture('L1', `throw:${methodName}`, kind, msg, {
      errorName: error?.name,
      stackTop: error?.stack ? String(error.stack).split('\n')[0] : null,
    });
  }
  _dispatchError(`L1:${methodName}`, kind, msg);
}

async function _installLayer1() {
  try {
    // why: Windsurf 内置不同版本 publisher id 可能变化, 尝试多个常见 id
    const candidateIds = ['codeium.windsurf', 'Codeium.windsurf', 'windsurf.windsurf', 'codeium.codeium'];
    let ext = null;
    let foundId = '';
    for (const id of candidateIds) {
      const e = vscode.extensions.getExtension(id);
      if (e) { ext = e; foundId = id; break; }
    }
    if (!ext) {
      // 列出所有 windsurf / codeium / cascade 相关扩展, 便于诊断
      const all = vscode.extensions.all
        .map(e => e.id)
        .filter(id => /windsurf|codeium|cascade/i.test(id));
      _logWarn('CascadeMonitor', `Layer1: 未找到 codeium.windsurf 扩展 (尝试: ${candidateIds.join(', ')}). 现有相关扩展: ${all.join(', ') || '<none>'}`);
      return false;
    }
    _logInfo('CascadeMonitor', `Layer1: 找到扩展 ${foundId} (active=${ext.isActive})`);
    if (!ext.isActive) {
      _logInfo('CascadeMonitor', `Layer1: 激活 ${foundId}...`);
      await ext.activate();
    }
    const exports = ext.exports;
    if (!exports || typeof exports !== 'object') {
      _logWarn('CascadeMonitor', `Layer1: ${foundId}.exports 为空 (typeof=${typeof exports}). 该 Windsurf 版本可能未暴露内部 API, 此时只能依赖 Layer2 网络层拦截`);
      return false;
    }

    const keys = Object.keys(exports);
    _logInfo('CascadeMonitor', `Layer1: ${foundId}.exports keys(${keys.length}): ${keys.slice(0, 30).join(', ')}${keys.length > 30 ? '...' : ''}`);

    // Step 1: resolve hookable target (instance OR class.prototype)
    let resolved = null;
    let matchedKey = '';
    for (const key of keys) {
      try {
        const v = exports[key];
        const r = _resolveClientTarget(v);
        if (r) { resolved = r; matchedKey = key; break; }
      } catch (e) {
        _logDebug('CascadeMonitor', `Layer1: 探测 exports.${key} 异常: ${e?.message}`);
      }
    }

    if (!resolved) {
      const dump = keys.slice(0, 20).map(k => {
        try {
          const v = exports[k];
          const t = typeof v;
          let detail = '';
          if (t === 'function') {
            const ownStatics = Object.getOwnPropertyNames(v).slice(0, 8).join(',');
            const protoNames = v.prototype ? Object.getOwnPropertyNames(v.prototype).filter(n => n !== 'constructor').slice(0, 8).join(',') : '<no proto>';
            const src = String(v).slice(0, 120).replace(/\s+/g, ' ');
            detail = `static=[${ownStatics}] proto=[${protoNames}] src="${src}"`;
          } else if (t === 'object' && v) {
            detail = `keys=[${Object.keys(v).slice(0, 8).join(',')}] protoCtor=${Object.getPrototypeOf(v)?.constructor?.name || '?'}`;
          }
          return `${k}=${t}{${detail}}`;
        } catch { return `${k}=<err>`; }
      }).join(' | ');
      _logWarn('CascadeMonitor', `Layer1: 未识别的 export 形态. ${dump}`);
      return false;
    }

    // Handle async factory → await the promise
    let { target, kind, why } = resolved;
    if (kind === 'promise') {
      _logInfo('CascadeMonitor', `Layer1: async factory detected, awaiting...`);
      try {
        const awaited = await target;
        if (awaited && typeof awaited === 'object') {
          const inner = awaited.client || awaited;
          target = inner;
          kind = 'instance';
          why += `→awaited(${Object.getOwnPropertyNames(inner).length} props)`;
        } else {
          _logWarn('CascadeMonitor', `Layer1: async factory 返回非 object (typeof=${typeof awaited})`);
          return false;
        }
      } catch (e) {
        _logWarn('CascadeMonitor', `Layer1: async factory await failed: ${e?.message}`);
        return false;
      }
    }
    _logInfo('CascadeMonitor', `Layer1: 命中 exports.${matchedKey} (kind=${kind}, why=${why})`);

    // Step 2: collect callable methods.
    //  - kind=instance: own props + proto chain (hook on instance, shadows proto)
    //  - kind=prototype: methods on the prototype itself (hook on prototype)
    const methodMap = new Map(); // name → { original, src }
    if (kind === 'instance') {
      try {
        for (const name of Object.getOwnPropertyNames(target)) {
          if (name === 'constructor') continue;
          try {
            if (typeof target[name] === 'function') {
              methodMap.set(name, { original: target[name], src: 'own' });
            }
          } catch {}
        }
      } catch {}
      let p = Object.getPrototypeOf(target);
      let depth = 0;
      while (p && p !== Object.prototype && depth < 5) {
        for (const name of Object.getOwnPropertyNames(p)) {
          if (name === 'constructor' || methodMap.has(name)) continue;
          try {
            const desc = Object.getOwnPropertyDescriptor(p, name);
            if (!desc || typeof desc.value !== 'function') continue;
            methodMap.set(name, { original: desc.value, src: `proto[${depth}]` });
          } catch {}
        }
        p = Object.getPrototypeOf(p);
        depth++;
      }
    } else {
      // kind === 'prototype'
      for (const name of Object.getOwnPropertyNames(target)) {
        if (name === 'constructor') continue;
        try {
          const desc = Object.getOwnPropertyDescriptor(target, name);
          if (!desc || typeof desc.value !== 'function') continue;
          if (desc.configurable === false && desc.writable === false) {
            _logDebug('CascadeMonitor', `Layer1: 跳过不可写 ${name}`);
            continue;
          }
          methodMap.set(name, { original: desc.value, src: 'proto', configurable: desc.configurable });
        } catch {}
      }
    }

    _logInfo('CascadeMonitor', `Layer1: ${kind} 可见方法 ${methodMap.size} 个: ${[...methodMap.keys()].slice(0, 30).join(', ')}${methodMap.size > 30 ? '...' : ''}`);

    if (methodMap.size === 0) {
      _logWarn('CascadeMonitor', `Layer1: 0 个方法可 hook (kind=${kind})`);
      return false;
    }

    // Step 3: install hooks on the appropriate target
    const restorers = [];
    let hookedCount = 0;
    for (const [name, info] of methodMap) {
      try {
        const original = info.original;
        const wrapper = function (...args) {
          _stats.l1Calls++;
          if (!_firstSeenMethods.has(name)) {
            _firstSeenMethods.add(name);
            _logInfo('CascadeMonitor', `[L1:first-call] ${name}(${args.length} args) [${info.src}]`);
          }
          let result;
          try {
            result = original.apply(this, args);
          } catch (e) {
            _logWarn('CascadeMonitor', `[L1:sync-throw] ${name}: ${e?.message || e}`);
            _onMethodError(name, e);
            throw e;
          }
          return _wrapResult(result, name);
        };
        Object.defineProperty(target, name, {
          configurable: true, writable: true, enumerable: true, value: wrapper,
        });
        restorers.push(() => {
          try {
            if (kind === 'instance' && info.src !== 'own') {
              delete target[name]; // unmask prototype method
            } else {
              target[name] = original;
            }
          } catch {}
        });
        hookedCount++;
      } catch (e) {
        _logDebug('CascadeMonitor', `Layer1: hook ${name} 失败: ${e?.message}`);
      }
    }

    _logInfo('CascadeMonitor', `[L1:install] 成功 hook ${hookedCount}/${methodMap.size} (kind=${kind})`);

    if (hookedCount === 0) {
      _logWarn('CascadeMonitor', 'Layer1: 0 个方法 hook 成功');
      return false;
    }

    _layer1Uninstall = () => { for (const r of restorers) r(); };
    _layer1Installed = true;
    return true;
  } catch (e) {
    _logWarn('CascadeMonitor', `Layer1 install failed: ${e.message}\n${e.stack}`);
    return false;
  }
}

// ═══ Layer 2: Network hook (fetch + http + https) ═══

function _isTargetHost(url) {
  if (!url) return false;
  try {
    const hostname = typeof url === 'string'
      ? new URL(url).hostname
      : (url.hostname || url.host || '');
    return TARGET_HOSTS.some(h => hostname.includes(h));
  } catch { return false; }
}

function _extractUrl(args, protocol) {
  if (!args || args.length === 0) return '';
  const first = args[0];
  if (typeof first === 'string') return first.startsWith('http') ? first : `${protocol}//${first}`;
  if (first instanceof URL) return first.href;
  if (first && typeof first === 'object') {
    const host = first.hostname || first.host || '';
    const path = first.path || '/';
    return host ? `${protocol}//${host}${path}` : '';
  }
  return '';
}

function _scanResponseBody(body, url) {
  if (!body) return;
  const host = (() => { try { return new URL(url).hostname; } catch { return 'unknown'; } })();
  const verbose = _isVerbose();
  // ReadableStream (fetch response.body)
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let chunkIdx = 0;
    let totalBytes = 0;
    let aggregated = '';
    const read = () => {
      reader.read().then(({ done, value }) => {
        if (done) {
          if (verbose) _logInfo('CascadeMonitor', `[L2:fetch-body-end] host=${host} chunks=${chunkIdx} bytes=${totalBytes}`);
          return;
        }
        chunkIdx++;
        try {
          const text = decoder.decode(value, { stream: true });
          totalBytes += value?.byteLength || text.length;
          if (verbose && chunkIdx <= 10) {
            _logInfo('CascadeMonitor', `[L2:fetch-chunk] host=${host} #${chunkIdx} ${_previewValue(text, VERBOSE_CHUNK_PREVIEW)}`);
          }
          if (aggregated.length < VERBOSE_MAX_BODY_BYTES) aggregated += text;
          if (_looksLikeRateLimitError(text)) {
            _stats.l2BodyHits++;
            const kind = classifyError(text);
            _logCapture('L2', `fetch:${host}`, kind, text, {
              chunkIdx,
              totalBytes,
              path: (() => { try { return new URL(url).pathname; } catch { return '?'; } })(),
            });
            if (kind !== 'unknown' && kind !== 'network') {
              _dispatchError(`L2:fetch:${host}`, kind, text.slice(0, 300));
            }
          }
        } catch {}
        if (chunkIdx > 50) return;
        read();
      }).catch(() => {});
    };
    read();
  }
}

function _attachResponseScanner(clientReq, url) {
  if (!clientReq || !url || !_isTargetHost(url)) return;
  const host = (() => { try { return new URL(url).hostname; } catch { return 'unknown'; } })();
  const path = (() => { try { return new URL(url).pathname; } catch { return '?'; } })();
  const verbose = _isVerbose();
  if (!_firstSeenHosts.has(host)) {
    _firstSeenHosts.add(host);
    _logInfo('CascadeMonitor', `[L2:first-host] ${host} 首次拦截`);
  }
  if (verbose) _logInfo('CascadeMonitor', `[L2:http-req] ${host}${path}`);
  try {
    clientReq.on('response', (res) => {
      const sc = res?.statusCode || 0;
      if (verbose) _logInfo('CascadeMonitor', `[L2:http-resp] ${host}${path} status=${sc}`);
      // Verbose: capture body for ALL responses (sampled). Non-verbose: only 4xx/5xx.
      const captureBody = verbose || sc >= 400;
      if (!captureBody) return;
      if (sc >= 400) _stats.l2ErrResponses++;
      let chunks = [];
      let chunkIdx = 0;
      let totalBytes = 0;
      res.on('data', (chunk) => {
        chunkIdx++;
        totalBytes += chunk?.byteLength || chunk?.length || 0;
        if (chunks.length < 5) chunks.push(chunk);
        if (verbose && chunkIdx <= 5) {
          _logInfo('CascadeMonitor', `[L2:http-chunk] ${host}${path} #${chunkIdx} ${_describeChunk(chunk)}`);
        }
      });
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf-8').slice(0, VERBOSE_MAX_BODY_BYTES);
          const kind = classifyError(text);
          if (verbose) {
            _logInfo('CascadeMonitor', `[L2:http-end] ${host}${path} status=${sc} chunks=${chunkIdx} bytes=${totalBytes} kind=${kind} body="${_previewValue(text, VERBOSE_BODY_PREVIEW)}"`);
          }
          if (sc >= 400 && kind !== 'unknown' && kind !== 'network') {
            _logCapture('L2', `http:${host}${path}`, kind, text, { status: sc, chunks: chunkIdx, bytes: totalBytes });
            _dispatchError(`L2:http:${sc}`, kind, text.slice(0, 300));
          }
        } catch {}
        chunks = null;
      });
    });
  } catch {}
}

function _installLayer2() {
  try {
    const origFetch = globalThis.fetch;
    const origHttpsReq = https.request;
    const origHttpReq = http.request;

    let fetchHooked = false;
    let httpsHooked = false;
    let httpHooked = false;

    // Hook fetch
    if (typeof origFetch === 'function') {
      const wrappedFetch = async function (...args) {
        const resp = await origFetch.apply(this, args);
        try {
          const url = args[0] instanceof Request ? args[0].url
            : typeof args[0] === 'string' ? args[0]
            : args[0]?.href || '';
          if (_isTargetHost(url)) {
            _stats.l2FetchCalls++;
            const verbose = _isVerbose();
            const host = (() => { try { return new URL(url).hostname; } catch { return 'unknown'; } })();
            const path = (() => { try { return new URL(url).pathname; } catch { return '?'; } })();
            if (!_firstSeenHosts.has(host)) {
              _firstSeenHosts.add(host);
              _logInfo('CascadeMonitor', `[L2:first-host] ${host} (fetch) 首次拦截 status=${resp.status}`);
            }
            if (verbose) _logInfo('CascadeMonitor', `[L2:fetch-resp] ${host}${path} status=${resp.status}`);
            // Scan body when: verbose OR error status. Body cloning is cheap enough.
            const shouldScan = verbose || resp.status >= 400;
            if (shouldScan && resp.body) {
              if (resp.status >= 400) _stats.l2ErrResponses++;
              const cloned = resp.clone();
              _scanResponseBody(cloned.body, url);
            }
          }
        } catch {}
        return resp;
      };
      globalThis.fetch = wrappedFetch;
      fetchHooked = true;
    }

    // Hook https.request
    try {
      const wrappedHttps = function (...args) {
        const req = origHttpsReq.apply(this, args);
        const url = _extractUrl(args, 'https:');
        if (_isTargetHost(url)) _stats.l2HttpsCalls++;
        _attachResponseScanner(req, url);
        return req;
      };
      https.request = wrappedHttps;
      httpsHooked = true;
    } catch {}

    // Hook http.request
    try {
      const wrappedHttp = function (...args) {
        const req = origHttpReq.apply(this, args);
        const url = _extractUrl(args, 'http:');
        if (_isTargetHost(url)) _stats.l2HttpCalls++;
        _attachResponseScanner(req, url);
        return req;
      };
      http.request = wrappedHttp;
      httpHooked = true;
    } catch {}

    // Hook http2.connect — captures gRPC traffic to local Language Server
    // why: Cascade 走本地 LS gRPC (HTTP/2), 错误 "Permission denied: all API providers..."
    // 是 LS 把云端响应通过 gRPC stream 传回, 不走 https.request
    let http2Hooked = false;
    const origHttp2Connect = http2.connect;
    try {
      http2.connect = function (authority, options, listener) {
        const session = origHttp2Connect.call(this, authority, options, listener);
        try {
          const authStr = typeof authority === 'string' ? authority : (authority?.href || String(authority));
          const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(authStr);
          if (isLocal || _isTargetHost(authStr)) {
            _logInfo('CascadeMonitor', `[L2:http2-connect] authority=${authStr}${isLocal ? ' (LS gRPC)' : ''}`);
            _wrapHttp2Session(session, authStr);
          }
        } catch (e) {
          _logDebug('CascadeMonitor', `[L2:http2-connect] wrap fail: ${e.message}`);
        }
        return session;
      };
      http2Hooked = true;
    } catch (e) {
      _logWarn('CascadeMonitor', `Layer2: http2 hook failed: ${e.message}`);
    }

    if (!fetchHooked && !httpsHooked && !httpHooked && !http2Hooked) {
      _logWarn('CascadeMonitor', 'Layer2: all hooks failed');
      return false;
    }

    _layer2Originals = {
      fetch: origFetch,
      httpsRequest: origHttpsReq,
      httpRequest: origHttpReq,
      http2Connect: origHttp2Connect,
    };
    _layer2Installed = true;
    _logInfo('CascadeMonitor', `Layer2: fetch=${fetchHooked ? '✓' : '✗'} https=${httpsHooked ? '✓' : '✗'} http=${httpHooked ? '✓' : '✗'} http2=${http2Hooked ? '✓' : '✗'}`);
    return true;
  } catch (e) {
    _logWarn('CascadeMonitor', `Layer2 install failed: ${e.message}`);
    return false;
  }
}

/**
 * Wrap an HTTP/2 ClientHttp2Session: intercept session.request() to scan all
 * inbound streams. why: gRPC framing (5-byte prefix + protobuf payload) means
 * we must scan raw bytes for human-readable error strings.
 */
function _wrapHttp2Session(session, authStr) {
  if (!session || typeof session.request !== 'function') return;
  if (session.__wamHookedH2) return;
  session.__wamHookedH2 = true;

  const origRequest = session.request;
  session.request = function (headers, options) {
    const stream = origRequest.call(this, headers, options);
    try {
      _stats.l2HttpsCalls++; // count as L2 traffic
      const path = (headers && headers[':path']) || '?';
      const verbose = _isVerbose();
      const host = authStr.replace(/^https?:\/\//, '').replace(/[:/].*$/, '') || 'localhost';
      if (!_firstSeenHosts.has(`h2:${host}`)) {
        _firstSeenHosts.add(`h2:${host}`);
        _logInfo('CascadeMonitor', `[L2:h2-first] host=${host} path=${path}`);
      }
      if (verbose) _logInfo('CascadeMonitor', `[L2:h2-req] ${host}${path}`);

      // Aggregate inbound bytes; scan for textual error markers.
      let chunks = [];
      let totalBytes = 0;
      let chunkIdx = 0;
      let respHeaders = null;

      stream.on('response', (h) => {
        respHeaders = h;
        const status = h?.[':status'] || 0;
        if (verbose) _logInfo('CascadeMonitor', `[L2:h2-resp] ${host}${path} status=${status}`);
      });
      stream.on('data', (chunk) => {
        chunkIdx++;
        totalBytes += chunk.length || 0;
        // Cap memory: keep first ~16KB
        if (totalBytes < 16384) chunks.push(chunk);
        // Live scan each chunk for early detection (gRPC streams can be long)
        try {
          const text = chunk.toString('utf-8');
          if (_looksLikeRateLimitError(text)) {
            const kind = classifyError(text);
            _logCapture('L2', `h2:${host}${path}`, kind, text, {
              chunkIdx,
              totalBytes,
              status: respHeaders?.[':status'],
            });
            if (kind !== 'unknown' && kind !== 'network') {
              _dispatchError(`L2:h2:${host}`, kind, text.slice(0, 300));
            }
          }
        } catch {}
      });
      stream.on('end', () => {
        if (verbose) {
          try {
            const text = Buffer.concat(chunks).toString('utf-8').slice(0, VERBOSE_BODY_PREVIEW);
            _logInfo('CascadeMonitor', `[L2:h2-end] ${host}${path} chunks=${chunkIdx} bytes=${totalBytes} body="${_previewValue(text, VERBOSE_BODY_PREVIEW)}"`);
          } catch {}
        }
        chunks = null;
      });
      stream.on('error', (err) => {
        const msg = err?.message || String(err);
        _logDebug('CascadeMonitor', `[L2:h2-stream-err] ${host}${path}: ${msg}`);
        const kind = classifyError(msg);
        if (kind !== 'unknown' && kind !== 'network') {
          _logCapture('L2', `h2-err:${host}${path}`, kind, msg);
          _dispatchError(`L2:h2-err:${host}`, kind, msg);
        }
      });
    } catch (e) {
      _logDebug('CascadeMonitor', `[L2:h2-wrap] error: ${e.message}`);
    }
    return stream;
  };
}

// ═══ Public API ═══

/**
 * Install cascade monitor (both layers).
 * Should be called once during extension activation.
 */
export async function installCascadeMonitor(context) {
  if (_installed) return { layer1: _layer1Installed, layer2: _layer2Installed };
  _installed = true;
  _context = context;

  const enabled = vscode.workspace.getConfiguration('wam').get('cascadeMonitorEnabled', true);
  if (!enabled) {
    _logInfo('CascadeMonitor', '已禁用 (wam.cascadeMonitorEnabled=false)');
    return { layer1: false, layer2: false };
  }

  // Layer 2 first (no async, instant)
  _installLayer2();

  // Layer 1 with delay (codeium.windsurf may not be active yet)
  setTimeout(async () => {
    const ok = await _installLayer1();
    if (ok) {
      _logInfo('CascadeMonitor', 'Layer1 安装成功 (prototype hook)');
    } else {
      _logInfo('CascadeMonitor', 'Layer1 未安装 (将依赖 Layer2 + SignalBridge)');
    }
  }, 5000);

  // Periodic stats summary (every 5min, helps diagnose traffic flow)
  if (!_statsTimer) {
    _statsTimer = setInterval(_logStatsSummary, 5 * 60 * 1000);
    if (typeof _statsTimer.unref === 'function') _statsTimer.unref();
  }

  return { layer1: _layer1Installed, layer2: _layer2Installed };
}

/**
 * Uninstall all hooks (for hot-reload or config toggle).
 */
export function uninstallCascadeMonitor() {
  _logStatsSummary();
  if (_layer1Uninstall) {
    _layer1Uninstall();
    _layer1Uninstall = null;
    _layer1Installed = false;
  }
  if (_layer2Originals) {
    if (_layer2Originals.fetch) globalThis.fetch = _layer2Originals.fetch;
    if (_layer2Originals.httpsRequest) https.request = _layer2Originals.httpsRequest;
    if (_layer2Originals.httpRequest) http.request = _layer2Originals.httpRequest;
    if (_layer2Originals.http2Connect) http2.connect = _layer2Originals.http2Connect;
    _layer2Originals = null;
    _layer2Installed = false;
  }
  if (_statsTimer) {
    clearInterval(_statsTimer);
    _statsTimer = null;
  }
  _installed = false;
  _logInfo('CascadeMonitor', '已卸载');
}

/**
 * Get current installation status + stats.
 */
export function getCascadeMonitorStatus() {
  return {
    installed: _installed,
    layer1: _layer1Installed,
    layer2: _layer2Installed,
    stats: { ..._stats, uptimeMs: Date.now() - _stats.startedAt },
    hookedMethods: [..._firstSeenMethods],
    interceptedHosts: [..._firstSeenHosts],
  };
}

/**
 * Manually log stats summary (callable via command for live debugging).
 */
export function logCascadeMonitorStats() {
  _logStatsSummary();
  _logInfo('CascadeMonitor', `hookedMethods(${_firstSeenMethods.size}): ${[..._firstSeenMethods].join(', ')}`);
  _logInfo('CascadeMonitor', `interceptedHosts(${_firstSeenHosts.size}): ${[..._firstSeenHosts].join(', ')}`);
}
