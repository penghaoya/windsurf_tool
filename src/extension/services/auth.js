/**
 * Auth Service — Devin-auth login + Protobuf/JSON 额度查询 + Token 缓存
 * 零外部依赖,纯 Node.js https/http/tls
 *
 * 认证链 (v23.4, Devin-only post-2026-05-04):
 *   1. CheckUserLoginMethod(email)
 *      → 主 probe: windsurf.com/_backend/.../CheckUserLoginMethod
 *      → fallback: windsurf.com/_devin-auth/connections (新旧两种 body shape 都支持)
 *      返回: { method: 'auth1', hasPassword: bool }
 *
 *   2. _devin-auth/password/login(email, password)
 *      → auth1Token
 *
 *   3. WindsurfPostAuth(auth1Token)
 *      → host 优先: windsurf.com/_backend/.../WindsurfPostAuth
 *      → fallback: web-backend.windsurf.com/.../WindsurfPostAuth
 *      → binary proto 优先, JSON fallback (多组织检测)
 *      返回: sessionToken (devin-session-token$xxx)
 *
 *   4. sessionToken 直接作为 IDE apiKey:
 *      a) 注入: vscode commands.executeCommand(
 *           'windsurf.provideAuthTokenToAuthProvider', sessionToken)
 *         或 fallback: 直接写 state.vscdb 的 windsurfAuthStatus.apiKey
 *      b) 额度查询: GetUserStatus(metadata.apiKey=sessionToken) → daily/weekly%
 *         (cascade gRPC 后端接受 sessionToken 与 sk-ws-01- 同等待遇)
 *
 * 兼容/降级路径:
 *   - cached idToken (Firebase 路径产物):
 *     securetoken.googleapis.com refreshToken endpoint silent renew —
 *     **不受 App Check 影响**, 老账号缓存仍可续命。
 *   - Firebase signInWithPassword: 自 2026-05-04 起 App Check 强制启用 →
 *     永久 401, 由 FIREBASE_LOGIN_ENABLED 常量统一关闭, 不再走主路径。
 *   - RegisterUser: 仅接受 firebase_id_token, 同样依赖 firebase 路径,
 *     当前为 deprecated 兼容 shim (无 active call site)。
 *
 * 安全保护:
 *   - devin-auth 并发上限 (DEVIN_AUTH_MAX_CONCURRENCY=2) + 启动间隔 500ms,
 *     防止冷启动 stampede 触发 backend 429。
 *   - devin-auth 429 指数退避 (60s→300s 上限) 全局冷却。
 *   - HTTPS host 三阶段熔断 (失败 3 次 fail-over to 直连, 6 次整体 fail-fast)。
 *
 * 参考: WindsurfAPI v2.0.90+ (windsurf-assistant v17.42.20 逆向)。
 */
import https from 'https';
import http from 'http';
import tls from 'tls';
import fs from 'fs';
import path from 'path';
import os from 'os';
// v23.5: per-account HTTP fingerprint binding — generation + persistence
// helpers live in fingerprint.js (single source of truth for ID + http
// profile) so the device IDs and the HTTP headers stay in lockstep.
import { generateHttpProfile, httpProfileToHeaders } from './fingerprint.js';
import { resolveModelProtoName } from '../shared/config.js';

// v22.1: Shared direct HTTPS agent — bypasses VS Code's global proxy interceptor
// VS Code patches https.globalAgent to route through its proxy settings.
// By using our own persistent agent, we ensure direct outbound connections.
const _directAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 6,
  maxFreeSockets: 2,
  timeout: 30000,
});
import {
  parseProtoString, encodeProtoString, parseUsageInfo, parseProtoMsg,
} from './protobuf.js';
import net from 'net';
import { execSync } from 'child_process';
import { getStateDbPath, dbReadKey, dbReadKeys, dbReadKeysLike, dbWriteKey } from '../infra/sqlite.js';
import { safeReadJsonSync, safeWriteJsonSync } from '../infra/safeJson.js';

// Firebase Web API Key used by Windsurf/Codeium clients.
const FIREBASE_KEYS = [
  'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY',
];

// Relay (works in China without proxy) — 已废弃, 401鉴权失败时无意义且常超时
// 保留数组结构以便将来注入新中转地址
const RELAYS = [];
// Windsurf gRPC endpoints (Connect-RPC over HTTPS)
const PLAN_STATUS_URLS = [
  'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus',
  'https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus',
  'https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus',
];
const REGISTER_URLS = [
  'https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser',
  'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/RegisterUser',
  'https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser',
];
const REGISTER_JSON_FALLBACK_URLS = [
  'https://api.codeium.com/exa.language_server_pb.LanguageServerService/RegisterUser',
  'https://server.codeium.com/exa.language_server_pb.LanguageServerService/RegisterUser',
];

// v20.1: 从50min降到30min — 实测服务端常在50min前就开始返回401 "missing auth token"
// (日志里大量 cached token failed, retrying fresh)。30min是保守上限，叠加JWT exp取min。
const TOKEN_TTL = 30 * 60 * 1000; // 30 minutes (Firebase idToken hard cap)
const AUTH1_TOKEN_TTL = 14 * 24 * 60 * 60 * 1000; // 14 days (Auth1 sessionToken, matches windsurf-switch)
const AUTH_PROVIDER_TTL = 24 * 60 * 60 * 1000;
// v23.2: 'unsupported-devin' is detection-based and may be wrong (server-side
// rule change, transient detection error, etc). Short TTL gives self-healing.
const UNSUPPORTED_DEVIN_TTL = 30 * 60 * 1000; // 30 minutes
const PROXY_HOST = '127.0.0.1';
const PROXY_PORTS = [7890, 7897, 7891, 10808, 1080, 8080, 8118, 3128, 9090]; // 按优先级探测
let ACTIVE_PROXY_PORT = 7890; // 当前生效端口（自动探测更新）
let PROXY_CHECKED = false;
let _probeDetail = { source: 'none', verified: false, lastProbe: 0 }; // 探测详情
// Cached last-known successful port (injected from globalState on activation).
// Probed first as fast path — saves ~5s on repeat sessions when proxy is stable.
let _lastKnownPort = 0;

// 双模式: 'local' = 本地代理, 'relay' = 网站中转(无需VPN)
let ACTIVE_MODE = 'local';

// v21.0 → v23.5: login fingerprint moved to instance method.
// Headers (Origin / Referer) are static; the OS / Chrome / Accept-Language
// fields come from the per-account http profile (see fingerprint.js).
// Static origin headers — same for every request, never randomized.
const _LOGIN_STATIC_HEADERS = {
  'Origin': 'https://windsurf.com',
  'Referer': 'https://windsurf.com/',
};

// 可注入日志函数 — setLogger() 注入后写入 outputChannel, 否则降级 console.log
let _info = (tag, msg) => console.log(`WAM: [${tag}] ${msg}`);
let _warn = (tag, msg) => console.log(`WAM: [WARN][${tag}] ${msg}`);
let _debug = (tag, msg) => { /* v20.3: 默认丢弃，由 extension.js 注入 _logDebug */ };
const HTTP_RAW_LOG_MAX = 1600;

function _formatRawForLog(value) {
  let raw = '';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    raw = Buffer.from(value).toString('utf8');
  } else if (typeof value === 'string') {
    raw = value;
  } else {
    try { raw = JSON.stringify(value); } catch { raw = String(value); }
  }
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) return '<empty>';
  const visible = /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(compact)
    ? JSON.stringify(compact)
    : compact;
  return visible.length > HTTP_RAW_LOG_MAX
    ? `${visible.slice(0, HTTP_RAW_LOG_MAX)}...<truncated:${visible.length}>`
    : visible;
}

function _warnHttpErrorRaw(kind, hostname, pathLabel, status, body) {
  _warn('HTTP_RAW', `${kind} ${hostname}${pathLabel} → ${status} raw=${_formatRawForLog(body)}`);
}

// Global cooldowns for upstream rate limits (process-wide, per-AuthService)
const DEVIN_AUTH_COOLDOWN_BASE_MS = 60_000; // after 429 on /_devin-auth/*
const DEVIN_AUTH_COOLDOWN_MAX_MS = 300_000; // v21.0: escalating max 5min
// v23.3: devin-auth concurrency cap — prevent stampede when Firebase App Check
// blocks the whole pool and every refresh suddenly falls back to devin-auth.
// Without this guard the windsurf backend trivially returns 429 and triggers the
// 60s global cooldown, killing the remaining accounts in the batch.
const DEVIN_AUTH_MAX_CONCURRENCY = 2;
const DEVIN_AUTH_MIN_START_GAP_MS = 500;
const DEVIN_AUTH_ACQUIRE_TIMEOUT_MS = 8_000;

// v22.3-22.4 / v24.2: 主机级 TLS 健康熔断 — 阈值和时长调优, 减少抖动误伤
// 阶段1: 失败 1-3 次 → 仍尝试 (网络抖动很常见)
// 阶段2: 失败 4 次 → 强制走直连模式 (跳过代理)
// 阶段3: 失败 8 次 → 整体 fail-fast (代理直连都不试, 立即抛错)
const PROXY_TLS_FAIL_THRESHOLD = 4;          // v24.2: 3→4, 给抖动多 1 次机会
const HOST_DEAD_THRESHOLD = 8;               // v24.2: 6→8, 唤醒场景的多次同步失败不会瞬秒
const PROXY_TLS_BREAKER_MS = 45_000;         // v24.2: 90s→45s, 上游恢复后更快试探
const HOST_DEAD_BREAKER_MS = 90_000;         // v24.2: 180s→90s, 减少误伤恢复期
const FIREBASE_APP_CHECK_BLOCK_MS = 30 * 60_000;  // App Check 命中后 30min 内全局跳过 Firebase
// v23.4: Firebase signInWithPassword (identitytoolkit) is dead since 2026-05-04.
// Google now demands App Check tokens that server-side / IDE callers cannot
// produce → every signInWithPassword returns 401 "Firebase App Check token is
// invalid". The Devin path (Auth1 → WindsurfPostAuth → sessionToken-as-apiKey)
// is the only viable one, mirroring WindsurfAPI v2.0.90+ and the upstream
// windsurf-assistant v17.42.20 reverse-engineering.
//
// Disabling the Firebase primary login path eliminates the predictable 401
// stampede on cold start (3 preheat candidates concurrently 401, triggering
// the global cooldown that then kills the remaining batch). The silent renew
// via securetoken.googleapis.com (refreshToken endpoint) is NOT App Check
// gated and stays enabled — accounts with a previously-stored refreshToken
// keep their cache alive cheaply.
//
// Flip back to true if upstream ever rescinds App Check enforcement.
const FIREBASE_LOGIN_ENABLED = false;

class AuthService {
  constructor(storagePath) {
    this._tokenCache = new Map(); // email -> { idToken, expireTime }
    this._providerCache = new Map(); // email -> { provider, expireTime }
    this._storagePath = storagePath || null;
    this._cachePath = null; // set lazily in _getCachePath()
    this._providerCachePath = null;
    this._devinAuthCooldownUntil = 0; // ts — skip devin-auth before this
    this._devinAuth429Count = 0;       // v21.0: consecutive 429 counter for escalating backoff
    // v23.3: devin-auth concurrency limiter state
    this._devinAuthInflight = 0;
    this._devinAuthLastStart = 0;
    // v22.3
    this._proxyTlsFailures = new Map();    // hostname -> { count, until }
    this._firebaseBlockedUntil = 0;        // App Check 命中后短期跳过 firebase
    // v24.2: 系统休眠检测 — macOS App Nap / 整机休眠会暂停 event loop, 唤醒后
    // 大量陈旧请求同时 timeout, 全部计入熔断会瞬间标记多 host_dead, 全池扫描全军覆没
    // 用 5s 心跳检测休眠 (实际间隔 >> 5s 即休眠), 唤醒后清空熔断 + 直连 socket pool
    this._lastTickTs = Date.now();
    this._sleepResetUntil = 0;             // 唤醒后 30s 内不计入熔断 (避免误伤)
    this._startSleepWatchdog();
    // v23.5: AccountManager handle for per-account HTTP fingerprint lookup.
    // Wired up by extension.js after both services are constructed.
    this._accountManager = null;
    this._loadCache();
    this._loadProviderCache();
    // P1 fix: proxy probing is lazy — runs on first network request, not at construction
    // This prevents TCP socket operations during Extension Host activation
  }

  /** v24.2: 5s 心跳检测系统休眠/唤醒 — 实际间隔 >> 5s 即视为唤醒 */
  _startSleepWatchdog() {
    const HEARTBEAT_MS = 5_000;
    const SLEEP_THRESHOLD_MS = 15_000;     // 心跳间隔 >15s 视为休眠
    const RESET_GRACE_MS = 30_000;         // 唤醒后宽限 30s
    setInterval(() => {
      const now = Date.now();
      const elapsed = now - this._lastTickTs;
      this._lastTickTs = now;
      if (elapsed > SLEEP_THRESHOLD_MS) {
        const sleepSec = Math.round(elapsed / 1000);
        this._sleepResetUntil = now + RESET_GRACE_MS;
        this._proxyTlsFailures.clear();
        this._devinAuthCooldownUntil = 0;
        this._devinAuth429Count = 0;
        try { _directAgent.destroy(); } catch {}
        if (typeof _warn === 'function') {
          _warn('网络', `检测到系统休眠 ${sleepSec}s, 已清空熔断状态 + socket pool`);
        }
      }
    }, HEARTBEAT_MS).unref();
  }

  /** v23.5: late-bind the AccountManager so login fingerprints can be
   *  cached/looked-up per account. Called from extension.js wiring. */
  bindAccountManager(am) {
    this._accountManager = am || null;
  }

