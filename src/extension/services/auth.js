/**
 * Auth Service — Firebase登录 + Protobuf积分查询 + Token缓存
 * 零外部依赖，纯Node.js https/http模块
 *
 * 认证链 (逆向自 Windsurf 1.108.2, 2026-03-20):
 *   1. Firebase登录(email+password) → idToken
 *   2. RegisterUser(idToken) → apiKey  (register.windsurf.com)
 *   3. 注入idToken到Windsurf PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER
 *      → Windsurf内部调registerUser → session{accessToken: apiKey}
 *   4. GetPlanStatus(idToken) → 余额(credits/quota)
 *
 * v5.8.0: self-serve.windsurf.com已从Windsurf 1.108.2移除
 *         Auth注入改为idToken直传(Windsurf内部自行registerUser)
 */
import https from 'https';
import http from 'http';
import tls from 'tls';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  parseProtoString, encodeProtoString, parseUsageInfo, parseProtoMsg,
  encodeCheckRateLimitRequest, parseCheckRateLimitResponse,
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

const TOKEN_TTL = 50 * 60 * 1000; // 50 minutes
const AUTH_PROVIDER_TTL = 24 * 60 * 60 * 1000;
const PROXY_HOST = '127.0.0.1';
const PROXY_PORTS = [7890, 7897, 7891, 10808, 1080, 8080, 8118, 3128, 9090]; // 按优先级探测
let ACTIVE_PROXY_PORT = 7890; // 当前生效端口（自动探测更新）
let PROXY_CHECKED = false;
let _probeDetail = { source: 'none', verified: false, lastProbe: 0 }; // 探测详情

// 双模式: 'local' = 本地代理, 'relay' = 网站中转(无需VPN)
let ACTIVE_MODE = 'local';

// 可注入日志函数 — setLogger() 注入后写入 outputChannel, 否则降级 console.log
let _info = (tag, msg) => console.log(`WAM: [${tag}] ${msg}`);
let _warn = (tag, msg) => console.log(`WAM: [WARN][${tag}] ${msg}`);
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
const DEVIN_AUTH_COOLDOWN_MS = 60_000; // after 429 on /_devin-auth/*

class AuthService {
  constructor(storagePath) {
    this._tokenCache = new Map(); // email -> { idToken, expireTime }
    this._providerCache = new Map(); // email -> { provider, expireTime }
    this._storagePath = storagePath || null;
    this._cachePath = null; // set lazily in _getCachePath()
    this._providerCachePath = null;
    this._devinAuthCooldownUntil = 0; // ts — skip devin-auth before this
    this._loadCache();
    this._loadProviderCache();
    // P1 fix: proxy probing is lazy — runs on first network request, not at construction
    // This prevents TCP socket operations during Extension Host activation
  }

