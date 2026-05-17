// 出口 IP 探测服务 (v22.6)
// Why: 让用户在 webview 看到当前 Windsurf 流量的真实出口 IP
//      复用 AuthService 的 _httpsJson — 自动按 mode/proxy 路由,
//      保证查到的 IP 等同于 Windsurf 实际出口

const IP_API_URL = 'https://my.ippure.com/v1/info';
const CACHE_TTL_MS = 30_000;
const TIMEOUT_GUARD_MS = 6_000;

class EgressIpService {
  constructor(authService) {
    this._auth = authService;
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
    // Reuse AuthService's HTTPS layer — handles proxy/direct + circuit breaker
    const r = await this._auth._httpsJson(
      IP_API_URL,
      'GET',
      null,
      undefined,
      { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
    );
    if (!r || !r.ok || !r.data || typeof r.data !== 'object' || !r.data.ip) {
      return null;
    }
    return {
      ip: String(r.data.ip),
      country: String(r.data.country || ''),
      countryCode: String(r.data.countryCode || ''),
      asOrganization: String(r.data.asOrganization || ''),
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