  /** v23.5: Per-account HTTP login fingerprint.
   *  - Cached: same email → same User-Agent / sec-ch-ua / Accept-Language forever.
   *  - First-call: generates a profile, persists it under account.fingerprint.http,
   *    so subsequent logins of this email reuse it.
   *  - No email or no AccountManager: returns a one-shot ephemeral profile (e.g.
   *    early activation paths) without persisting — keeps backward compat.
   *
   *  Closes the v23.5 anti-fingerprint hole: previously every login generated
   *  a fresh UA, so the same hardware ID looked like 3-5 different browsers
   *  across a few switches — a textbook anti-fraud signature.
   */
  _generateLoginFingerprint(email) {
    let profile = null;
    const am = this._accountManager;
    if (email && am && typeof am.getHttpProfileByEmail === 'function') {
      profile = am.getHttpProfileByEmail(email);
      if (!profile) {
        profile = generateHttpProfile();
        try { am.setHttpProfileForEmail(email, profile); } catch {}
      }
    } else {
      // Ephemeral: pre-bind activation, anonymous probes, etc.
      profile = generateHttpProfile();
    }
    return { ...httpProfileToHeaders(profile), ..._LOGIN_STATIC_HEADERS };
  }

  // ========== v22.3-22.4: Host Connection Circuit Breaker ==========

  /** 阶段2: 代理熔断中 (走直连) */
  _isProxyTlsBroken(hostname) {
    const entry = this._proxyTlsFailures.get(hostname);
    if (!entry) return false;
    if (Date.now() > entry.until) {
      this._proxyTlsFailures.delete(hostname);
      return false;
    }
    return entry.count >= PROXY_TLS_FAIL_THRESHOLD;
  }

  /** 阶段3: host 整体不可达 (代理直连都不试, fail-fast) */
  _isHostDead(hostname) {
    const entry = this._proxyTlsFailures.get(hostname);
    if (!entry) return false;
    if (Date.now() > entry.until) {
      this._proxyTlsFailures.delete(hostname);
      return false;
    }
    return entry.count >= HOST_DEAD_THRESHOLD;
  }

  _recordProxyTlsResult(hostname, ok) {
    if (ok) {
      this._proxyTlsFailures.delete(hostname);
      return;
    }
    // v24.2: 唤醒宽限期内不计入熔断 — 避免休眠唤醒一次性吃掉阈值
    if (Date.now() < this._sleepResetUntil) return;
    const entry = this._proxyTlsFailures.get(hostname) || { count: 0, until: 0 };
    entry.count++;
    // 整体不可达使用更长的熔断窗口
    entry.until = Date.now() + (entry.count >= HOST_DEAD_THRESHOLD ? HOST_DEAD_BREAKER_MS : PROXY_TLS_BREAKER_MS);
    this._proxyTlsFailures.set(hostname, entry);
    if (entry.count === PROXY_TLS_FAIL_THRESHOLD) {
      _warn('HTTP', `${hostname} 连接连续失败${entry.count}次, ${PROXY_TLS_BREAKER_MS / 1000}s 内走直连`);
    } else if (entry.count === HOST_DEAD_THRESHOLD) {
      _warn('HTTP', `${hostname} 整体不可达 (代理+直连均失败 ${entry.count} 次), ${HOST_DEAD_BREAKER_MS / 1000}s 内 fail-fast`);
    }
  }

  _isFirebaseAppCheckBlocked() {
    return Date.now() < this._firebaseBlockedUntil;
  }

  _markFirebaseAppCheckBlocked() {
    this._firebaseBlockedUntil = Date.now() + FIREBASE_APP_CHECK_BLOCK_MS;
  }

  /** 注入结构化日志 (extension.js 初始化时调用) */
  setLogger(logInfo, logWarn, logDebug) {
    if (logInfo) _info = logInfo;
    if (logWarn) _warn = logWarn;
    if (logDebug) _debug = logDebug;
  }

  // ========== Proxy Auto-Detection (智能多源探测) ==========