  /** 注入结构化日志 (extension.js 初始化时调用) */
  setLogger(logInfo, logWarn) {
    if (logInfo) _info = logInfo;
    if (logWarn) _warn = logWarn;
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

  /** 验证代理真正可达外网(不只是端口开放) — 通过代理发HTTP请求到Google */
  _verifyProxyReachability(host, port, timeoutMs = 5000) {
    return new Promise(resolve => {
      try {
        const req = http.request({
          hostname: host, port, method: 'CONNECT',
          path: 'www.google.com:443', timeout: timeoutMs
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

  /** 智能探测本地可用代理：系统代理 → 环境变量 → 端口扫描 → 连通性验证 */
  async _probeProxy() {
    if (PROXY_CHECKED) return;
    const startTs = Date.now();
    // Phase 1: System/env proxy candidates
    const sysCandidates = this._detectSystemProxy();
    for (const c of sysCandidates) {
      const portOk = await this._tcpProbe(c.host, c.port, 600);
      if (portOk) {
        // Quick verify: can it actually reach the internet?
        const reachable = await this._verifyProxyReachability(c.host, c.port, 3000);
        if (reachable) {
          ACTIVE_PROXY_PORT = c.port;
          ACTIVE_MODE = 'local';
          PROXY_CHECKED = true;
          _probeDetail = { source: c.source, verified: true, lastProbe: Date.now(), host: c.host, elapsed: Date.now() - startTs };
          _info('代理', `proxy verified via ${c.source} → ${c.host}:${c.port} (${_probeDetail.elapsed}ms)`);
          return;
        }
        // Port open but not reachable — still usable as fallback
        ACTIVE_PROXY_PORT = c.port;
        _probeDetail = { source: c.source, verified: false, lastProbe: Date.now(), host: c.host };
        _info('代理', `proxy port open via ${c.source} → ${c.host}:${c.port} (unverified)`);
      }
    }

    // Phase 2: Scan common VPN ports on localhost
    for (const port of PROXY_PORTS) {
      const ok = await this._tcpProbe(PROXY_HOST, port, 600);
      if (ok) {
        ACTIVE_PROXY_PORT = port;
        ACTIVE_MODE = 'local';
        PROXY_CHECKED = true;
        _probeDetail = { source: `scan:${port}`, verified: false, lastProbe: Date.now(), host: PROXY_HOST, elapsed: Date.now() - startTs };
        _info('代理', `proxy detected on port ${port} (${_probeDetail.elapsed}ms)`);
        return;
      }
    }

    // Phase 3: No local proxy → relay mode
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

  /** 手动切换模式 */
  setMode(mode) {
    if (mode === 'local' || mode === 'relay') {
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
    // 优先从JWT exp字段计算精确过期时间(提前2min buffer), 失败时降级到固定TTL
    let expireTime = Date.now() + TOKEN_TTL;
    try {
      const parts = idToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (payload.exp) {
          expireTime = payload.exp * 1000 - 120000; // exp是秒级,提前2min刷新
        }
      }
    } catch {}
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
      for (const [email, entry] of Object.entries(data)) {
        if (entry?.provider && entry.expireTime > now) {
          this._providerCache.set(email, entry);
        }
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
    this._providerCache.set(key, {
      provider,
      expireTime: Date.now() + AUTH_PROVIDER_TTL,
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

  /** Create CONNECT tunnel through HTTP proxy, return TLS socket */
  _proxyTunnel(hostname) {
    return new Promise((resolve, reject) => {
      const proxyReq = http.request({
        hostname: PROXY_HOST, port: ACTIVE_PROXY_PORT,
        method: 'CONNECT', path: `${hostname}:443`, timeout: 8000
      });
      proxyReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`proxy CONNECT ${res.statusCode}`)); }
        const tlsSocket = tls.connect({ socket, servername: hostname, rejectUnauthorized: true }, () => {
          if (tlsSocket.authorized || tlsSocket.alpnProtocol) resolve(tlsSocket);
          else resolve(tlsSocket); // still usable even if not fully authorized
        });
        tlsSocket.on('error', e => reject(e));
      });
      proxyReq.on('error', e => reject(e));
      proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('proxy timeout')); });
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
      // 双模式：relay模式下跳过代理，local模式下按需代理
      let wantProxy;
      if (useProxy !== undefined) wantProxy = useProxy;
      else if (ACTIVE_MODE === 'relay') wantProxy = false;
      else wantProxy = this._needsProxy(u.hostname);

      const hdrs = { 'Content-Type': 'application/json', ...extraHeaders };

      if (wantProxy) {
        try {
          const sock = await this._proxyTunnel(u.hostname);
          const resp = await this._rawRequest(sock, u.hostname, u.pathname + u.search, method || 'GET', hdrs, data);
          const rawText = resp.bodyBuffer.toString('utf8');
          if (!resp.ok) {
            _warn('HTTP', `JSON ${u.hostname}${u.pathname} → ${resp.status} (proxy, ${Date.now() - _t0}ms)`);
            _warnHttpErrorRaw('JSON', u.hostname, u.pathname, resp.status, rawText);
          }
          try { resolve({ ok: resp.ok, status: resp.status, data: JSON.parse(rawText), raw: rawText }); }
          catch { resolve({ ok: resp.ok, status: resp.status, data: {}, raw: rawText }); }
        } catch (e) { _warn('HTTP', `JSON ${u.hostname}${u.pathname} → ERR ${e.message} (proxy, ${Date.now() - _t0}ms)`); reject(e); }
      } else {
        const agent = new https.Agent({ keepAlive: false });
        const req = https.request({
          hostname: u.hostname, port: 443, path: u.pathname + u.search,
          method: method || 'GET', headers: hdrs, agent
        }, (res) => {
          let buf = '';
          res.on('data', c => buf += c);
          res.on('end', () => {
            agent.destroy();
            if (res.statusCode !== 200) {
              _warn('HTTP', `JSON ${u.hostname}${u.pathname} → ${res.statusCode} (direct, ${Date.now() - _t0}ms)`);
              _warnHttpErrorRaw('JSON', u.hostname, u.pathname, res.statusCode, buf);
            }
            try { resolve({ ok: res.statusCode === 200, status: res.statusCode, data: JSON.parse(buf), raw: buf }); }
            catch { resolve({ ok: res.statusCode === 200, status: res.statusCode, data: {}, raw: buf }); }
          });
          res.on('error', () => { agent.destroy(); reject(new Error('response error')); });
        });
        req.on('error', e => { agent.destroy(); _warn('HTTP', `JSON ${u.hostname}${u.pathname} → ERR ${e.message} (direct, ${Date.now() - _t0}ms)`); reject(e); });
        req.setTimeout(12000, () => { agent.destroy(); req.destroy(); _warn('HTTP', `JSON ${u.hostname}${u.pathname} → TIMEOUT (direct, ${Date.now() - _t0}ms)`); reject(new Error('timeout')); });
        if (data) req.write(data);
        req.end();
      }
    });
  }

  _httpsBinary(url, method, bodyBuffer, useProxy, extraHeaders = {}) {
    return new Promise(async (resolve, reject) => {
      const _t0 = Date.now();
      const u = new URL(url);
      let wantProxy;
      if (useProxy !== undefined) wantProxy = useProxy;
      else if (ACTIVE_MODE === 'relay') wantProxy = false;
      else wantProxy = this._needsProxy(u.hostname);

      if (wantProxy) {
        try {
          const sock = await this._proxyTunnel(u.hostname);
          const headers = {
            'Content-Type': 'application/proto',
            'connect-protocol-version': '1',
            ...extraHeaders,
          };
          const resp = await this._rawRequest(sock, u.hostname, u.pathname + u.search, method || 'POST', headers, bodyBuffer ? Buffer.from(bodyBuffer) : null);
          if (!resp.ok) {
            _warn('HTTP', `BIN ${u.hostname}${u.pathname.split('/').pop()} → ${resp.status} ${resp.bodyBuffer?.length || 0}B (proxy, ${Date.now() - _t0}ms)`);
            _warnHttpErrorRaw('BIN', u.hostname, u.pathname.split('/').pop(), resp.status, resp.bodyBuffer);
          }
          resolve({ ok: resp.ok, status: resp.status, buffer: resp.bodyBuffer });
        } catch (e) { _warn('HTTP', `BIN ${u.hostname}${u.pathname.split('/').pop()} → ERR ${e.message} (proxy, ${Date.now() - _t0}ms)`); reject(e); }
      } else {
        const agent = new https.Agent({ keepAlive: false });
        const headers = {
          'Content-Type': 'application/proto',
          'connect-protocol-version': '1',
          ...extraHeaders,
        };
        const req = https.request({
          hostname: u.hostname, port: 443, path: u.pathname + u.search,
          method: method || 'POST', headers, agent
        }, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            agent.destroy();
            const buf = Buffer.concat(chunks);
            if (res.statusCode !== 200) {
              _warn('HTTP', `BIN ${u.hostname}${u.pathname.split('/').pop()} → ${res.statusCode} ${buf.length}B (direct, ${Date.now() - _t0}ms)`);
              _warnHttpErrorRaw('BIN', u.hostname, u.pathname.split('/').pop(), res.statusCode, buf);
            }
            resolve({ ok: res.statusCode === 200, status: res.statusCode, buffer: buf });
          });
          res.on('error', () => { agent.destroy(); reject(new Error('response error')); });
        });
        req.on('error', e => { agent.destroy(); _warn('HTTP', `BIN ${u.hostname}${u.pathname.split('/').pop()} → ERR ${e.message} (direct, ${Date.now() - _t0}ms)`); reject(e); });
        req.setTimeout(12000, () => { agent.destroy(); req.destroy(); _warn('HTTP', `BIN ${u.hostname}${u.pathname.split('/').pop()} → TIMEOUT (direct, ${Date.now() - _t0}ms)`); reject(new Error('timeout')); });
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

  _isFatalFirebaseAuthError(message) {
    return /INVALID_LOGIN_CREDENTIALS|EMAIL_NOT_FOUND|INVALID_PASSWORD|USER_DISABLED|App\s*Check\s*token/i.test(String(message || ''));
  }

  async _withNetworkRetry(label, fn, maxRetries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastError = e;
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

  async _windsurfPostAuth(auth1Token) {
    const body = Buffer.concat([
      encodeProtoString(auth1Token, 1),
      encodeProtoString('', 2),
    ]);
    const resp = await this._httpsBinary(
      'https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth',
      'POST',
      body,
      undefined,
      {
        Accept: 'application/proto',
        'User-Agent': 'Mozilla/5.0',
        'X-Devin-Auth1-Token': auth1Token,
      },
    );
    if (!resp?.ok || !resp.buffer?.length) {
      throw new Error(`WindsurfPostAuth failed: HTTP ${resp?.status || 'no_response'}`);
    }
    return this._decodeProtoStringFields(resp.buffer);
  }

  async _signInWithDevinAuth(email, password) {
    const _emailPrefix = email.split('@')[0];
    const connections = await this._withNetworkRetry('Devin Auth connections', async () => {
      const r = await this._httpsJson(
        'https://windsurf.com/_devin-auth/connections',
        'POST',
        { email },
      );
      if (!r.ok) throw new Error(r.data?.error?.message || `HTTP ${r.status}`);
      return r.data;
    });
    if (
      connections?.auth_method?.method !== 'auth1' ||
      connections?.auth_method?.has_password !== true
    ) {
      throw new Error('Devin Auth 不支持密码登录');
    }

    const login = await this._withNetworkRetry('Devin Auth password login', async () => {
      const r = await this._httpsJson(
        'https://windsurf.com/_devin-auth/password/login',
        'POST',
        { email, password },
      );
      if (!r.ok) throw new Error(r.data?.error?.message || `HTTP ${r.status}`);
      return r.data;
    });
    if (!login?.token) throw new Error('Devin Auth 返回空 token');

    const postAuth = await this._withNetworkRetry('WindsurfPostAuth', () => this._windsurfPostAuth(login.token));
    if (!postAuth.sessionToken) throw new Error('WindsurfPostAuth 返回空 sessionToken');

    _info('登录', `${_emailPrefix} → devin-auth`);
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

  async login(email, password, forceFresh = false, cacheOnly = false) {
    const _t0 = Date.now();
    const _emailPrefix = email.split('@')[0];
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

    const payload = { returnSecureToken: true, email, password, clientType: 'CLIENT_TYPE_WEB' };
    const fbHeaders = { Referer: 'https://windsurf.com/', Origin: 'https://windsurf.com' };
    const errors = [];
    const cachedProvider = this._getCachedAuthProvider(email);

    const devinCooldownLeft = this._devinAuthCooldownUntil - Date.now();
    if (cachedProvider === 'firebase' || cachedProvider === 'unsupported-devin') {
      _info('登录', `${_emailPrefix} → provider cached(${cachedProvider}), skip devin-auth`);
      errors.push(`devin-auth: skipped(${cachedProvider})`);
    } else if (devinCooldownLeft > 0) {
      errors.push(`devin-auth: cooldown(${Math.ceil(devinCooldownLeft / 1000)}s)`);
    } else {
      try {
        const devin = await this._signInWithDevinAuth(email, password);
        this._setCachedToken(email, devin.idToken);
        this._setCachedAuthProvider(email, 'devin-auth');
        return { ...devin, elapsed: Date.now() - _t0 };
      } catch (e) {
        errors.push(`devin-auth: ${e.message}`);
        if (this._isUnsupportedDevinAuthError(e.message)) {
          this._setCachedAuthProvider(email, 'unsupported-devin');
        } else if (/\b429\b|rate[\s_-]*limit/i.test(e.message || '')) {
          this._devinAuthCooldownUntil = Date.now() + DEVIN_AUTH_COOLDOWN_MS;
          _warn('登录', `devin-auth 全局冷却 ${DEVIN_AUTH_COOLDOWN_MS / 1000}s (upstream 429)`);
        }
        _warn('登录', `${_emailPrefix} → devin-auth fallback: ${e.message}`);
      }
    }

    const tryFirebase = async (useProxy) => {
      for (const key of FIREBASE_KEYS) {
        const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`;
        try {
          const r = await this._httpsJson(url, 'POST', payload, useProxy, fbHeaders);
          if (r.ok && r.data.idToken) {
            this._setCachedToken(email, r.data.idToken, r.data.refreshToken || null);
            this._setCachedAuthProvider(email, 'firebase');
            const channel = useProxy === true ? 'firebase-proxy' : 'firebase-local';
            _info('登录', `${_emailPrefix} → ${channel} (${Date.now() - _t0}ms)`);
            return { ok: true, idToken: r.data.idToken, email: r.data.email || email, channel };
          }
          const msg = r.data?.error?.message || `HTTP ${r.status}`;
          errors.push(`firebase: ${msg}`);
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
          _info('登录', `${_emailPrefix} → relay (${Date.now() - _t0}ms)`);
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
          _info('登录', `${_emailPrefix} → relay-fallback (${Date.now() - _t0}ms)`);
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
   */
  async getUsageInfo(email, password, options = {}) {
    const _t0 = Date.now();
    const _emailPrefix = email.split('@')[0];
    const loginResult = await this.login(email, password, false, !!options.cacheOnly);
    if (!loginResult.ok) {
      if (loginResult.cacheOnly) {
        return { ok: false, errorType: 'cache_miss', cacheOnly: true };
      }
      const error = loginResult.error || 'login_failed';
      const errorType = this._isFatalFirebaseAuthError(error) ? 'invalid_credentials' : 'login_failed';
      _warn('额度', `${_emailPrefix} → login failed (${Date.now() - _t0}ms)`);
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
      const devin = await this.login(email, password, true);
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
      const fresh = await this.login(email, password, true);
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
            const devin = await this.login(email, password, true);
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
      return { ok: false, errorType: 'plan_status_failed', error: 'no_response' };
    }
    const result = resp ? parseUsageInfo(resp.buffer) : jsonUsage;
    if (result) {
      result.userEmail = loginResult.email || email;
      result.source = resp ? 'api' : 'api_json';
    }
    _info('额度', `${_emailPrefix} → ${result?.mode || '?'} daily=${result?.daily?.remaining ?? '?'}% weekly=${result?.weekly?.remaining ?? '?'}% (${Date.now() - _t0}ms, login=${_t1 - _t0}ms, plan=${Date.now() - _t1}ms)`);
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
    const billingStrategy = typeof billingRaw === 'string'
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

  async _fetchPlanStatusJson(idToken) {
    const body = { auth_token: idToken };
    const headers = {
      'X-Auth-Token': idToken,
      'User-Agent': 'Mozilla/5.0',
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
          if (parsed) return parsed;
        }
        _warn('额度', `JSON GetPlanStatus ${new URL(url).hostname} → ${r.status}`);
      } catch (e) {
        _warn('额度', `JSON GetPlanStatus ${new URL(url).hostname} → ERR ${e.message}`);
      }
    }
    return null;
  }

  // ========== RegisterUser → apiKey (for hot injection, mode-aware) ==========

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

  // ========== GetOneTimeAuthToken (legacy v5.0.20 flow, mode-aware) ==========

  // v5.8.0: In Windsurf 1.108.2, PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER accepts
  // firebase idToken directly and internally calls registerUser. So the preferred
  // injection path is: login → idToken → inject idToken via command.
  // getOneTimeAuthToken is kept as FALLBACK only (relay path).
  async getOneTimeAuthToken(email, password) {
    const loginResult = await this.login(email, password, true);
    if (!loginResult.ok) return null;

    const reqData = encodeProtoString(loginResult.idToken);
    // v5.8.0: self-serve.windsurf.com removed from Windsurf 1.108.2
    // Try relay only (the only known working OneTimeAuthToken endpoint)
    const resp = await this._tryRelaysBinary('/windsurf/auth-token', reqData);
    if (!resp) return null;

    return parseProtoString(resp.buffer);
  }

  /** v5.8.0: Get fresh firebase idToken for direct injection into Windsurf command.
   *  This is the PRIMARY auth injection path in Windsurf 1.108.2+.
   *  The command internally calls registerUser(firebaseIdToken) → {apiKey, name} → session */
  async getFreshIdToken(email, password) {
    const loginResult = await this.login(email, password, true);
    if (!loginResult.ok) return null;
    return loginResult.idToken;
  }

  // ========== Cached Quota Reader (reads Windsurf's internal state.vscdb) ==========
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
   *  Switch confirmation needs identity, not quota freshness. */
  readCachedAuthEmail() {
    try {
      const dbPath = getStateDbPath();
      if (!fs.existsSync(dbPath)) return null;

      const protoQuota = this.readCachedUserStatusProto(dbPath);
      if (protoQuota?.email) return protoQuota.email;

      const authRaw = dbReadKey(dbPath, 'windsurfAuthStatus');
      if (authRaw) {
        try {
          const authStatus = JSON.parse(authRaw);
          if (authStatus.userEmail) return authStatus.userEmail;
          if (authStatus.email) return authStatus.email;
        } catch {}
      }

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
  // 逆向自 @exa/chat-client: CheckUserMessageRateLimit 是 Cascade 发送消息前的预检端点
  // 服务端对每个(apiKey, model)维护滑动窗口速率桶，此端点返回精确容量数据
  // WAM主动调用此端点 → 在用户消息失败前获知容量 → 提前切号 = 永不触发rate limit

  // ApiServerService returns 400 (recognized), LanguageServerService returns 404 (missing)
  static CHECK_RATE_LIMIT_URLS = [
    'https://server.codeium.com/exa.api_server_pb.ApiServerService/CheckUserMessageRateLimit',
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

  /**
   * Proactive Rate Limit Capacity Check
   * Calls CheckUserMessageRateLimit gRPC endpoint to get real-time capacity data.
   * Returns: { hasCapacity, message, messagesRemaining, maxMessages, resetsInSeconds } or null
   *
   * @param {string} apiKey - Session apiKey (from windsurfAuthStatus or RegisterUser)
   * @param {string} modelUid - Model UID (e.g. 'claude-opus-4-6-thinking-1m')
   */
  async checkRateLimitCapacity(apiKey, modelUid, { quiet = false } = {}) {
    if (!apiKey || !modelUid) return null;
    if (!PROXY_CHECKED) await this._probeProxy();

    const reqData = encodeCheckRateLimitRequest(apiKey, modelUid);

    // Try direct endpoints (via proxy if needed)
    for (const url of AuthService.CHECK_RATE_LIMIT_URLS) {
      try {
        const resp = await this._httpsBinary(url, 'POST', reqData);
        if (resp.ok && resp.buffer && resp.buffer.length > 0) {
          const result = parseCheckRateLimitResponse(resp.buffer);
          _info('L5探测', `hasCapacity=${result.hasCapacity} remaining=${result.messagesRemaining}/${result.maxMessages} resets=${result.resetsInSeconds}s msg="${result.message}" (via ${new URL(url).hostname})`);
          return result;
        }
        // Non-200 — log only when not in quiet (backoff) mode
        if (!quiet && resp.buffer && resp.buffer.length > 0) {
          try {
            const errText = resp.buffer.toString('utf8');
            _warn('L5探测', `non-ok response (${resp.status}): ${errText.substring(0, 200)}`);
          } catch {}
        }
      } catch (e) {
        if (!quiet) _warn('L5探测', `${new URL(url).hostname} error: ${e.message}`);
      }
    }

    return null;
  }

  dispose() {
    this._saveCache();
  }
}

export { AuthService };
