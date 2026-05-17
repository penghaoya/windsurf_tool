// 出口 IP 探测服务 (v22.7)
// Why: 显示本地网络出口 IP — 直连请求, 不走 Windsurf 代理层,
//      避免把 IP 探测请求计入 host-dead 熔断器
import https from 'https';
import { URL } from 'url';

const IP_API_URL = 'https://my.ippure.com/v1/info';
const CACHE_TTL_MS = 30_000;
const TIMEOUT_GUARD_MS = 6_000;

class EgressIpService {
  constructor(authService) {
    this._auth = authService; // kept for compatibility; not used for fetch
    this._cache = null;        // { ip, country, countryCode, ts }
    this._cacheUntil = 0;
    this._inflight = null;     // dedupe concurrent fetches
  }

  /** Get cached value without triggering fetch — for synchronous reads */
  getCached() {
    if (this._cache && Date.now() < this._cacheUntil) return this._cache;
    return null;
  }

  /** Fetch with cache + dedup. force=true bypasses cache. */
  async fetch({ force = false } = {}) {
    if (!force && this._cache && Date.now() < this._cacheUntil) {
      return this._cache;
    }
    if (this._inflight) return this._inflight;

    this._inflight = (async () => {
      try {
        const result = await Promise.race([
          this._doFetch(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), TIMEOUT_GUARD_MS)
          ),
        ]);
        if (result) {
          this._cache = result;
          this._cacheUntil = Date.now() + CACHE_TTL_MS;
        }
        return result;
      } catch {
        return null;
      } finally {
        this._inflight = null;
      }
    })();

    return this._inflight;
  }

  async _doFetch() {
    const data = await directHttpsJson(IP_API_URL, TIMEOUT_GUARD_MS);
    if (!data || typeof data !== 'object' || !data.ip) return null;
    return {
      ip: String(data.ip),
      country: String(data.country || ''),
      countryCode: String(data.countryCode || ''),
      asOrganization: String(data.asOrganization || ''),
      ts: Date.now(),
    };
  }

  /** Drop cache so next read triggers a fresh fetch (use after account switch) */
  invalidate() {
    this._cache = null;
    this._cacheUntil = 0;
  }
}

export function createEgressIpService(authService) {
  return new EgressIpService(authService);
}

// Plain direct HTTPS GET — no proxy, no agent reuse, no circuit-breaker side effects.
function directHttpsJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    let u;
    try { u = new URL(url); } catch { return finish(null); }
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: (u.pathname || '/') + (u.search || ''),
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        // why: opt out of any global agent so a custom proxy agent never leaks in
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            return finish(null);
          }
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            finish(JSON.parse(body));
          } catch { finish(null); }
        });
        res.on('error', () => finish(null));
      },
    );
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {}; finish(null); });
    req.on('error', () => finish(null));
    req.end();
  });
}