  /** 从系统/环境变量读取代理配置 */
  _detectSystemProxy() {
    const candidates = [];
    // Source 1: Environment variables (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY)
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
      const val = process.env[key];
      if (!val) continue;
      try {
        const u = new URL(val);
        const host = u.hostname || '127.0.0.1';
        const port = parseInt(u.port);
        if (port > 0 && port < 65536) {
          candidates.push({ host, port, source: `env:${key}` });
        }
      } catch {}
    }
    // Source 2: Windows registry proxy (best-effort, non-blocking)
    if (process.platform === 'win32') {
      try {
        const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer 2>nul', { timeout: 2000, encoding: 'utf8' });
        const m = out.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
        if (m) {
          const proxy = m[1].trim();
          // Format: host:port or http=host:port;https=host:port
          const parts = proxy.includes('=') ? proxy.split(';').map(s => s.split('=').pop()) : [proxy];
          for (const p of parts) {
            const [h, pStr] = p.split(':');
            const port = parseInt(pStr);
            if (h && port > 0) candidates.push({ host: h, port, source: 'registry' });
          }
        }
      } catch {}
    }
    return candidates;
  }

  /** TCP端口连通性检测 */
  _tcpProbe(host, port, timeoutMs = 800) {
    return new Promise(resolve => {
      const sock = new net.Socket();
      sock.setTimeout(timeoutMs);
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
      sock.connect(port, host);
    });
  }

  /** 验证代理真正可达外网 — 用 Windsurf 实际 endpoint 作为验证目标
   *  优于 google.com: 中文区只走国内的代理仍能生效 (server.codeium.com 是 CN 可达) */
  _verifyProxyReachability(host, port, timeoutMs = 5000) {
    return new Promise(resolve => {
      try {
        const req = http.request({
          hostname: host, port, method: 'CONNECT',
          path: 'server.codeium.com:443', timeout: timeoutMs
        });
        req.on('connect', (res, socket) => {
          socket.destroy();
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
      } catch { resolve(false); }
    });
  }

  /** 加载上次成功端口 (extension activation 时调用) */
  setLastKnownPort(port) {
    const n = parseInt(port);
    if (Number.isFinite(n) && n > 0 && n < 65536) _lastKnownPort = n;
  }

  /** 智能探测：TUN直连 → 缓存端口 → 系统代理 → 端口扫描 → relay */
  async _probeProxy() {
    if (PROXY_CHECKED) return;
    const startTs = Date.now();

    // Phase -1: TUN/VPN 直连探测 — 默认优先, 适配 Clash TUN / 系统级 VPN
    // 直接对 windsurf.com:443 做 TCP probe, 能通即说明系统层透明转发可用
    // 优于走 HTTP 代理: 少一跳, 避免代理层 BAD_DECRYPT/TLS handshake 失败
    const tunOk = await this._tcpProbe('windsurf.com', 443, 1500);
    if (tunOk) {
      ACTIVE_MODE = 'direct';
      PROXY_CHECKED = true;
      _probeDetail = { source: 'tun_direct', verified: true, lastProbe: Date.now(), host: 'windsurf.com', elapsed: Date.now() - startTs };
      _info('代理', `direct (TUN/VPN) works → 跳过代理探测 (${_probeDetail.elapsed}ms)`);
      return;
    }

    // Phase 0: Cached port fast-path — most users keep proxy stable across sessions
    if (_lastKnownPort > 0) {
      const ok = await this._tcpProbe(PROXY_HOST, _lastKnownPort, 600);
      if (ok) {
        ACTIVE_PROXY_PORT = _lastKnownPort;
        ACTIVE_MODE = 'local';
        PROXY_CHECKED = true;
        _probeDetail = { source: `cached:${_lastKnownPort}`, verified: false, lastProbe: Date.now(), host: PROXY_HOST, elapsed: Date.now() - startTs };
        _info('代理', `proxy detected on cached port ${_lastKnownPort} (${_probeDetail.elapsed}ms)`);
        return;
      }
    }

    // Phase 1: System/env proxy candidates (sequential — usually 0–2 entries)
    let bestUnverified = null;
    const sysCandidates = this._detectSystemProxy();
    for (const c of sysCandidates) {
      const portOk = await this._tcpProbe(c.host, c.port, 600);
      if (portOk) {
        const reachable = await this._verifyProxyReachability(c.host, c.port, 3000);
        if (reachable) {
          ACTIVE_PROXY_PORT = c.port;
          ACTIVE_MODE = 'local';
          PROXY_CHECKED = true;
          _probeDetail = { source: c.source, verified: true, lastProbe: Date.now(), host: c.host, elapsed: Date.now() - startTs };
          _info('代理', `proxy verified via ${c.source} → ${c.host}:${c.port} (${_probeDetail.elapsed}ms)`);
          return;
        }
        // Port open but failed verify — hold as last-resort fallback (don't pollute global state yet)
        if (!bestUnverified) bestUnverified = { host: c.host, port: c.port, source: c.source };
      }
    }

    // Phase 2: Parallel scan of common VPN ports on localhost
    // Each TCP probe is independent; running them concurrently caps worst-case at 1× timeout (600ms) instead of 9×.
    const probes = await Promise.all(
      PROXY_PORTS.map(p => this._tcpProbe(PROXY_HOST, p, 600).then(ok => ok ? p : -1))
    );
    // Pick first port in PROXY_PORTS priority order that's open
    const detectedPort = probes.find(p => p > 0);
    if (detectedPort > 0) {
      ACTIVE_PROXY_PORT = detectedPort;
      ACTIVE_MODE = 'local';
      PROXY_CHECKED = true;
      _probeDetail = { source: `scan:${detectedPort}`, verified: false, lastProbe: Date.now(), host: PROXY_HOST, elapsed: Date.now() - startTs };
      _info('代理', `proxy detected on port ${detectedPort} (${_probeDetail.elapsed}ms)`);
      return;
    }

    // Phase 3: Fall back to Phase 1 unverified candidate, or relay mode
    if (bestUnverified) {
      ACTIVE_PROXY_PORT = bestUnverified.port;
      ACTIVE_MODE = 'local';
      PROXY_CHECKED = true;
      _probeDetail = { source: bestUnverified.source, verified: false, lastProbe: Date.now(), host: bestUnverified.host, elapsed: Date.now() - startTs };
      _warn('代理', `proxy port open via ${bestUnverified.source} → ${bestUnverified.host}:${bestUnverified.port} (unverified, ${_probeDetail.elapsed}ms)`);
      return;
    }

    ACTIVE_MODE = 'relay';
    PROXY_CHECKED = true;
    _probeDetail = { source: 'none', verified: false, lastProbe: Date.now(), elapsed: Date.now() - startTs };
    _warn('代理', `no local proxy found, using relay mode (${_probeDetail.elapsed}ms)`);
  }

  /** 强制重新探测（切换网络环境后调用） */
  async reprobeProxy() {
    PROXY_CHECKED = false;
    await this._probeProxy();
    return { mode: ACTIVE_MODE, port: ACTIVE_PROXY_PORT };
  }

  /** 获取当前模式和端口 */
  getProxyStatus() {
    return { mode: ACTIVE_MODE, port: ACTIVE_PROXY_PORT, checked: PROXY_CHECKED, detail: _probeDetail };
  }

  /** 手动切换模式 — local | relay | direct (TUN/VPN, 跳过代理但用主域名) */
  setMode(mode) {
    if (mode === 'local' || mode === 'relay' || mode === 'direct') {
      ACTIVE_MODE = mode;
      PROXY_CHECKED = true;
      _info('代理', `mode switched to ${mode}`);
    }
  }

  /** 手动设置代理端口 */
  setPort(port) {
    if (port > 0 && port < 65536) {
      ACTIVE_PROXY_PORT = port;
      ACTIVE_MODE = 'local';
      PROXY_CHECKED = true;
      _info('代理', `proxy port manually set to ${port}`);
    }
  }

  _getCachePath() {
    if (this._cachePath) return this._cachePath;
    if (!this._storagePath) return null;
    try { if (!fs.existsSync(this._storagePath)) fs.mkdirSync(this._storagePath, { recursive: true }); } catch {}
    this._cachePath = path.join(this._storagePath, 'wam-token-cache.json');
    // One-time migration from legacy globalStorage root (P0 fix)
    if (!fs.existsSync(this._cachePath)) {
      try {
        const legacyPath = this._getLegacyCachePath();
        if (legacyPath && fs.existsSync(legacyPath)) {
          fs.copyFileSync(legacyPath, this._cachePath);
          _info('迁移', 'migrated token cache from legacy location');
        }
      } catch {}
    }
    return this._cachePath;
  }

  _getLegacyCachePath() {
    const p = process.platform;
    let base;
    if (p === 'win32') {
      base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      base = path.join(base, 'Windsurf', 'User', 'globalStorage');
    } else if (p === 'darwin') {
      base = path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage');
    } else {
      base = path.join(os.homedir(), '.config', 'Windsurf', 'User', 'globalStorage');
    }
    return path.join(base, 'wam-token-cache.json');
  }

  _getProviderCachePath() {
    if (this._providerCachePath !== null) return this._providerCachePath;
    const tokenPath = this._getCachePath();
    this._providerCachePath = tokenPath
      ? path.join(path.dirname(tokenPath), 'wam-auth-provider-cache.json')
      : null;
    return this._providerCachePath;
  }

  // ========== Token Cache (disk-persistent in globalStorage, 50min TTL) ==========

  _loadCache() {
    try {
      const p = this._getCachePath();
      if (!p) return;
      const data = safeReadJsonSync(p, {});
      const now = Date.now();
      for (const [email, entry] of Object.entries(data)) {
        if (entry.expireTime > now) {
          this._tokenCache.set(email, entry);
        }
      }
    } catch {}
  }

  _saveCache() {
    try {
      const p = this._getCachePath();
      if (!p) return;
      const obj = {};
      this._tokenCache.forEach((v, k) => { obj[k] = v; });
      safeWriteJsonSync(p, obj);
    } catch {}
  }

  _getCachedToken(email) {
    const entry = this._tokenCache.get(email);
    if (entry && entry.expireTime > Date.now()) return entry.idToken;
    // don't delete entry — refreshToken may still be usable for silent renew
    return null;
  }

  _setCachedToken(email, idToken, refreshToken = null) {
    // v20.1: 先从JWT exp取精确值(提前2min buffer), 然后叠加TOKEN_TTL硬上限取min
    // 避免服务端比exp提前失效 / exp字段缺失时用满50min导致大量401
    const hardCap = Date.now() + TOKEN_TTL;
    let jwtExp = null;
    try {
      const parts = idToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (payload.exp) jwtExp = payload.exp * 1000 - 120000;
      }
    } catch {}
    // Firebase idToken: min(JWT exp, 30min硬上限)
    let expireTime = jwtExp ? Math.min(jwtExp, hardCap) : hardCap;
    // v20.0: Auth1 sessionToken is not standard JWT (无exp), use 14-day TTL
    // 但仅当没拿到 JWT exp 时才用长TTL, 有JWT字段的走标准路径
    const provider = this._getCachedAuthProvider(email);
    if (!jwtExp && (provider === 'devin-auth' || provider === 'auth1')) {
      expireTime = Date.now() + AUTH1_TOKEN_TTL;
    }
    const entry = { idToken, expireTime };
    // preserve existing refreshToken if caller doesn't provide a new one
    if (refreshToken) {
      entry.refreshToken = refreshToken;
    } else {
      const existing = this._tokenCache.get(email);
      if (existing?.refreshToken) entry.refreshToken = existing.refreshToken;
    }
    this._tokenCache.set(email, entry);
    this._saveCache();
  }

  /**
   * Silently renew idToken via Firebase refresh_token endpoint.
   * Avoids re-sending password and bypasses App Check.
   */
  async _refreshIdToken(email) {
    const entry = this._tokenCache.get(email);
    if (!entry?.refreshToken) return null;
    const _emailPrefix = email.split('@')[0];
    for (const key of FIREBASE_KEYS) {
      const url = `https://securetoken.googleapis.com/v1/token?key=${key}`;
      const formBody = `grant_type=refresh_token&refresh_token=${encodeURIComponent(entry.refreshToken)}`;
      try {
        const r = await this._httpsForm(url, formBody);
        if (r.ok && r.data.id_token) {
          this._setCachedToken(email, r.data.id_token, r.data.refresh_token || entry.refreshToken);
          const provider = this._getCachedAuthProvider(email);
          _info('登录', `${_emailPrefix} → refreshToken OK`);
          return { ok: true, idToken: r.data.id_token, email, channel: 'refresh_token', provider };
        }
        const msg = r.data?.error?.message || `HTTP ${r.status}`;
        if (this._isFatalFirebaseAuthError(msg)) {
          _warn('登录', `${_emailPrefix} → refreshToken fatal: ${msg}`);
          entry.refreshToken = null;
          this._saveCache();
          return null;
        }
      } catch (e) {
        _warn('登录', `${_emailPrefix} → refreshToken failed: ${e.message}`);
      }
    }
    return null;
  }

  _httpsForm(url, formBody) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname, port: 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(formBody),
          Referer: 'https://windsurf.com/',
          Origin: 'https://windsurf.com',
        },
        timeout: 10_000,
      }, (res) => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => {
          try { resolve({ ok: res.statusCode === 200, status: res.statusCode, data: JSON.parse(buf) }); }
          catch { resolve({ ok: res.statusCode === 200, status: res.statusCode, data: {} }); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('refreshToken request timeout')); });
      req.write(formBody);
      req.end();
    });
  }

  clearTokenCache(email) {
    if (email) this._tokenCache.delete(email);
    else this._tokenCache.clear();
    this._saveCache();
  }

  _loadProviderCache() {
    try {
      const p = this._getProviderCachePath();
      if (!p) return;
      const data = safeReadJsonSync(p, {});
      const now = Date.now();
      let capped = 0;
      for (const [email, entry] of Object.entries(data)) {
        if (entry?.provider && entry.expireTime > now) {
          // v23.2: legacy unsupported-devin entries used 24h TTL → cap to 30min so
          // an upgrade doesn't keep accounts stuck for the rest of the original window.
          if (entry.provider === 'unsupported-devin') {
            const newExpire = now + UNSUPPORTED_DEVIN_TTL;
            if (entry.expireTime > newExpire) {
              entry.expireTime = newExpire;
              capped++;
            }
          }
          this._providerCache.set(email, entry);
        }
      }
      if (capped > 0) {
        // best-effort persist so the cap survives next launch
        this._saveProviderCache();
      }
    } catch {}
  }

  _saveProviderCache() {
    try {
      const p = this._getProviderCachePath();
      if (!p) return;
      const obj = {};
      this._providerCache.forEach((v, k) => { obj[k] = v; });
      safeWriteJsonSync(p, obj);
    } catch {}
  }

  _getCachedAuthProvider(email) {
    const key = (email || '').trim().toLowerCase();
    const entry = this._providerCache.get(key);
    if (entry && entry.expireTime > Date.now()) return entry.provider;
    this._providerCache.delete(key);
    return null;
  }

  _setCachedAuthProvider(email, provider) {
    const key = (email || '').trim().toLowerCase();
    if (!key || !provider) return;
    // v23.2: shorter TTL for tentative negative results
    const ttl = provider === 'unsupported-devin' ? UNSUPPORTED_DEVIN_TTL : AUTH_PROVIDER_TTL;
    this._providerCache.set(key, {
      provider,
      expireTime: Date.now() + ttl,
    });
    this._saveProviderCache();
  }

  _clearAuthProviderCache(email) {
    const key = (email || '').trim().toLowerCase();
    if (key) this._providerCache.delete(key);
    else this._providerCache.clear();
    this._saveProviderCache();
  }

  // ========== HTTP Helpers (with proxy support for China) ==========

  _needsProxy(hostname) {
    return /googleapis\.com|google\.com|codeium\.com|windsurf\.com/.test(hostname);
  }

  /** Create CONNECT tunnel through HTTP proxy, return TLS socket
   *  v22.3: 显式 TLS 握手超时 — 原代码 tls.connect 无超时, CONNECT 成功后
   *         若上游 TLS 协商挂死会等到 OS socket timeout (~30s), 导致整体卡死 */
  _proxyTunnel(hostname) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

      const proxyReq = http.request({
        hostname: PROXY_HOST, port: ACTIVE_PROXY_PORT,
        method: 'CONNECT', path: `${hostname}:443`, timeout: 8000
      });
      proxyReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) { socket.destroy(); return settle(reject, new Error(`proxy CONNECT ${res.statusCode}`)); }

        // TLS handshake watchdog — 6s upper bound for handshake completion
        const tlsTimer = setTimeout(() => {
          try { socket.destroy(); } catch {}
          settle(reject, new Error('TLS handshake timeout'));
        }, 6000);

        const tlsSocket = tls.connect({ socket, servername: hostname, rejectUnauthorized: true }, () => {
          clearTimeout(tlsTimer);
          settle(resolve, tlsSocket);  // resolve regardless of authorized/alpn (still usable)
        });
        tlsSocket.on('error', e => { clearTimeout(tlsTimer); settle(reject, e); });
      });
      proxyReq.on('error', e => settle(reject, e));
      proxyReq.on('timeout', () => { proxyReq.destroy(); settle(reject, new Error('proxy timeout')); });
      proxyReq.end();
    });
  }

  /** Raw HTTPS request over a TLS socket (for proxy path) */
  _rawRequest(tlsSocket, hostname, pathStr, method, headers, bodyData) {
    return new Promise((resolve, reject) => {
      let reqLine = `${method} ${pathStr} HTTP/1.1\r\n`;
      reqLine += `Host: ${hostname}\r\n`;
      for (const [k, v] of Object.entries(headers)) reqLine += `${k}: ${v}\r\n`;
      if (bodyData) reqLine += `Content-Length: ${Buffer.byteLength(bodyData)}\r\n`;
      reqLine += `Connection: close\r\n\r\n`;
      tlsSocket.write(reqLine);
      if (bodyData) tlsSocket.write(bodyData);

      const chunks = [];
      tlsSocket.on('data', c => chunks.push(c));
      tlsSocket.on('end', () => {
        const raw = Buffer.concat(chunks).toString('binary');
        const idx = raw.indexOf('\r\n\r\n');
        if (idx < 0) return reject(new Error('no HTTP header boundary'));
        const headerPart = raw.substring(0, idx);
        let bodyPart = raw.substring(idx + 4);
        const statusMatch = headerPart.match(/HTTP\/1\.[01] (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1]) : 0;
        // Decode chunked transfer encoding (P0 fix: Firebase via proxy uses chunked)
        if (/transfer-encoding:\s*chunked/i.test(headerPart)) {
          bodyPart = this._decodeChunked(bodyPart);
        }
        resolve({ status, ok: status === 200, headerPart, bodyBuffer: Buffer.from(bodyPart, 'binary') });
      });
      tlsSocket.on('error', e => reject(e));
      setTimeout(() => { tlsSocket.destroy(); reject(new Error('request timeout')); }, 12000);
    });
  }

  /** Decode HTTP chunked transfer encoding */
  _decodeChunked(raw) {
    const parts = [];
    let pos = 0;
    while (pos < raw.length) {
      const lineEnd = raw.indexOf('\r\n', pos);
      if (lineEnd < 0) break;
      const sizeStr = raw.substring(pos, lineEnd).trim();
      const chunkSize = parseInt(sizeStr, 16);
      if (isNaN(chunkSize) || chunkSize === 0) break;
      const dataStart = lineEnd + 2;
      if (dataStart + chunkSize > raw.length) {
        parts.push(raw.substring(dataStart));
        break;
      }
      parts.push(raw.substring(dataStart, dataStart + chunkSize));
      pos = dataStart + chunkSize + 2; // skip chunk data + trailing \r\n
    }
    return parts.join('');
  }

  _httpsJson(url, method, body, useProxy, extraHeaders = {}) {
    return new Promise(async (resolve, reject) => {
      const _t0 = Date.now();
      const u = new URL(url);
      const data = body ? JSON.stringify(body) : null;

      // v22.4: host 整体不可达 → fail-fast (避免徒劳重试)
      if (this._isHostDead(u.hostname)) {
        return reject(new Error(`host_dead:${u.hostname}`));
      }

      // 三模式: local 按需代理 / relay 跳代理+中转 / direct (TUN/VPN) 跳代理+主域名
      let wantProxy;
      if (useProxy !== undefined) wantProxy = useProxy;
      else if (ACTIVE_MODE === 'relay' || ACTIVE_MODE === 'direct') wantProxy = false;
      else wantProxy = this._needsProxy(u.hostname);

      // v22.3: 该 host 代理熔断中 → 强制走直连
      if (wantProxy && this._isProxyTlsBroken(u.hostname)) {
        wantProxy = false;
      }

      const hdrs = { 'Content-Type': 'application/json', ...extraHeaders };

      if (wantProxy) {
        try {
          const sock = await this._proxyTunnel(u.hostname);
          const resp = await this._rawRequest(sock, u.hostname, u.pathname + u.search, method || 'GET', hdrs, data);
          const rawText = resp.bodyBuffer.toString('utf8');
          // v22.7→v24.0: 代理篡改/截断检测 — 200 但 body 几乎为空
          // 仅当 body 不是合法 JSON 时才判为代理坏 (真正的 RST/strip 返回 0 字节或 HTML)
          // 合法 JSON 如 {} 说明服务端正常响应,只是无数据 (如 CheckUserLoginMethod cold start)
          if (resp.ok && rawText.length < 8) {
            let isValidJson = false;
            try { const p = JSON.parse(rawText); isValidJson = p !== null && typeof p === 'object'; } catch {}
            if (!isValidJson) {
              this._recordProxyTlsResult(u.hostname, false);
              _warn('HTTP', `JSON ${u.hostname}${u.pathname} → 200+empty body (proxy, ${Date.now() - _t0}ms) 视为代理坏`);
              reject(new Error('proxy_empty_body'));
              return;
            }
          }
          this._recordProxyTlsResult(u.hostname, true);
          if (!resp.ok) {
            // v20.4: HTTP + HTTP_RAW 合并为单行 (减少日志条数)
            _warn('HTTP', `JSON ${u.hostname}${u.pathname} → ${resp.status} (proxy, ${Date.now() - _t0}ms) raw=${_formatRawForLog(rawText)}`);
          }
          try { resolve({ ok: resp.ok, status: resp.status, data: JSON.parse(rawText), raw: rawText, viaProxy: true }); }
          catch { resolve({ ok: resp.ok, status: resp.status, data: {}, raw: rawText, viaProxy: true }); }
        } catch (e) {
          // v22.7: 扩大匹配 — boundary/empty/reset/hang up 都是代理质量问题, 计入熔断
          if (/tls|socket|disconnected|timeout|econn|boundary|empty|reset|hang/i.test(e.message || '')) {
            this._recordProxyTlsResult(u.hostname, false);
          }
          _warn('HTTP', `JSON ${u.hostname}${u.pathname} → ERR ${e.message} (proxy, ${Date.now() - _t0}ms)`);
          reject(e);
        }
      } else {
        let settled = false;
        const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
        const req = https.request({
          hostname: u.hostname, port: 443, path: u.pathname + u.search,
          method: method || 'GET', headers: hdrs, agent: _directAgent
        }, (res) => {
          let buf = '';
          res.on('data', c => buf += c);
          res.on('end', () => {
            clearTimeout(wallClock);
            if (res.statusCode !== 200) {
              _warn('HTTP', `JSON ${u.hostname}${u.pathname} → ${res.statusCode} (direct, ${Date.now() - _t0}ms) raw=${_formatRawForLog(buf)}`);
            }
            try { settle(resolve, { ok: res.statusCode === 200, status: res.statusCode, data: JSON.parse(buf), raw: buf }); }
            catch { settle(resolve, { ok: res.statusCode === 200, status: res.statusCode, data: {}, raw: buf }); }
          });
          res.on('error', () => { clearTimeout(wallClock); settle(reject, new Error('response error')); });
        });
        // v22.4 / v24.2: wall-clock timeout 8s→12s (中美跨境 SYN+TLS 常需 ~6s)
        const wallClock = setTimeout(() => {
          try { req.destroy(); } catch {}
          if (!settled) {
            this._recordProxyTlsResult(u.hostname, false);  // direct timeout 也计入熔断
            _warn('HTTP', `JSON ${u.hostname}${u.pathname} → TIMEOUT (direct, ${Date.now() - _t0}ms)`);
            settle(reject, new Error('connect timeout'));
          }
        }, 12000);
        req.on('error', e => {
          clearTimeout(wallClock);
          if (/econn|socket|hang up|timeout/i.test(e.message || '')) {
            this._recordProxyTlsResult(u.hostname, false);
          }
          _warn('HTTP', `JSON ${u.hostname}${u.pathname} → ERR ${e.message} (direct, ${Date.now() - _t0}ms)`);
          settle(reject, e);
        });
        if (data) req.write(data);
        req.end();
      }
    });
  }

  _httpsBinary(url, method, bodyBuffer, useProxy, extraHeaders = {}) {
    return new Promise(async (resolve, reject) => {
      const _t0 = Date.now();
      const u = new URL(url);

      // v22.4: host 整体不可达 → fail-fast
      if (this._isHostDead(u.hostname)) {
        return reject(new Error(`host_dead:${u.hostname}`));
      }

      let wantProxy;
      if (useProxy !== undefined) wantProxy = useProxy;
      else if (ACTIVE_MODE === 'relay' || ACTIVE_MODE === 'direct') wantProxy = false;
      else wantProxy = this._needsProxy(u.hostname);

      // v22.3: 代理熔断 → 直连
      if (wantProxy && this._isProxyTlsBroken(u.hostname)) {
        wantProxy = false;
      }

      if (wantProxy) {
        try {
          const sock = await this._proxyTunnel(u.hostname);
          const headers = {
            'Content-Type': 'application/proto',
            'connect-protocol-version': '1',
            ...extraHeaders,
          };
          const resp = await this._rawRequest(sock, u.hostname, u.pathname + u.search, method || 'POST', headers, bodyBuffer ? Buffer.from(bodyBuffer) : null);
          const bodyLen = resp.bodyBuffer?.length || 0;
          // v22.7: 200+empty 视为代理坏 (binary 路径同 JSON 路径)
          if (resp.ok && bodyLen < 4) {
            this._recordProxyTlsResult(u.hostname, false);
            _warn('HTTP', `BIN ${u.hostname}${u.pathname.split('/').pop()} → 200+empty (proxy, ${Date.now() - _t0}ms) 视为代理坏`);
            reject(new Error('proxy_empty_body'));
            return;
          }
          this._recordProxyTlsResult(u.hostname, true);
          if (!resp.ok) {
            _warn('HTTP', `BIN ${u.hostname}${u.pathname.split('/').pop()} → ${resp.status} ${bodyLen}B (proxy, ${Date.now() - _t0}ms) raw=${_formatRawForLog(resp.bodyBuffer)}`);
          }
          resolve({ ok: resp.ok, status: resp.status, buffer: resp.bodyBuffer });
        } catch (e) {
          if (/tls|socket|disconnected|timeout|econn|boundary|empty|reset|hang/i.test(e.message || '')) {
            this._recordProxyTlsResult(u.hostname, false);
          }
          _warn('HTTP', `BIN ${u.hostname}${u.pathname.split('/').pop()} → ERR ${e.message} (proxy, ${Date.now() - _t0}ms)`);
          reject(e);
        }
      } else {
        let settled = false;
        const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
        const headers = {
          'Content-Type': 'application/proto',
          'connect-protocol-version': '1',
          ...extraHeaders,
        };
        const req = https.request({
          hostname: u.hostname, port: 443, path: u.pathname + u.search,
          method: method || 'POST', headers, agent: _directAgent
        }, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            clearTimeout(wallClock);
            const buf = Buffer.concat(chunks);
            if (res.statusCode !== 200) {
              _warn('HTTP', `BIN ${u.hostname}${u.pathname.split('/').pop()} → ${res.statusCode} ${buf.length}B (direct, ${Date.now() - _t0}ms) raw=${_formatRawForLog(buf)}`);
            }
            settle(resolve, { ok: res.statusCode === 200, status: res.statusCode, buffer: buf });
          });
          res.on('error', () => { clearTimeout(wallClock); settle(reject, new Error('response error')); });
        });
        // v22.4 / v24.2: wall-clock timeout 8s→12s
        const wallClock = setTimeout(() => {
          try { req.destroy(); } catch {}
          if (!settled) {
            this._recordProxyTlsResult(u.hostname, false);
            _warn('HTTP', `BIN ${u.hostname}${u.pathname.split('/').pop()} → TIMEOUT (direct, ${Date.now() - _t0}ms)`);
            settle(reject, new Error('connect timeout'));
          }
        }, 12000);
        req.on('error', e => {
          clearTimeout(wallClock);
          if (/econn|socket|hang up|timeout/i.test(e.message || '')) {
            this._recordProxyTlsResult(u.hostname, false);
          }
          _warn('HTTP', `BIN ${u.hostname}${u.pathname.split('/').pop()} → ERR ${e.message} (direct, ${Date.now() - _t0}ms)`);
          settle(reject, e);
        });
        if (bodyBuffer) req.write(Buffer.from(bodyBuffer));
        req.end();
      }
    });
  }

  /** Try all relays for JSON endpoint, return first success */
  async _tryRelaysJson(path, body) {
    for (const relay of RELAYS) {
      try {
        const r = await this._httpsJson(`${relay}${path}`, 'POST', body, false);
        if (r.ok) return r;
        _warn('中转', `JSON ${relay}${path} → ${r.status} (non-ok)`);
      } catch (e) { _warn('中转', `JSON ${relay}${path} → ERR ${e.message}`); }
    }
    return null;
  }

  _recordHttpError(errors, source, status, body) {
    if (!Array.isArray(errors)) return;
    errors.push({ source, status, body });
  }

  _isMigratedAuthBody(body) {
    return /account\s+has\s+been\s+migrated|please\s+log\s+in\s+again/i.test(_formatRawForLog(body));
  }

  _hasMigratedAuthError(errors) {
    return (errors || []).some((error) => error?.status === 401 && this._isMigratedAuthBody(error.body));
  }

  // Auth-class failure — relay fallback won't help, only network errors should fall through to relay.
  _hasAuthFailure(errors) {
    return (errors || []).some((error) => error?.status === 401 || error?.status === 403);
  }

  /** Try all relays for binary endpoint, return first success */
  async _tryRelaysBinary(path, bodyBuffer, options = {}) {
    const errors = options.errors || null;
    for (const relay of RELAYS) {
      try {
        const r = await this._httpsBinary(`${relay}${path}`, 'POST', bodyBuffer, false);
        if (r && r.ok) return r;
        this._recordHttpError(errors, `${relay}${path}`, r?.status || 0, r?.buffer || null);
        _warn('中转', `BIN ${relay}${path} → ${r?.status || 'null'} (non-ok)`);
        if (options.stopOnMigrated && this._hasMigratedAuthError(errors)) return null;
      } catch (e) { _warn('中转', `BIN ${relay}${path} → ERR ${e.message}`); }
    }
    return null;
  }

  /** Try request on multiple URLs, return first success */
  async _raceUrls(urls, bodyBuffer, options = {}) {
    const errors = options.errors || null;
    for (const url of urls) {
      try {
        const resp = await this._httpsBinary(url, 'POST', bodyBuffer);
        if (resp.ok) return resp;
        this._recordHttpError(errors, url, resp?.status || 0, resp?.buffer || null);
        if (options.stopOnMigrated && this._hasMigratedAuthError(errors)) return null;
      } catch (e) { _warn('RACE', `${new URL(url).hostname} → ERR ${e.message}`); }
    }
    return null;
  }

  // ========== Devin Auth (Windsurf new auth backend) ==========

  _isTransientNetworkError(error) {
    const msg = String(error?.message || error || '').toLowerCase();
    return (
      msg.includes('tls') ||
      msg.includes('socket') ||
      msg.includes('network') ||
      msg.includes('econn') ||
      msg.includes('etimedout') ||
      msg.includes('timeout') ||
      msg.includes('disconnected before secure') ||
      /\bhttp\s*5\d{2}\b/i.test(msg)
    );
  }

  /** v20.4 (P0 fix): App Check token 错误不再视为 fatal
   *  原因: "Firebase App Check token is invalid" 是 Firebase 基础设施层的客户端
   *        身份验证失败 (与用户密码无关), 通常是 SDK token 临时失效或客户端被风控
   *        触发, 是 transient 错误。误判为 fatal 会导致大批正常账号被永久标记
   *        invalid_credentials。
   *  保留: INVALID_LOGIN_CREDENTIALS / EMAIL_NOT_FOUND / INVALID_PASSWORD /
   *        USER_DISABLED 才是真正的凭据级 fatal。
   *  v22.2: 增加 devin-auth 凭据错误识别 ("Invalid email or password") */
  _isFatalFirebaseAuthError(message) {
    const s = String(message || '');
    // Firebase credential errors
    if (/INVALID_LOGIN_CREDENTIALS|EMAIL_NOT_FOUND|INVALID_PASSWORD|USER_DISABLED/i.test(s)) return true;
    // devin-auth credential errors: "Invalid email or password" from /_devin-auth/password/login
    if (/invalid email or password/i.test(s)) return true;
    return false;
  }

  async _withNetworkRetry(label, fn, maxRetries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastError = e;
        // v22.4: 熔断命中 → fail fast, 不重试 (host_dead 表明已经多次失败)
        if (/^host_dead:/.test(e.message || '')) {
          _warn('登录', `${label} 熔断中, 跳过重试: ${e.message}`);
          throw e;
        }
        if (attempt < maxRetries && this._isTransientNetworkError(e)) {
          _warn('登录', `${label} 网络异常, 重试${attempt}/${maxRetries}: ${e.message}`);
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
          continue;
        }
        throw e;
      }
    }
    throw lastError || new Error(`${label} failed`);
  }

  _decodeProtoStringFields(buffer) {
    const fields = parseProtoMsg(buffer);
    const read = (field) => {
      const entry = fields[field]?.[0];
      if (!entry) return '';
      if (entry.string) return entry.string;
      if (entry.bytes) {
        try { return Buffer.from(entry.bytes).toString('utf8'); } catch {}
      }
      return '';
    };
    return {
      sessionToken: read(1),
      auth1Token: read(3),
      accountId: read(4),
      primaryOrgId: read(5),
    };
  }

  static WINDSURF_POST_AUTH_URLS = [
    'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth',
    'https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth',
  ];

  async _windsurfPostAuth(auth1Token, fp = null, accountId = '') {
    const protoBody = Buffer.concat([
      encodeProtoString(auth1Token, 1),
      encodeProtoString('', 2),
    ]);
    const protoHeaders = {
      Accept: 'application/proto',
      'X-Devin-Auth1-Token': auth1Token,
      ...(accountId ? { 'X-Devin-Account-Id': accountId } : {}),
      ...(fp || { 'User-Agent': 'Mozilla/5.0' }),
    };

    // Try binary proto on all endpoints first (faster, existing behavior)
    for (const url of AuthService.WINDSURF_POST_AUTH_URLS) {
      try {
        const resp = await this._httpsBinary(url, 'POST', protoBody, undefined, protoHeaders);
        if (resp?.ok && resp.buffer?.length) {
          return this._decodeProtoStringFields(resp.buffer);
        }
      } catch {}
    }

    // Fallback: JSON path (can detect multi-org accounts, referencing windsurf-switch)
    const jsonHeaders = {
      'X-Devin-Auth1-Token': auth1Token,
      'Connect-Protocol-Version': '1',
      ...(accountId ? { 'X-Devin-Account-Id': accountId } : {}),
      ...(fp || { Referer: 'https://windsurf.com/editor/signin' }),
    };
    for (const url of AuthService.WINDSURF_POST_AUTH_URLS) {
      try {
        const r = await this._httpsJson(url, 'POST', { auth1Token, orgId: '' }, undefined, jsonHeaders);
        if (r.ok && r.data) {
          // Multi-org check: server returns orgs array but no sessionToken
          if (Array.isArray(r.data.orgs) && r.data.orgs.length > 0 && !r.data.sessionToken) {
            throw new Error('此账号有多个组织,请先在 windsurf.com 网页端选好组织再来使用');
          }
          if (r.data.sessionToken) {
            return {
              sessionToken: r.data.sessionToken,
              auth1Token: r.data.auth1Token || auth1Token,
              accountId: String(r.data.accountId || ''),
              primaryOrgId: String(r.data.primaryOrgId || ''),
            };
          }
        }
      } catch (e) {
        // Re-throw multi-org error directly (user-facing)
        if (/多个组织/.test(e.message)) throw e;
      }
    }

    throw new Error('WindsurfPostAuth failed: all endpoints exhausted');
  }

  // v21.0: interpret connections response — supports BOTH old {auth_method:{method,has_password}}
  // and new {connections:[{id,type,enabled,client_id}...]} format (Windsurf 2026-04-26)
  static _interpretConnections(data) {
    if (data && Array.isArray(data.connections)) {
      const emailConn = data.connections.find(c => c && c.type === 'email');
      return { method: 'auth1', hasPassword: !!(emailConn && emailConn.enabled) };
    }
    if (data && data.auth_method) {
      return { method: data.auth_method.method || null, hasPassword: data.auth_method.has_password !== false };
    }
    return { method: null, hasPassword: false };
  }

  // v21.0: primary probe — CheckUserLoginMethod (Connect-RPC, fast+clean)
  async _checkUserLoginMethod(email, fp = null) {
    try {
      const r = await this._httpsJson(
        'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod',
        'POST',
        { email },
        undefined,
        { 'Connect-Protocol-Version': '1', ...(fp || {}) },
      );
      if (!r.ok || !r.data || typeof r.data !== 'object') return null;
      // Empty body (cold start) — defer to legacy probe
      const hasUserField = Object.prototype.hasOwnProperty.call(r.data, 'userExists');
      const hasPwField = Object.prototype.hasOwnProperty.call(r.data, 'hasPassword');
      if (!hasUserField && !hasPwField) return null;
      if (r.data.userExists === false) return { method: null, hasPassword: false };
      return { method: 'auth1', hasPassword: !!r.data.hasPassword };
    } catch {
      return null;
    }
  }

  // v23.3: cooperative slot — at most DEVIN_AUTH_MAX_CONCURRENCY in-flight
  // devin-auth flows, with a min start gap so we don't stampede the backend.
  // Returns true on acquire, throws 'devin_slot_busy' on timeout.
  async _acquireDevinAuthSlot() {
    const deadline = Date.now() + DEVIN_AUTH_ACQUIRE_TIMEOUT_MS;
    while (this._devinAuthInflight >= DEVIN_AUTH_MAX_CONCURRENCY) {
      if (Date.now() >= deadline) throw new Error('devin_slot_busy');
      // jittered poll to avoid lockstep thundering when many waiters wake together
      await new Promise(r => setTimeout(r, 80 + Math.floor(Math.random() * 80)));
    }
    // Reserve the slot synchronously (no awaits between check & ++) to keep
    // the cap honest under JS single-thread scheduling.
    this._devinAuthInflight++;
    const since = Date.now() - this._devinAuthLastStart;
    if (since < DEVIN_AUTH_MIN_START_GAP_MS) {
      await new Promise(r => setTimeout(r, DEVIN_AUTH_MIN_START_GAP_MS - since));
    }
    this._devinAuthLastStart = Date.now();
    return true;
  }

  _releaseDevinAuthSlot() {
    if (this._devinAuthInflight > 0) this._devinAuthInflight--;
  }

  async _signInWithDevinAuth(email, password, opts = {}) {
    const _emailPrefix = email.split('@')[0];
    const _li = opts.quiet ? _debug : _info;
    // v23.3: cap concurrent devin-auth flows; Firebase App Check blocking the
    // whole pool used to funnel every account here in parallel and trigger 429.
    await this._acquireDevinAuthSlot();
    try {
      return await this._doSignInWithDevinAuth(email, password, opts, _emailPrefix, _li);
    } finally {
      this._releaseDevinAuthSlot();
    }
  }

  async _doSignInWithDevinAuth(email, password, opts = {}, _emailPrefix, _li) {
    // v23.5: per-account fingerprint binding (cached by email).
    // Falls back to one-shot generation if AccountManager not yet wired up.
    const fp = this._generateLoginFingerprint(email);

    // v24.0: skip CheckUserLoginMethod — it often returns {} (empty body) causing
    // false-positive proxy circuit-breaking, and _devin-auth/connections is strictly
    // more reliable (one step, always returns hasPassword). Saves ~500ms per login.
    const legacyData = await this._withNetworkRetry('Devin Auth connections', async () => {
      const r = await this._httpsJson(
        'https://windsurf.com/_devin-auth/connections',
        'POST',
        { product: 'windsurf', email },
        undefined,
        fp,
      );
      if (!r.ok) throw new Error(r.data?.error?.message || r.data?.detail || `HTTP ${r.status}`);
      return r.data;
    });
    const conn = AuthService._interpretConnections(legacyData);
    if (conn.method !== 'auth1' || !conn.hasPassword) {
      throw new Error('Devin Auth 不支持密码登录');
    }

    const login = await this._withNetworkRetry('Devin Auth password login', async () => {
      const r = await this._httpsJson(
        'https://windsurf.com/_devin-auth/password/login',
        'POST',
        { email, password },
        undefined,
        fp,
      );
      if (!r.ok) throw new Error(r.data?.error?.message || r.data?.detail || `HTTP ${r.status}`);
      return r.data;
    });
    if (!login?.token) throw new Error('Devin Auth 返回空 token');

    // v25.0: pass user_id for X-Devin-Account-Id header (parity with windsurf-pool)
    const postAuth = await this._withNetworkRetry('WindsurfPostAuth', () => this._windsurfPostAuth(login.token, fp, login.user_id || ''));
    if (!postAuth.sessionToken) throw new Error('WindsurfPostAuth 返回空 sessionToken');

    _li('登录', `${_emailPrefix} → devin-auth`);
    return {
      ok: true,
      idToken: postAuth.sessionToken,
      email: login.email || email,
      channel: 'devin-auth',
      provider: 'devin-auth',
      devinAuth1Token: postAuth.auth1Token || login.token,
      devinAccountId: postAuth.accountId,
      devinPrimaryOrgId: postAuth.primaryOrgId,
    };
  }

  _isUnsupportedDevinAuthError(message) {
    return /不支持密码登录|unsupported|has_password|auth_method/i.test(message || '');
  }

  // ========== Firebase Login (双模式: relay优先 or local代理优先) ==========

  async login(email, password, forceFresh = false, cacheOnly = false, loginOpts = {}) {
    const _t0 = Date.now();
    const _emailPrefix = email.split('@')[0];
    // v20.4: quiet 模式 — full_scan/active_tick 等高频路径，[登录] 日志降为 DEBUG
    const _li = loginOpts.quiet ? _debug : _info;
    if (!PROXY_CHECKED) await this._probeProxy();

    if (!forceFresh) {
      const cached = this._getCachedToken(email);
      if (cached) {
        // silent cache hit — login=0ms will be visible on downstream [额度] line
        const provider = this._getCachedAuthProvider(email);
        return { ok: true, idToken: cached, email, cached: true, provider };
      }
      // idToken expired but refreshToken available — try silent renew before full re-login
      const refreshed = await this._refreshIdToken(email);
      if (refreshed) return refreshed;
    }

    if (cacheOnly) {
      return { ok: false, cacheOnly: true };
    }

    // v22.4-22.5: 登录路径全部不可用时直接 fail-fast (避免每分钟徒劳重试同一组合)
    const _cachedProvider = this._getCachedAuthProvider(email);
    const _fbBlocked = this._isFirebaseAppCheckBlocked();
    const _wsDead = this._isHostDead('windsurf.com');

    // v22.7: quiet 模式下这些 skip 是确定性 fail-fast, 降为 debug 避免每次扫描刷屏
    const _logSkip = loginOpts.quiet ? _debug : _warn;
    if (_fbBlocked && _wsDead) {
      _logSkip('登录', `${_emailPrefix} → 跳过 (windsurf.com 不可达 + firebase app_check 冷却中)`);
      return { ok: false, error: 'all_login_paths_blocked', skipped: true };
    }
    // v22.5: 账号已确认不支持 devin-auth + firebase 冷却中 → 大概率无法登录
    // v23.2: 给一次自愈机会 — 每账号每 30min 清缓存重试 devin-auth, 防 detection 误判永久锁死
    if (_fbBlocked && _cachedProvider === 'unsupported-devin') {
      const lastRescue = this._lastDevinRescueByEmail?.get(email) || 0;
      const rescueGap = Date.now() - lastRescue;
      if (rescueGap < 30 * 60_000) {
        const left = Math.ceil((this._firebaseBlockedUntil - Date.now()) / 1000);
        _logSkip('登录', `${_emailPrefix} → 跳过 (unsupported-devin + firebase 冷却 ${left}s)`);
        return { ok: false, error: 'no_viable_auth_path', skipped: true };
      }
      this._lastDevinRescueByEmail = this._lastDevinRescueByEmail || new Map();
      this._lastDevinRescueByEmail.set(email, Date.now());
      _li('登录', `${_emailPrefix} → firebase 拦截中, 重置 unsupported-devin 缓存重试 devin-auth`);
      this._clearAuthProviderCache(email);
    }

    const payload = { returnSecureToken: true, email, password, clientType: 'CLIENT_TYPE_WEB' };
    const fbHeaders = { Referer: 'https://windsurf.com/', Origin: 'https://windsurf.com' };
    const errors = [];
    // v23.2: rescue branch above may have cleared the cache → re-read so devin-auth can actually run
    const cachedProvider = this._getCachedAuthProvider(email);

    const devinCooldownLeft = this._devinAuthCooldownUntil - Date.now();
    if (cachedProvider === 'firebase' || cachedProvider === 'unsupported-devin') {
      _li('登录', `${_emailPrefix} → provider cached(${cachedProvider}), skip devin-auth`);
      errors.push(`devin-auth: skipped(${cachedProvider})`);
    } else if (devinCooldownLeft > 0) {
      errors.push(`devin-auth: cooldown(${Math.ceil(devinCooldownLeft / 1000)}s)`);
    } else {
      try {
        const devin = await this._signInWithDevinAuth(email, password, loginOpts);
        this._setCachedToken(email, devin.idToken);
        this._setCachedAuthProvider(email, 'devin-auth');
        this._devinAuth429Count = 0; // v21.0: reset escalation on success
        return { ...devin, elapsed: Date.now() - _t0 };
      } catch (e) {
        // v23.3: local slot-acquire timeout — backend was never touched. Don't
        // bump the 429 counter, don't pollute the cached provider, don't even
        // log at WARN — this is internal back-pressure, not an upstream error.
        if (e.message === 'devin_slot_busy') {
          errors.push('devin-auth: slot_busy');
          _li('登录', `${_emailPrefix} → devin-auth slot busy, deferring`);
        } else {
          errors.push(`devin-auth: ${e.message}`);
          if (this._isUnsupportedDevinAuthError(e.message)) {
            this._setCachedAuthProvider(email, 'unsupported-devin');
          } else if (/invalid email or password/i.test(e.message || '')) {
            // v22.2: devin-auth says credentials are wrong — skip Firebase fallback
            _warn('登录', `${_emailPrefix} → FAILED (${Date.now() - _t0}ms) ${errors.join(' | ')}`);
            return { ok: false, error: errors.join(' | ') };
          } else if (/\b429\b|rate[\s_-]*limit/i.test(e.message || '')) {
            // v21.0: escalating backoff — consecutive 429s double the cooldown
            this._devinAuth429Count++;
            const backoffMs = Math.min(DEVIN_AUTH_COOLDOWN_BASE_MS * Math.pow(2, this._devinAuth429Count - 1), DEVIN_AUTH_COOLDOWN_MAX_MS);
            this._devinAuthCooldownUntil = Date.now() + backoffMs;
            _warn('登录', `devin-auth 全局冷却 ${Math.round(backoffMs / 1000)}s (upstream 429, 连续${this._devinAuth429Count}次)`);
          }
          _warn('登录', `${_emailPrefix} → devin-auth fallback: ${e.message}`);
        }
      }
    }

    const tryFirebase = async (useProxy) => {
      // v23.4: feature-flagged — Firebase signInWithPassword is App Check dead.
      // See FIREBASE_LOGIN_ENABLED comment for the rationale. We don't even
      // push a log line for the skip: it's the expected, permanent state.
      if (!FIREBASE_LOGIN_ENABLED) {
        errors.push('firebase: disabled(app_check_dead)');
        return { ok: false, fatal: false };
      }
      // v22.3: Firebase 当前 App Check enforcement 全面启用 — 短期内全局跳过避免徒劳重试
      if (this._isFirebaseAppCheckBlocked()) {
        const left = Math.ceil((this._firebaseBlockedUntil - Date.now()) / 1000);
        errors.push(`firebase: app_check_cooldown(${left}s)`);
        return { ok: false, fatal: false };
      }
      for (const key of FIREBASE_KEYS) {
        const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`;
        try {
          const r = await this._httpsJson(url, 'POST', payload, useProxy, fbHeaders);
          if (r.ok && r.data.idToken) {
            this._setCachedToken(email, r.data.idToken, r.data.refreshToken || null);
            this._setCachedAuthProvider(email, 'firebase');
            const channel = useProxy === true ? 'firebase-proxy' : 'firebase-local';
            _li('登录', `${_emailPrefix} → ${channel} (${Date.now() - _t0}ms)`);
            return { ok: true, idToken: r.data.idToken, email: r.data.email || email, channel };
          }
          const msg = r.data?.error?.message || `HTTP ${r.status}`;
          errors.push(`firebase: ${msg}`);
          // v22.3: App Check 错误 → 启动全局冷却避免后续账号重蹈覆辙
          if (/app\s*check/i.test(msg)) {
            this._markFirebaseAppCheckBlocked();
            _warn('登录', `Firebase App Check 强制启用 → 全局跳过 ${FIREBASE_APP_CHECK_BLOCK_MS / 60_000}min`);
            return { ok: false, fatal: false };
          }
          if (this._isFatalFirebaseAuthError(msg)) {
            return { ok: false, fatal: true, error: msg };
          }
        } catch (e) {
          errors.push(`firebase: ${e.message}`);
        }
      }
      return { ok: false, fatal: false };
    };

    if (ACTIVE_MODE === 'relay') {
      try {
        const r = await this._tryRelaysJson('/firebase/login', payload);
        if (r && r.ok && r.data.idToken) {
          this._setCachedToken(email, r.data.idToken, r.data.refreshToken || null);
          this._setCachedAuthProvider(email, 'firebase');
          _li('登录', `${_emailPrefix} → relay (${Date.now() - _t0}ms)`);
          return { ok: true, idToken: r.data.idToken, email: r.data.email || email, channel: 'relay' };
        }
        const msg = r?.data?.error?.message;
        if (msg) {
          errors.push(`relay: ${msg}`);
          if (this._isFatalFirebaseAuthError(msg)) {
            _warn('登录', `${_emailPrefix} → FAILED (${Date.now() - _t0}ms) ${errors.join(' | ')}`);
            return { ok: false, error: errors.join(' | ') };
          }
        }
      } catch (e) { errors.push(`relay: ${e.message}`); }

      const firebase = await tryFirebase(true);
      if (firebase.ok || firebase.fatal) return firebase;
    } else {
      const firebase = await tryFirebase(undefined);
      if (firebase.ok || firebase.fatal) return firebase;

      try {
        const r = await this._tryRelaysJson('/firebase/login', payload);
        if (r && r.ok && r.data.idToken) {
          this._setCachedToken(email, r.data.idToken, r.data.refreshToken || null);
          this._setCachedAuthProvider(email, 'firebase');
          _li('登录', `${_emailPrefix} → relay-fallback (${Date.now() - _t0}ms)`);
          return { ok: true, idToken: r.data.idToken, email: r.data.email || email, channel: 'relay-fallback' };
        }
        if (r?.data?.error?.message) errors.push(`relay: ${r.data.error.message}`);
      } catch (e) { errors.push(`relay: ${e.message}`); }
    }

    _warn('登录', `${_emailPrefix} → FAILED (${Date.now() - _t0}ms) ${errors.join(' | ')}`);
    return { ok: false, error: errors.join(' | ') || 'All login channels failed' };
  }

  // ========== Usage Info Query (adaptive: credits + quota) ==========

  /**
   * Get comprehensive usage info — tries new quota format, falls back to credits
   * Returns: { mode, credits, daily, weekly, plan, resetTime, ... }
   *
   * v22.7: end-to-end wall-clock so a single bad-proxy account cannot hold
   * up the pool scan for 15-20+s.
   */
  getUsageInfo(email, password, options = {}) {
    const wallClockMs = Number.isFinite(options.wallClockMs) ? options.wallClockMs : 10_000;
    const _emailPrefix = email.split('@')[0];
    // v23.3: cancel wall-clock timer once inner promise settles to stop spurious
    // post-success "wall-clock timeout" warnings (timer was previously leaked).
    let timer = null;
    const timeoutP = new Promise((resolve) => {
      timer = setTimeout(() => {
        timer = null;
        if (!options.quiet) {
          _warn('额度', `${_emailPrefix} → wall-clock timeout (${wallClockMs}ms)`);
        }
        resolve({ ok: false, errorType: 'plan_status_failed', error: 'wall_clock_timeout' });
      }, wallClockMs);
    });
    const innerP = this._getUsageInfoInner(email, password, options).finally(() => {
      if (timer) { clearTimeout(timer); timer = null; }
    });
    return Promise.race([innerP, timeoutP]);
  }

  async _getUsageInfoInner(email, password, options = {}) {
    const _t0 = Date.now();
    const _emailPrefix = email.split('@')[0];
    // v20.4: 透传 quiet 给 login (full_scan/active_tick 的 [登录] 也降为 DEBUG)
    const loginOpts = { quiet: !!options.quiet };

    // v23.0 fast-path: try persisted apiKey first → GetUserStatus (one network call,
    // no Firebase login chain). 借鉴 windsurf-pool 的"一次登录长期持有"设计。
    let clearApiKey = false;
    if (options.apiKey) {
      const fast = await this._fetchPlanStatusByApiKey(options.apiKey, { quiet: !!options.quiet });
      if (fast?.ok) {
        if (!options.quiet) {
          _info('额度', `${_emailPrefix} → apikey daily=${fast.daily?.remaining ?? '?'}% weekly=${fast.weekly?.remaining ?? '?'}% (${Date.now() - _t0}ms)`);
        }
        return { ...fast, source: 'apikey_status' };
      }
      if (fast?.errorType === 'apikey_invalid') {
        if (!options.quiet) {
          _warn('额度', `${_emailPrefix} → apikey 失效, 回退 Firebase`);
        }
        clearApiKey = true;
      }
      // null/transport error: silently fall through to Firebase
    }

    const loginResult = await this.login(email, password, false, !!options.cacheOnly, loginOpts);
    if (!loginResult.ok) {
      if (loginResult.cacheOnly) {
        return { ok: false, errorType: 'cache_miss', cacheOnly: true };
      }
      const error = loginResult.error || 'login_failed';
      const errorType = this._isFatalFirebaseAuthError(error) ? 'invalid_credentials' : 'login_failed';
      // v22.7: quiet + skipped 时 [登录] 已说明原因, 这里别重复刷屏
      if (!(options.quiet && loginResult.skipped)) {
        _warn('额度', `${_emailPrefix} → login failed (${Date.now() - _t0}ms)`);
      }
      return { ok: false, errorType, error };
    }
    const _t1 = Date.now();

    // devin-auth tokens are windsurf session tokens, incompatible with binary GetPlanStatus.
    // Skip binary path entirely and go straight to JSON GetPlanStatus to avoid 4 wasted 401s.
    const isDevinAuth = loginResult.provider === 'devin-auth' || loginResult.channel === 'devin-auth';
    const reqData = encodeProtoString(loginResult.idToken);
    let planErrors = [];
    let resp = isDevinAuth ? null : await this._fetchPlanStatus(reqData, { errors: planErrors });
    let jsonUsage = isDevinAuth ? await this._fetchPlanStatusJson(loginResult.idToken) : null;

    if (!resp && this._hasMigratedAuthError(planErrors)) {
      _warn('额度', `${_emailPrefix} → account migrated, clearing firebase provider cache and retrying devin-auth`);
      this.clearTokenCache(email);
      this._clearAuthProviderCache(email);
      const devin = await this.login(email, password, true, false, loginOpts);
      if (devin.ok) {
        planErrors = [];
        resp = await this._fetchPlanStatus(encodeProtoString(devin.idToken), { errors: planErrors });
        if (!resp && !this._hasMigratedAuthError(planErrors)) {
          jsonUsage = await this._fetchPlanStatusJson(devin.idToken);
        }
      }
    }

    if (!resp && !jsonUsage && loginResult.cached) {
      _warn('额度', `${_emailPrefix} → cached token failed, retrying fresh`);
      this.clearTokenCache(email);
      const fresh = await this.login(email, password, true, false, loginOpts);
      if (fresh.ok) {
        const freshIsDevin = fresh.provider === 'devin-auth' || fresh.channel === 'devin-auth';
        if (freshIsDevin) {
          jsonUsage = await this._fetchPlanStatusJson(fresh.idToken);
        } else {
          const freshReq = encodeProtoString(fresh.idToken);
          planErrors = [];
          resp = await this._fetchPlanStatus(freshReq, { errors: planErrors });
          if (!resp && this._hasMigratedAuthError(planErrors)) {
            _warn('额度', `${_emailPrefix} → fresh firebase still migrated, retrying devin-auth`);
            this.clearTokenCache(email);
            this._clearAuthProviderCache(email);
            const devin = await this.login(email, password, true, false, loginOpts);
            if (devin.ok) {
              planErrors = [];
              resp = await this._fetchPlanStatus(encodeProtoString(devin.idToken), { errors: planErrors });
              if (!resp && !this._hasMigratedAuthError(planErrors)) {
                jsonUsage = await this._fetchPlanStatusJson(devin.idToken);
              }
            }
          } else if (!resp) jsonUsage = await this._fetchPlanStatusJson(fresh.idToken);
        }
      }
    }

    // devin-auth path already attempted JSON with loginResult.idToken above — don't repeat.
    if (!resp && !jsonUsage && !isDevinAuth) {
      jsonUsage = await this._fetchPlanStatusJson(loginResult.idToken);
    }
    if (!resp && !jsonUsage) {
      _warn('额度', `${_emailPrefix} → no response (${Date.now() - _t0}ms, login=${_t1 - _t0}ms)`);
      return { ok: false, errorType: 'plan_status_failed', error: 'no_response', clearApiKey };
    }
    const result = resp ? parseUsageInfo(resp.buffer) : jsonUsage;
    if (result) {
      result.userEmail = loginResult.email || email;
      result.source = resp ? 'api' : 'api_json';
      if (clearApiKey) result.clearApiKey = true;
      // v23.0: surface a freshly-obtained apiKey/sessionToken so caller can persist it
      // devin-auth login result IS a sessionToken (windsurf-pool style); carry it.
      if (isDevinAuth && loginResult.idToken) {
        result.newApiKey = loginResult.idToken;
        result.newApiKeySource = 'devin_auth';
      }
    }
    // v20.3: 条件化时序 — 慢请求(>2s)/重登(login>500ms) 才打时序，日常请求精简
    // quiet 模式(全池扫描)直接走 DEBUG，不污染 outputChannel
    const elapsed = Date.now() - _t0;
    const loginMs = _t1 - _t0;
    const planMs = Date.now() - _t1;
    const slow = elapsed > 2000 || loginMs > 500 || planMs > 1500;
    const timing = slow
      ? ` (${elapsed}ms, login=${loginMs}ms, plan=${planMs}ms)`
      : '';
    const logFn = options.quiet ? _debug : _info;
    logFn('额度', `${_emailPrefix} → ${result?.mode || '?'} daily=${result?.daily?.remaining ?? '?'}% weekly=${result?.weekly?.remaining ?? '?'}%${timing}`);
    return result;
  }

  /** Fetch PlanStatus from multi-endpoint (extracted for reuse)
   *  Auth failure (401/403) → no relay fallback (same token won't pass elsewhere)
   *  Network failure → fall through to relay if available */
  async _fetchPlanStatus(reqData, options = {}) {
    const requestOptions = {
      errors: options.errors || null,
      stopOnMigrated: true,
    };
    let resp = null;
    if (ACTIVE_MODE === 'relay' && RELAYS.length > 0) {
      resp = await this._tryRelaysBinary('/windsurf/plan-status', reqData, requestOptions);
      if (!resp && !this._hasAuthFailure(requestOptions.errors)) resp = await this._raceUrls(PLAN_STATUS_URLS, reqData, requestOptions);
    } else {
      resp = await this._raceUrls(PLAN_STATUS_URLS, reqData, requestOptions);
      if (!resp && RELAYS.length > 0 && !this._hasAuthFailure(requestOptions.errors)) {
        resp = await this._tryRelaysBinary('/windsurf/plan-status', reqData, requestOptions);
      }
    }
    return resp;
  }

  _parsePlanStatusJson(data) {
    const ps = data?.planStatus || data?.plan_status || data;
    if (!ps || typeof ps !== 'object') return null;
    const pi = ps.planInfo || ps.plan_info || {};
    const plan = pi.planName || pi.plan_name || ps.planName || ps.plan_name || null;
    const billingRaw = pi.billingStrategy ?? pi.billing_strategy ?? ps.billingStrategy ?? ps.billing_strategy ?? null;
    const billingRawParsed = typeof billingRaw === 'string'
      ? billingRaw.toLowerCase()
      : billingRaw === 1
        ? 'credits'
        : billingRaw === 2
          ? 'quota'
          : billingRaw === 3
            ? 'acu'
            : null;
    const dailyRemaining = ps.dailyQuotaRemainingPercent ?? ps.daily_quota_remaining_percent;
    const weeklyRemaining = ps.weeklyQuotaRemainingPercent ?? ps.weekly_quota_remaining_percent;
    const availablePrompt = ps.availablePromptCredits ?? ps.available_prompt_credits;
    if (
      !plan &&
      dailyRemaining === undefined &&
      weeklyRemaining === undefined &&
      availablePrompt === undefined
    ) {
      return null;
    }
    // v20.1: billingStrategy 自适应 — 服务端未返回明确字段时按数据形状推断
    // (参考 ai-quote 实践，避免 credit 制账号被误判成 quota 制)
    const billingStrategy = billingRawParsed
      ?? (dailyRemaining !== undefined || weeklyRemaining !== undefined
        ? 'quota'
        : availablePrompt !== undefined
          ? 'credits'
          : null);
    const dailyResetUnix = Number(ps.dailyQuotaResetAtUnix ?? ps.daily_quota_reset_at_unix ?? 0);
    const weeklyResetUnix = Number(ps.weeklyQuotaResetAtUnix ?? ps.weekly_quota_reset_at_unix ?? 0);
    const planStartRaw = ps.planStart || ps.plan_start;
    const planEndRaw = ps.planEnd || ps.plan_end;
    const toMs = (value) => {
      if (!value) return null;
      if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const result = {
      mode: billingStrategy === 'credits' ? 'credits' : 'quota',
      billingStrategy,
      credits: null,
      plan,
      daily: dailyRemaining !== undefined
        ? { used: Math.max(0, 100 - dailyRemaining), total: 100, remaining: dailyRemaining }
        : null,
      weekly: weeklyRemaining !== undefined
        ? { used: Math.max(0, 100 - weeklyRemaining), total: 100, remaining: weeklyRemaining }
        : null,
      resetTime: dailyResetUnix ? dailyResetUnix * 1000 : null,
      weeklyReset: weeklyResetUnix ? weeklyResetUnix * 1000 : null,
      extraBalance: Number(ps.overageBalanceMicros ?? ps.overage_balance_micros ?? 0) / 1000000,
      planStart: toMs(planStartRaw),
      planEnd: toMs(planEndRaw),
    };

    const usedPrompt = ps.usedPromptCredits ?? ps.used_prompt_credits ?? 0;
    if (availablePrompt !== undefined && availablePrompt !== null) {
      result.credits = Math.round((availablePrompt - usedPrompt) / 100);
      if (!result.daily && billingStrategy === 'credits') result.mode = 'credits';
    }
    return result;
  }

  /**
   * v23.0 fast-path: GetUserStatus with persisted apiKey, no Firebase login needed.
   * Returns usageInfo-shaped result on success; errorType='apikey_invalid' if key
   * was rejected so the caller can drop it; null on transport/parse failure.
   * 借鉴 windsurf-pool/ai-quote 的多通道设计 — apiKey 一次拿到, 长期持有。
   */
  async _fetchPlanStatusByApiKey(apiKey, { quiet = false } = {}) {
    if (!apiKey) return null;
    // sk-ws-01- session token: server returns 200+empty (ai-quote 实测), skip
    if (apiKey.startsWith('sk-ws-01-')) return null;
    if (!PROXY_CHECKED) await this._probeProxy();

    const body = { metadata: AuthService._buildConnectMetadata(apiKey) };
    // v25.0: x-devin-session-token for devin-auth compatibility (windsurf-pool parity)
    const headers = {
      'Connect-Protocol-Version': '1',
      Accept: 'application/json',
      'x-devin-session-token': apiKey,
    };

    for (const url of AuthService.GET_USER_STATUS_URLS) {
      try {
        const r = await this._httpsJson(url, 'POST', body, undefined, headers);
        if (r.ok) {
          // GetUserStatus wraps planStatus inside userStatus → unwrap before parse
          const planTree = r.data?.userStatus || r.data;
          const parsed = this._parsePlanStatusJson(planTree);
          if (parsed) {
            // Carry email so upstream can validate target match
            const userEmail = r.data?.userStatus?.email || r.data?.userStatus?.userEmail || '';
            if (userEmail) parsed.userEmail = userEmail;
            parsed.source = 'apikey_status';
            return { ok: true, errorType: null, ...parsed };
          }
          // 200 + empty body via apiKey usually means token soft-expire/invalid
          if (!quiet) _warn('UserStatus', `JSON ${new URL(url).hostname} → 200 but empty/invalid body (apikey expired)`);
          return { ok: false, errorType: 'apikey_invalid', error: 'empty_body' };
        }
        if (r.status === 401 || r.status === 403) {
          if (!quiet) _warn('UserStatus', `${new URL(url).hostname} → ${r.status} (apikey rejected)`);
          return { ok: false, errorType: 'apikey_invalid', error: `HTTP ${r.status}` };
        }
        if (!quiet) _warn('UserStatus', `${new URL(url).hostname} → ${r.status}`);
      } catch (e) {
        if (!quiet) _warn('UserStatus', `${new URL(url).hostname} ERR ${e.message}`);
      }
    }
    return null;
  }

  async _fetchPlanStatusJson(idToken) {
    // v25.0: parity with windsurf-pool — includeTopUpStatus for overage balance,
    // x-devin-session-token for devin-auth session tokens (old X-Auth-Token kept for firebase compat)
    const body = { includeTopUpStatus: true };
    const headers = {
      'X-Auth-Token': idToken,
      'x-devin-session-token': idToken,
      'Connect-Protocol-Version': '1',
    };
    const urls = [
      'https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus',
      'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus',
    ];
    for (const url of urls) {
      try {
        const r = await this._httpsJson(url, 'POST', body, undefined, headers);
        if (r.ok) {
          const parsed = this._parsePlanStatusJson(r.data);
          if (parsed) {
            // v25.0: merge topUpStatus overage balance (parity with windsurf-pool)
            const topUp = r.data?.topUpStatus || {};
            const topUpBalance = topUp.overageBalanceMicros ?? topUp.balanceMicros;
            if (topUpBalance !== undefined && topUpBalance !== null) {
              parsed.extraBalance = Number(topUpBalance) / 1000000;
            }
            return parsed;
          }
          // v22.5: 200 但 body 空/格式不符 — 通常是 token soft-expire 信号
          _warn('额度', `JSON GetPlanStatus ${new URL(url).hostname} → 200 but empty/invalid body (token likely expired)`);
          continue;
        }
        _warn('额度', `JSON GetPlanStatus ${new URL(url).hostname} → ${r.status}`);
      } catch (e) {
        _warn('额度', `JSON GetPlanStatus ${new URL(url).hostname} → ERR ${e.message}`);
      }
    }
    return null;
  }

  // ========== RegisterUser → apiKey (for hot injection, mode-aware) ==========
  //
  // v23.4 DEPRECATED for the active code path. RegisterUser only accepts
  // firebase_id_token; with FIREBASE_LOGIN_ENABLED=false we never obtain one,
  // so this method effectively returns null. Kept for two reasons:
  //   1. Forward compatibility — if upstream rescinds App Check enforcement,
  //      flipping FIREBASE_LOGIN_ENABLED back on revives this entire path.
  //   2. External code (third-party scripts, tests) may still import it.
  //
  // No active call site in src/extension/** as of v23.4 — verified via grep
  // for `S.auth.registerUser(` and `auth.registerUser(`.
  async registerUser(email, password) {
    const loginResult = await this.login(email, password, true);
    if (!loginResult.ok) return null;

    const reqData = encodeProtoString(loginResult.idToken);
    let resp = null;

    if (ACTIVE_MODE === 'relay') {
      // Relay模式: 多relay优先
      resp = await this._tryRelaysBinary('/windsurf/register', reqData);
      if (!resp) resp = await this._raceUrls(REGISTER_URLS, reqData);
    } else {
      // Local模式: 直连优先
      resp = await this._raceUrls(REGISTER_URLS, reqData);
      if (!resp) resp = await this._tryRelaysBinary('/windsurf/register', reqData);
    }

    if (resp) {
      const apiKey = parseProtoString(resp.buffer);
      if (apiKey) return { apiKey, email, idToken: loginResult.idToken };
    }

    const fallback = await this._registerUserJsonFallback(loginResult.idToken);
    return fallback?.apiKey ? { ...fallback, email, idToken: loginResult.idToken } : null;
  }

  async _registerUserJsonFallback(idToken) {
    for (const url of REGISTER_JSON_FALLBACK_URLS) {
      try {
        const r = await this._httpsJson(url, 'POST', { firebase_id_token: idToken });
        const apiKey = r.data?.api_key || r.data?.apiKey;
        if (r.ok && apiKey) {
          _info('注册', `RegisterUser JSON fallback成功: ${new URL(url).hostname}`);
          return {
            apiKey,
            name: r.data?.name || '',
            apiServerUrl: r.data?.api_server_url || r.data?.apiServerUrl || '',
          };
        }
        _warn('注册', `RegisterUser JSON fallback失败: ${new URL(url).hostname} status=${r.status}`);
      } catch (e) {
        _warn('注册', `RegisterUser JSON fallback异常: ${new URL(url).hostname} ${e.message}`);
      }
    }
    return null;
  }

  // ========== Cached Quota Reader (reads Windsurf's internal state.vscdb) ==========
  // (v23.4 removed: getOneTimeAuthToken stub — endpoint dead since 2026-05-04;
  //  getFreshIdToken — redundant force-fresh login that doubled noise. Both
  //  had no remaining call sites in src/extension/** after authInjector.js
  //  was collapsed to the Devin-only chain.)
  // v5.11.0: With varint tag fix, GetPlanStatus CAN return quota fields (f14-f18).
  // But some accounts may not have quota data yet (first use after 3/18 reform).
  // cachedPlanInfo in state.vscdb is the most reliable source for CURRENT account.

  /**
   * Read real quota % from Windsurf's state.vscdb (cachedPlanInfo).
   * Returns: { daily, weekly, billing, plan, resetTime, weeklyReset, extraBalance } or null
   */
  readCachedQuota(expectedEmail = null, options = {}) {
    try {
      const silent = options?.silent === true;
      const source = options?.source ? `${options.source} ` : '';
      const dbPath = getStateDbPath();
      if (!fs.existsSync(dbPath)) return null;

      const protoQuota = this.readCachedUserStatusProto(dbPath, expectedEmail, options);
      if (protoQuota) {
        // silent on success — info is already on [额度] line
        return protoQuota;
      }

      const raw = dbReadKey(dbPath, 'windsurf.settings.cachedPlanInfo');
      if (!raw) return null;

      const plan = JSON.parse(raw);
      const q = plan.quotaUsage || {};
      // v6.9: Extract plan dates for official alignment (Trial "Plan ends in X days")
      const planStartRaw = plan.planStartDate || plan.planStart || plan.plan_start;
      const planEndRaw = plan.planEndDate || plan.planEnd || plan.plan_end;
      const planStartMs = planStartRaw ? (typeof planStartRaw === 'number' ? (planStartRaw < 1e12 ? planStartRaw * 1000 : planStartRaw) : Date.parse(planStartRaw)) : null;
      const planEndMs = planEndRaw ? (typeof planEndRaw === 'number' ? (planEndRaw < 1e12 ? planEndRaw * 1000 : planEndRaw) : Date.parse(planEndRaw)) : null;
      const result = {
        daily: q.dailyRemainingPercent !== undefined ? q.dailyRemainingPercent : null,
        weekly: q.weeklyRemainingPercent !== undefined ? q.weeklyRemainingPercent : null,
        billing: plan.billingStrategy || null,
        plan: plan.planName || plan.plan || null,
        email: plan.email || plan.accountEmail || null,
        resetTime: q.dailyResetAtUnix ? q.dailyResetAtUnix * 1000 : null,
        weeklyReset: q.weeklyResetAtUnix ? q.weeklyResetAtUnix * 1000 : null,
        extraBalance: q.overageBalanceMicros ? q.overageBalanceMicros / 1000000 : 0,
        exhausted: (q.dailyRemainingPercent !== undefined && q.dailyRemainingPercent <= 0)
                || (q.weeklyRemainingPercent !== undefined && q.weeklyRemainingPercent <= 0),
        planStart: planStartMs || null,
        planEnd: planEndMs || null,
      };
      if (!this._matchesExpectedEmail(result.email, expectedEmail)) {
        if (!silent) {
          _warn('缓存额度', `${source}cachedPlanInfo email mismatch: cached=${result.email || 'n/a'} expected=${expectedEmail}`);
        }
        return null;
      }
      // silent on success — [额度] line already covers it
      return result;
    } catch (e) {
      _warn('缓存额度', `readCachedQuota error: ${e.message}`);
      return null;
    }
  }

  _matchesExpectedEmail(actualEmail, expectedEmail) {
    if (!expectedEmail || !actualEmail) return true;
    return String(actualEmail).trim().toLowerCase() === String(expectedEmail).trim().toLowerCase();
  }

  /** Read the locally effective Windsurf account email without network.
   *  Switch confirmation needs identity, not quota freshness.
   *  v20.1: authStatus.userEmail is cheaper than proto decode — read it first. */
  /** v23.2: read full {email, apiKey} from windsurfAuthStatus — used by activate hook
   *  to bind the IDE-injected apiKey onto the matching account, giving stuck accounts
   *  (unsupported-devin + firebase cooldown) a viable refresh path. */
  readWindsurfAuthStatus() {
    try {
      const dbPath = getStateDbPath();
      if (!fs.existsSync(dbPath)) return null;
      const authRaw = dbReadKey(dbPath, 'windsurfAuthStatus');
      if (!authRaw) return null;
      const authStatus = JSON.parse(authRaw);
      const email = authStatus.userEmail || authStatus.email || null;
      const apiKey = authStatus.apiKey || null;
      if (!email && !apiKey) return null;
      return { email, apiKey };
    } catch { return null; }
  }

  readCachedAuthEmail() {
    try {
      const dbPath = getStateDbPath();
      if (!fs.existsSync(dbPath)) return null;

      // Fast path: windsurfAuthStatus.userEmail is a plain JSON string, no proto decode.
      const authRaw = dbReadKey(dbPath, 'windsurfAuthStatus');
      if (authRaw) {
        try {
          const authStatus = JSON.parse(authRaw);
          if (authStatus.userEmail) return authStatus.userEmail;
          if (authStatus.email) return authStatus.email;
        } catch {}
      }

      // Fallback: proto decode if authStatus missing email field.
      const protoQuota = this.readCachedUserStatusProto(dbPath);
      if (protoQuota?.email) return protoQuota.email;

      const planRaw = dbReadKey(dbPath, 'windsurf.settings.cachedPlanInfo');
      if (planRaw) {
        try {
          const plan = JSON.parse(planRaw);
          return plan.email || plan.accountEmail || null;
        } catch {}
      }
      return null;
    } catch {
      return null;
    }
  }

  _protoEntryString(fields, field) {
    const entry = fields[field]?.[0];
    if (!entry) return null;
    if (entry.string) return entry.string;
    if (entry.bytes) {
      try { return Buffer.from(entry.bytes).toString('utf8'); } catch {}
    }
    return null;
  }

  _protoEntryInt(fields, field) {
    const entry = fields[field]?.[0];
    if (!entry) return undefined;
    if (entry.value !== undefined) return entry.value;
    return undefined;
  }

  _protoEntrySub(fields, field) {
    const entry = fields[field]?.[0];
    if (!entry?.bytes) return null;
    try { return parseProtoMsg(entry.bytes); } catch { return null; }
  }

  _protoTimestampMs(fields, field) {
    const sub = this._protoEntrySub(fields, field);
    const seconds = sub ? this._protoEntryInt(sub, 1) : undefined;
    return seconds ? seconds * 1000 : null;
  }

  /**
   * Read realtime quota from windsurfAuthStatus.userStatusProtoBinaryBase64.
   * This local channel is fresher than cachedPlanInfo and does not require network.
   */
  readCachedUserStatusProto(dbPath = getStateDbPath(), expectedEmail = null, options = {}) {
    try {
      if (!fs.existsSync(dbPath)) return null;
      const raw = dbReadKey(dbPath, 'windsurfAuthStatus');
      if (!raw) return null;
      const status = JSON.parse(raw);
      const b64 = status.userStatusProtoBinaryBase64;
      if (!b64) return null;

      const outer = parseProtoMsg(Buffer.from(b64, 'base64'));
      const email = this._protoEntryString(outer, 7) || this._protoEntryString(outer, 3) || status.userEmail || null;
      if (!this._matchesExpectedEmail(email, expectedEmail)) {
        if (options?.silent !== true) {
          const source = options?.source ? `${options.source} ` : '';
          _warn('缓存额度', `${source}userStatusProto email mismatch: cached=${email || 'n/a'} expected=${expectedEmail}`);
        }
        return null;
      }
      const planStatus = this._protoEntrySub(outer, 13);
      if (!planStatus) return null;

      const planInfo = this._protoEntrySub(planStatus, 1);
      const plan = planInfo ? this._protoEntryString(planInfo, 2) : null;
      const dailyRaw = this._protoEntryInt(planStatus, 14);
      const weeklyRaw = this._protoEntryInt(planStatus, 15);
      const resetUnix = this._protoEntryInt(planStatus, 17);
      const weeklyResetUnix = this._protoEntryInt(planStatus, 18);

      const hasDailyReset = !!resetUnix;
      const hasWeeklyReset = !!weeklyResetUnix;
      const daily = dailyRaw !== undefined ? dailyRaw : hasDailyReset ? 0 : null;
      const weekly = weeklyRaw !== undefined ? weeklyRaw : hasWeeklyReset ? 0 : null;
      if (daily === null && weekly === null && !plan) return null;

      const planStart = this._protoTimestampMs(planStatus, 2);
      const planEnd = this._protoTimestampMs(planStatus, 3);
      const extraMicros = this._protoEntryInt(planStatus, 16);

      return {
        source: 'userStatusProto',
        daily,
        weekly,
        billing: 'quota',
        plan,
        email,
        resetTime: resetUnix ? resetUnix * 1000 : null,
        weeklyReset: weeklyResetUnix ? weeklyResetUnix * 1000 : null,
        extraBalance: extraMicros ? extraMicros / 1000000 : 0,
        exhausted: (daily !== null && daily <= 0) || (weekly !== null && weekly <= 0),
        planStart,
        planEnd,
      };
    } catch (e) {
      _warn('缓存额度', `userStatusProto读取失败: ${e.message}`);
      return null;
    }
  }

  /**
   * Read rate limit state from Windsurf's state.vscdb.
   * Windsurf stores rate limit info in multiple keys — we scan for:
   *   - windsurf.settings.rateLimitState (direct)
   *   - cachedPlanInfo.rateLimitInfo (nested)
   *   - Any key containing 'rateLimit' or 'rate_limit'
   * Returns: { limited, resetAt, resetsInSec, type, model, raw } or null
   */
  readCachedRateLimit() {
    try {
      const dbPath = getStateDbPath();
      if (!fs.existsSync(dbPath)) return null;

      // Read specific keys
      const keysToCheck = [
        'windsurf.settings.cachedPlanInfo',
        'windsurf.rateLimitState',
        'windsurf.settings.rateLimitState',
        'cascade.rateLimitState',
      ];
      const exactData = dbReadKeys(dbPath, keysToCheck);
      // Also scan for any key containing rateLimit
      const likeData = dbReadKeysLike(dbPath, ['%rateLimit%', '%rate_limit%']);
      const data = { ...likeData, ...exactData };
      // Remove null entries
      for (const k of Object.keys(data)) { if (!data[k]) delete data[k]; }
      if (Object.keys(data).length === 0) return null;
      const result = { limited: false, resetAt: null, resetsInSec: null, type: null, model: null, raw: {} };

      // Parse cachedPlanInfo for embedded rate limit data
      const cachedPlan = data['windsurf.settings.cachedPlanInfo'];
      if (cachedPlan) {
        try {
          const plan = JSON.parse(cachedPlan);
          // Check for rate limit fields in the plan info
          if (plan.rateLimitInfo || plan.rateLimit) {
            const rl = plan.rateLimitInfo || plan.rateLimit;
            result.limited = true;
            if (rl.resetAt) result.resetAt = typeof rl.resetAt === 'number' ? rl.resetAt : Date.parse(rl.resetAt);
            if (rl.resetsInSeconds) result.resetsInSec = rl.resetsInSeconds;
            if (rl.type) result.type = rl.type;
            if (rl.model) result.model = rl.model;
          }
          // Check quotaUsage for rate limit indicators
          if (plan.quotaUsage) {
            const qu = plan.quotaUsage;
            if (qu.rateLimited || qu.messageRateLimited) {
              result.limited = true;
              if (qu.rateLimitResetAt) result.resetAt = qu.rateLimitResetAt * 1000;
            }
          }
        } catch (e) { _warn('缓存限流', `cachedPlanInfo parse error: ${e.message}`); }
      }

      // Parse dedicated rate limit state keys
      for (const [key, val] of Object.entries(data)) {
        if (key === 'windsurf.settings.cachedPlanInfo') continue;
        try {
          const parsed = typeof val === 'string' ? JSON.parse(val) : val;
          result.raw[key] = parsed;
          if (parsed.resetAt || parsed.reset_at || parsed.resets_at) {
            result.limited = true;
            const ts = parsed.resetAt || parsed.reset_at || parsed.resets_at;
            result.resetAt = typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts);
          }
          if (parsed.resetsInSeconds || parsed.resets_in_seconds) {
            result.resetsInSec = parsed.resetsInSeconds || parsed.resets_in_seconds;
          }
          if (parsed.type) result.type = parsed.type;
          if (parsed.model) result.model = parsed.model;
        } catch (e) { _warn('缓存限流', `key=${key} parse error: ${e.message}, raw=${String(val).substring(0, 100)}`); }
      }

      // Calculate resetsInSec from resetAt if needed
      if (result.resetAt && !result.resetsInSec) {
        result.resetsInSec = Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000));
      }

      _info('缓存限流', `limited=${result.limited} resetAt=${result.resetAt ? new Date(result.resetAt).toLocaleTimeString() : 'n/a'} resetsIn=${result.resetsInSec}s type=${result.type} keys=${Object.keys(data).join(',')}`);
      return result;
    } catch (e) {
      _warn('缓存限流', `readCachedRateLimit error: ${e.message}`);
      return null;
    }
  }

  // ========== v7.2: Generic state.vscdb value reader ==========

  /** Read any key from state.vscdb (for per-model rate limit detection) */
  readCachedValue(key) {
    try {
      const dbPath = getStateDbPath();
      if (!fs.existsSync(dbPath)) return null;
      return dbReadKey(dbPath, key);
    } catch {
      return null;
    }
  }

  /** Write model selection to state.vscdb (for per-model rate limit variant switching) */
  writeModelSelection(modelUid) {
    try {
      const dbPath = getStateDbPath();
      if (!fs.existsSync(dbPath)) return false;
      // Read-modify-write codeium.windsurf key
      const raw = dbReadKey(dbPath, 'codeium.windsurf');
      const d = raw ? JSON.parse(raw) : {};
      d['windsurf.state.lastSelectedCascadeModelUids'] = [modelUid];
      const ok = dbWriteKey(dbPath, 'codeium.windsurf', JSON.stringify(d));
      _info('模型', `writeModelSelection(${modelUid}) => ${ok ? 'OK' : 'FAIL'}`);
      return ok;
    } catch (e) {
      _warn('模型', `writeModelSelection error: ${e.message}`);
      return false;
    }
  }

  // ========== Proactive Rate Limit Capacity Check ==========
  // v20.0: 从 binary proto 迁移到 JSON Connect-RPC (参考 WindsurfAPI)
  // 旧 proto schema 已变更导致 400, JSON 格式需要完整 metadata 而非仅 api_key
  // WAM主动调用此端点 → 在用户消息失败前获知容量 → 提前切号 = 永不触发rate limit

  static CHECK_RATE_LIMIT_URLS = [
    'https://server.codeium.com/exa.api_server_pb.ApiServerService/CheckUserMessageRateLimit',
    'https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService/CheckUserMessageRateLimit',
    'https://web-backend.windsurf.com/exa.api_server_pb.ApiServerService/CheckUserMessageRateLimit',
  ];

  /**
   * Read current session apiKey from state.vscdb windsurfAuthStatus.
   * This is the ACTIVE apiKey that Windsurf uses for all API calls.
   * Returns: string (apiKey) or null
   */
  readCurrentApiKey() {
    try {
      const dbPath = getStateDbPath();
      if (!fs.existsSync(dbPath)) return null;
      const raw = dbReadKey(dbPath, 'windsurfAuthStatus');
      if (!raw) return null;
      const d = JSON.parse(raw);
      return d.apiKey || null;
    } catch (e) {
      _warn('apiKey', `readCurrentApiKey error: ${e.message}`);
      return null;
    }
  }

  /** Build Connect-RPC metadata matching Windsurf client fingerprint */
  static _buildConnectMetadata(apiKey) {
    return {
      apiKey,
      ideName: 'windsurf',
      ideVersion: '1.9600.41',
      extensionName: 'windsurf',
      extensionVersion: '1.9600.41',
      locale: 'en',
    };
  }

  /**
   * Proactive Rate Limit Capacity Check (v20.0: JSON Connect-RPC)
   * Calls CheckUserMessageRateLimit via JSON instead of binary proto.
   * Returns: { hasCapacity, message, messagesRemaining, maxMessages, resetsInSeconds } or null
   *
   * @param {string} apiKey - Session apiKey (from windsurfAuthStatus or RegisterUser)
   * @param {string} modelUid - Model UID (e.g. 'claude-opus-4-6-thinking-1m')
   */
  async checkRateLimitCapacity(apiKey, modelUid, { quiet = false } = {}) {
    if (!apiKey || !modelUid) return null;
    if (!PROXY_CHECKED) await this._probeProxy();

    // v24.0: include modelUid in the body so the server returns per-model
    // capacity (parity with windsurf-pool/WindsurfAPI). Without it, the server
    // falls back to account-level which returns NO_DATA for Trial accounts.
    // v25.0: resolve UID to proto name for accurate per-model check (windsurf-pool parity)
    const protoModelUid = resolveModelProtoName(modelUid);
    const body = {
      metadata: AuthService._buildConnectMetadata(apiKey),
      modelUid: protoModelUid,
    };
    const headers = {
      'Connect-Protocol-Version': '1',
    };

    for (const url of AuthService.CHECK_RATE_LIMIT_URLS) {
      try {
        const r = await this._httpsJson(url, 'POST', body, undefined, headers);
        if (r.ok && r.data) {
          const d = r.data;
          return {
            hasCapacity: d.hasCapacity !== false,
            message: d.message || '',
            messagesRemaining: d.messagesRemaining ?? -1,
            maxMessages: d.maxMessages ?? -1,
            resetsInSeconds: Number.isFinite(d.retryAfterMs) ? Math.ceil(d.retryAfterMs / 1000) : (d.resetsInSeconds ?? 0),
          };
        }
        if (!quiet) _warn('L5探测', `${new URL(url).hostname} → ${r.status}`);
      } catch (e) {
        if (!quiet) _warn('L5探测', `${new URL(url).hostname} error: ${e.message}`);
      }
    }

    return null;
  }

  /**
   * GetUserStatus via JSON Connect-RPC (v20.0, 参考 WindsurfAPI)
   * Returns authoritative tier, email, allowedModels, trialEndMs, credit usage.
   * Requires apiKey (not idToken).
   */
  static GET_USER_STATUS_URLS = [
    'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus',
    'https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/GetUserStatus',
  ];

  async getUserStatus(apiKey, { quiet = false } = {}) {
    if (!apiKey) return null;
    // v20.1: sk-ws-01- 前缀是 Windsurf session token，服务端会返回 200 空响应
    // (ai-quote 实测)，直接跳过避免无效往返。
    if (apiKey.startsWith('sk-ws-01-')) {
      if (!quiet) _warn('UserStatus', 'sk-ws-01 session token 不支持 GetUserStatus，跳过');
      return null;
    }
    if (!PROXY_CHECKED) await this._probeProxy();

    const body = { metadata: AuthService._buildConnectMetadata(apiKey) };
    // v25.0: x-devin-session-token for devin-auth compatibility (windsurf-pool parity)
    const headers = {
      'Connect-Protocol-Version': '1',
      'x-devin-session-token': apiKey,
    };

    for (const url of AuthService.GET_USER_STATUS_URLS) {
      try {
        const r = await this._httpsJson(url, 'POST', body, undefined, headers);
        if (r.ok && r.data) {
          const parsed = AuthService._parseUserStatusJson(r.data);
          if (parsed) {
            if (!quiet) _info('UserStatus', `tier=${parsed.tierName}(${parsed.teamsTier}) email=${parsed.email || 'n/a'} plan=${parsed.planName} models=${parsed.allowedModels.length} (via ${new URL(url).hostname})`);
            return parsed;
          }
        }
        if (!quiet) _warn('UserStatus', `${new URL(url).hostname} → ${r.status}`);
      } catch (e) {
        if (!quiet) _warn('UserStatus', `${new URL(url).hostname} error: ${e.message}`);
      }
    }
    return null;
  }

  /** Parse GetUserStatus JSON response into flat object */
  static _parseUserStatusJson(data) {
    if (!data) return null;
    const us = data.userStatus || {};
    const pi = data.planInfo || us.planInfo || {};

    const teamsTier = us.teamsTier ?? us.teams_tier ?? pi.teamsTier ?? pi.teams_tier ?? 0;
    const tierNum = typeof teamsTier === 'number' ? teamsTier : parseInt(teamsTier) || 0;
    // TeamsTier enum: 0=Unspecified,6=WaitlistPro,19=DevinFree → free; rest → pro
    const tierName = (tierNum === 0 || tierNum === 6 || tierNum === 19) ? 'free' : 'pro';

    const TIER_LABELS = {
      0: 'Unspecified', 1: 'Teams', 2: 'Pro', 3: 'Enterprise (SaaS)',
      4: 'Hybrid', 5: 'Enterprise (Self-Hosted)', 6: 'Waitlist Pro',
      7: 'Teams Ultimate', 8: 'Pro Ultimate', 9: 'Trial',
      10: 'Enterprise (Self-Serve)', 11: 'Enterprise (SaaS Pooled)',
      12: 'Devin Enterprise', 14: 'Devin Teams', 15: 'Devin Teams V2',
      16: 'Devin Pro', 17: 'Devin Max', 18: 'Max',
      19: 'Devin Free', 20: 'Devin Trial',
    };

    // Parse allowedModels from planInfo.cascadeAllowedModelsConfig
    const allowedModels = [];
    const modelConfigs = pi.cascadeAllowedModelsConfig || pi.cascade_allowed_models_config || [];
    for (const entry of modelConfigs) {
      const moa = entry.modelOrAlias || entry.model_or_alias || {};
      allowedModels.push({
        modelEnum: moa.model ?? 0,
        alias: moa.alias ?? 0,
        multiplier: entry.creditMultiplier ?? entry.credit_multiplier ?? 1.0,
      });
    }

    // Parse trialEndMs from windsurf_pro_trial_end_time
    let trialEndMs = 0;
    const trialEnd = us.windsurfProTrialEndTime || us.windsurf_pro_trial_end_time;
    if (trialEnd) {
      const secs = typeof trialEnd === 'object' ? (trialEnd.seconds || 0) : (typeof trialEnd === 'number' ? trialEnd : 0);
      trialEndMs = secs * 1000;
    }

    return {
      pro: us.pro === true,
      teamsTier: tierNum,
      tierName,
      tierLabel: TIER_LABELS[tierNum] || `Tier ${tierNum}`,
      email: us.email || '',
      displayName: us.name || us.displayName || '',
      teamId: us.teamId || us.team_id || '',
      userUsedPromptCredits: Number(us.userUsedPromptCredits ?? us.user_used_prompt_credits ?? 0),
      userUsedFlowCredits: Number(us.userUsedFlowCredits ?? us.user_used_flow_credits ?? 0),
      trialEndMs,
      maxPremiumChatMessages: Number(us.maxNumPremiumChatMessages ?? us.max_num_premium_chat_messages ?? 0),
      planName: pi.planName || pi.plan_name || '',
      monthlyPromptCredits: Number(pi.monthlyPromptCredits ?? pi.monthly_prompt_credits ?? 0),
      monthlyFlowCredits: Number(pi.monthlyFlowCredits ?? pi.monthly_flow_credits ?? 0),
      hasPaidFeatures: pi.hasPaidFeatures === true || pi.has_paid_features === true,
      isTeams: pi.isTeams === true || pi.is_teams === true,
      isEnterprise: pi.isEnterprise === true || pi.is_enterprise === true,
      allowedModels,
    };
  }

  dispose() {
    this._saveCache();
  }
}

export { AuthService };
