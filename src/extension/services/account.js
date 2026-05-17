/**
 * Account Manager — 账号CRUD + 文件存储 + 多窗口同步
 * 零外部依赖，纯文件系统操作
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  findBestForModel as findBestForModelWithSelector,
  selectOptimal as selectOptimalWithSelector,
} from './accountSelector.js';
import { safeReadJsonSync, safeWriteJsonSync } from '../infra/safeJson.js';
import { parseAccounts } from '../shared/accountParser.js';
import { shouldAcceptUsageWrite } from '../shared/quota.js';

// Fields the user would lose if we don't persist them. Volatile fields
// (usage, rateLimit, authError, credits) are recoverable via re-fetch and
// stay only in the primary file to avoid 3x I/O on every quota refresh.
// apiKey/apiKeyAt/apiKeySource: persisted so quota refreshes can skip Firebase
// login chain (windsurf-pool style: long-lived sessionToken → GetUserStatus).
const PERSISTENT_FIELDS = ['email', 'password', 'addedAt', 'fingerprint', 'loginCount', 'selectionMode', 'apiKey', 'apiKeyAt', 'apiKeySource'];

function _extractPersistent(account) {
  const out = {};
  for (const k of PERSISTENT_FIELDS) {
    if (account[k] !== undefined) out[k] = account[k];
  }
  return out;
}

class AccountManager {
  constructor(storagePath, options) {
    this._filePath = null;
    this._persistentPaths = []; // Additional persistent paths outside extension dir
    this._accounts = [];
    this._revision = 0; // optimistic lock — monotonically increasing version counter
    this._updatedAt = ''; // ISO timestamp of last write
    this._watcher = null;
    this._writing = false;
    this._listeners = [];
    this._lastNotifyFingerprint = '';
    this._rateLimits = new Map(); // email -> { until: timestamp, model, resetsIn, maxMessages, messagesRemaining }
    this._modelRateLimits = new Map(); // "email|modelUid" -> { until, resetsIn, hitAt } — per-(account,model) bucket
    this._lastUsedTs = new Map(); // index → timestamp, 均匀消耗追踪
    this._rateLimitHitCount = new Map(); // email → consecutive hit count, 指数退避
    this._discoveredPaths = []; // Auto-discovered paths (also written to on save to prevent stale merges)
    this._isolated = !!(options && options.isolated); // test isolation — skip persistent paths + discovery
    this._saveTimer = null; // debounce timer for _save
    this._persistentDirty = false; // mark when PERSISTENT_FIELDS changed → triggers backup-path write
    this._init(storagePath);
  }

  _init(storagePath) {
    try {
      if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
      }
    } catch (e) { console.error('WAM: storage dir failed:', e.message); }
    this._filePath = path.join(storagePath, 'windsurf-assistant-accounts.json');

    // === Triple-persistence: extension dir + globalStorage root + user home ===
    if (!this._isolated) {
      // P0: globalStorage root (survives extension reinstall)
      const rootPath = this._getGlobalStorageRootPath();
      if (rootPath) this._persistentPaths.push(rootPath);
      // P1: user home .wam dir (survives even Windsurf uninstall)
      const homePath = this._getUserHomePath();
      if (homePath) this._persistentPaths.push(homePath);
    }
    console.log(`WAM: [存储] 主路径=${this._filePath}${this._isolated ? ' [隔离模式]' : ''}`);
    if (!this._isolated) console.log(`WAM: [存储] 持久化路径=${this._persistentPaths.join(' | ')}`);

    // Multi-source merge: load from ALL known locations, keep union of all accounts
    this._loadAndMergeAll();
  }

  /** Get globalStorage ROOT path (not extension-specific) */
  _getGlobalStorageRootPath() {
    try {
      const p = process.platform;
      let base;
      if (p === 'win32') {
        const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        base = path.join(appdata, 'Windsurf', 'User', 'globalStorage');
      } else if (p === 'darwin') {
        base = path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage');
      } else {
        base = path.join(os.homedir(), '.config', 'Windsurf', 'User', 'globalStorage');
      }
      return path.join(base, 'windsurf-assistant-accounts.json');
    } catch { return null; }
  }

  /** Get user home backup path (~/.wam/accounts-backup.json) */
  _getUserHomePath() {
    try {
      const wamDir = path.join(os.homedir(), '.wam');
      if (!fs.existsSync(wamDir)) fs.mkdirSync(wamDir, { recursive: true });
      return path.join(wamDir, 'accounts-backup.json');
    } catch { return null; }
  }

  /** Load accounts from a single file path, returns { accounts, revision } */
  _loadFrom(filePath) {
    try {
      const data = safeReadJsonSync(filePath, []);
      // v19.1: support envelope format { revision, updatedAt, accounts }
      if (data && !Array.isArray(data) && Array.isArray(data.accounts)) {
        return { accounts: data.accounts, revision: data.revision || 0, updatedAt: data.updatedAt || '' };
      }
      if (Array.isArray(data)) return { accounts: data, revision: 0, updatedAt: '' };
    } catch {}
    return { accounts: [], revision: 0, updatedAt: '' };
  }

  /** Auto-discover any extension storage dirs that contain accounts (handles publisher name changes) */
  _discoverExtensionAccounts() {
    const results = [];
    try {
      const rootPath = this._getGlobalStorageRootPath();
      if (!rootPath) return results;
      const gsRoot = path.dirname(rootPath);
      if (!fs.existsSync(gsRoot)) return results;
      const entries = fs.readdirSync(gsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.includes('windsurf-login') && !entry.name.includes('windsurf-assistant')) continue;
        const candidate1 = path.join(gsRoot, entry.name, 'windsurf-assistant-accounts.json');
        const candidate2 = path.join(gsRoot, entry.name, 'windsurf-login-accounts.json');
        const candidate = fs.existsSync(candidate1) ? candidate1 : candidate2;
        if (fs.existsSync(candidate) && candidate !== this._filePath && !this._persistentPaths.includes(candidate)) {
          const data = this._loadFrom(candidate).accounts;
          if (data.length > 0) {
            console.log(`WAM: [发现] 在${entry.name}中找到${data.length}个账号`);
            results.push(...data);
          }
          // Track discovered path so _save() can keep it in sync
          if (!this._discoveredPaths.includes(candidate)) {
            this._discoveredPaths.push(candidate);
          }
        }
      }
    } catch (e) { console.warn('WAM: discovery error:', e.message); }
    return results;
  }

  /** Load from ALL known sources and merge into unified account list */
  _loadAndMergeAll() {
    // Source 1: Primary (extension storage)
    const primaryResult = this._loadFrom(this._filePath);
    const primary = primaryResult.accounts;
    // Track primary revision for optimistic locking
    if (primaryResult.revision > this._revision) {
      this._revision = primaryResult.revision;
      this._updatedAt = primaryResult.updatedAt;
    }
    // Source 2+3: Persistent paths (globalStorage root + user home)
    const persistentSources = this._persistentPaths.map(p => this._loadFrom(p).accounts);
    // Source 4: Auto-discovered extension dirs (handles publisher name changes)
    const discovered = this._isolated ? [] : this._discoverExtensionAccounts();

    // Start with the largest source as base
    let allSources = [primary, ...persistentSources, discovered].filter(s => s.length > 0);
    if (allSources.length === 0) {
      this._accounts = [];
      return;
    }

    // Sort by size descending — largest first as base
    allSources.sort((a, b) => b.length - a.length);
    this._accounts = [...allSources[0]];

    // Merge remaining sources
    let merged = 0;
    for (let s = 1; s < allSources.length; s++) {
      for (const ext of allSources[s]) {
        if (!ext.email) continue;
        const extLower = ext.email.toLowerCase();
        const existing = this._accounts.findIndex(a => a.email && a.email.toLowerCase() === extLower);
        if (existing < 0) {
          this._accounts.push(ext);
          merged++;
        } else {
          // Keep fresher data
          const local = this._accounts[existing];
          if (ext.usage?.lastChecked > (local.usage?.lastChecked || 0)) {
            this._accounts[existing] = { ...local, ...ext, email: local.email };
          }
          if (ext.password && !local.password) {
            local.password = ext.password;
          }
        }
      }
    }

    // Deduplicate by email (handles intra-source duplicates from discovery)
    const seen = new Set();
    const before = this._accounts.length;
    this._accounts = this._accounts.filter(a => {
      if (!a.email || seen.has(a.email)) return false;
      seen.add(a.email);
      return true;
    });
    const deduped = before - this._accounts.length;
    if (deduped > 0) console.log(`WAM: [去重] 已移除${deduped}个重复账号`);

    // Migration: strip deprecated fields from loaded data
    let migrated = false;
    for (const a of this._accounts) {
      if (a.creditHistory) { delete a.creditHistory; migrated = true; }
      if (a.lastChecked !== undefined) { delete a.lastChecked; migrated = true; }
      if (a.usage) {
        if (a.usage.credits !== undefined) { delete a.usage.credits; migrated = true; }
        if (a.usage.maxPremiumMessages !== undefined) { delete a.usage.maxPremiumMessages; migrated = true; }
        if (a.usage.gracePeriodEnd !== undefined) { delete a.usage.gracePeriodEnd; migrated = true; }
        if (a.usage.gracePeriodStatus !== undefined) { delete a.usage.gracePeriodStatus; migrated = true; }
      }
    }

    if (merged > 0 || deduped > 0 || migrated) {
      console.log(`WAM: [合并] 从持久化存储恢复${merged}个账号! 总计: ${this._accounts.length}`);
      this._markPersistent(); // merged data is critical — flush to backup paths
      this._saveNow(); // Persist the merged result to all locations (immediate, not debounced)
    } else {
      console.log(`WAM: [加载] 已加载${this._accounts.length}个账号`);
    }
  }

  /** Mark a mutation as touching PERSISTENT_FIELDS — triggers backup-path write on next flush */
  _markPersistent() { this._persistentDirty = true; }

  /** Debounced save — coalesces rapid writes within 800ms */
  _save() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._saveNow(); }, 800);
  }

  /** Flush pending save immediately (call on dispose / critical ops) */
  _flushSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._saveNow();
    }
  }

  /** Revalidate from disk before write — detect if another window changed data.
   *  Returns true if disk had newer revision (state was reloaded). */
  _revalidateBeforeWrite() {
    try {
      const diskResult = this._loadFrom(this._filePath);
      if (diskResult.revision > this._revision) {
        console.log(`WAM: [乐观锁] 磁盘revision=${diskResult.revision} > 内存revision=${this._revision}, 重新加载`);
        this._revision = diskResult.revision;
        this._updatedAt = diskResult.updatedAt;
        // Merge disk state into memory (preserve runtime-only state like rateLimits)
        this._mergeFromDisk(diskResult.accounts);
        this._notify();
        return true;
      }
    } catch {}
    return false;
  }

  /** Merge disk accounts into in-memory state (preserves runtime fields) */
  _mergeFromDisk(diskAccounts) {
    const diskMap = new Map(diskAccounts.map(a => [a.email, a]));
    const memoryMap = new Map(this._accounts.map(a => [a.email, a]));
    // Update existing + add new from disk
    for (const [email, diskA] of diskMap) {
      const memA = memoryMap.get(email);
      if (memA) {
        // Disk wins for persistent fields; memory wins for volatile runtime state
        for (const k of PERSISTENT_FIELDS) {
          if (diskA[k] !== undefined) memA[k] = diskA[k];
        }
        // Disk wins for usage if fresher
        if (diskA.usage?.lastChecked > (memA.usage?.lastChecked || 0)) {
          memA.usage = diskA.usage;
        }
        if (diskA.credits !== undefined && diskA.usage?.lastChecked > (memA.usage?.lastChecked || 0)) {
          memA.credits = diskA.credits;
        }
      } else {
        this._accounts.push(diskA);
      }
    }
    // Remove accounts deleted from disk by other windows
    this._accounts = this._accounts.filter(a => diskMap.has(a.email) || !a.email);
  }

  _saveNow() {
    const wasDirty = this._persistentDirty;
    // Optimistic lock: revalidate before write to detect concurrent modifications
    this._revalidateBeforeWrite();
    // Increment revision
    this._revision += 1;
    this._updatedAt = new Date().toISOString();
    // Write FULL state to primary (extension storage) — envelope format with revision
    const envelope = { revision: this._revision, updatedAt: this._updatedAt, accounts: this._accounts };
    try {
      this._writing = true;
      safeWriteJsonSync(this._filePath, envelope);
      setTimeout(() => { this._writing = false; }, 200);
    } catch (e) {
      this._writing = false;
      console.error('AccountManager save error:', e);
    }
    // Backup paths: write ONLY persistent fields, ONLY when they changed.
    // This prevents 3x disk I/O on every quota refresh while preserving uninstall safety.
    let backupCount = 0;
    if (wasDirty) {
      const filtered = this._accounts.map(_extractPersistent);
      for (const pp of this._persistentPaths) {
        try {
          safeWriteJsonSync(pp, filtered);
          backupCount++;
        } catch (e) {
          console.warn(`WAM: [PERSIST] write failed ${pp}: ${e.message}`);
        }
      }
      // Drain discovered (legacy) paths once, then forget — avoid permanent fan-out writes.
      // After first write the data is saved to up-to-date locations, legacy paths can stop syncing.
      for (const dp of this._discoveredPaths) {
        try { safeWriteJsonSync(dp, filtered); backupCount++; } catch {}
      }
      this._discoveredPaths = [];
      this._persistentDirty = false;
    }
    // Lightweight telemetry — visible in log so optimization is observable
    if (wasDirty) {
      console.log(`WAM: [存储] 主+${backupCount}备份 (关键字段变更, ${this._accounts.length}账号)`);
    } else {
      console.log(`WAM: [存储] 仅主 (运行时缓存, ${this._accounts.length}账号)`);
    }
  }

  /** Start watching for external changes (other Windsurf windows) */
  startWatching() {
    if (this._watcher || !this._filePath) return;
    try {
      if (!fs.existsSync(this._filePath)) {
        safeWriteJsonSync(this._filePath, { revision: 0, updatedAt: '', accounts: [] });
      }
      let watchDebounce = null;
      this._watcher = fs.watch(this._filePath, { persistent: false }, (eventType) => {
        if (eventType === 'change' && !this._writing) {
          // Debounce rapid fs events (OS often fires multiple for one write)
          if (watchDebounce) clearTimeout(watchDebounce);
          watchDebounce = setTimeout(() => {
            watchDebounce = null;
            // Use revision-aware revalidation instead of full reload
            const reloaded = this._revalidateBeforeWrite();
            if (reloaded) {
              console.log(`WAM: [监听] 其他窗口修改了账号数据, 已合并 (revision=${this._revision})`);
            }
          }, 150);
        }
      });
    } catch {}
  }

  stopWatching() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
  }

  onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter(listener => listener !== fn);
    };
  }
  _notify() {
    const fingerprint = this._getNotifyFingerprint();
    if (fingerprint === this._lastNotifyFingerprint) return;
    this._lastNotifyFingerprint = fingerprint;
    // Snapshot listeners so unsubscribing during notification cannot skip later listeners.
    for (const fn of [...this._listeners]) {
      try { fn(this._accounts); } catch {}
    }
  }

  _getNotifyFingerprint() {
    return JSON.stringify(this._accounts.map(a => ({
      email: a.email,
      password: a.password,
      credits: a.credits,
      loginCount: a.loginCount || 0,
      addedAt: a.addedAt || null,
      rateLimit: a.rateLimit || null,
      authError: a.authError || null,
      fingerprint: a.fingerprint || null,
      usage: a.usage ? { ...a.usage, lastChecked: undefined } : null,
    })));
  }

  // ========== CRUD ==========

  getAll() { return [...this._accounts]; }
  count() { return this._accounts.length; }

  get(index) {
    return index >= 0 && index < this._accounts.length ? { ...this._accounts[index] } : null;
  }

  findByEmail(email) {
    const needle = email ? String(email).trim().toLowerCase() : '';
    const idx = needle ? this._accounts.findIndex(a => a.email && a.email.trim().toLowerCase() === needle) : -1;
    return idx >= 0 ? { index: idx, account: { ...this._accounts[idx] } } : null;
  }

  add(email, password) {
    if (!email || !password || !email.includes('@')) return false;
    if (this.findByEmail(email)) return false;
    this._accounts.push({ email, password, credits: undefined, loginCount: 0, addedAt: Date.now() });
    this._markPersistent();
    this._save();
    this._notify();
    return true;
  }

  remove(index) {
    if (index < 0 || index >= this._accounts.length) return false;
    this._accounts.splice(index, 1);
    this._markPersistent();
    this._save();
    this._notify();
    return true;
  }

  updateCredits(index, credits) {
    if (index < 0 || index >= this._accounts.length) return;
    this._accounts[index].credits = credits;
    // Only sync credits→daily.remaining for credits-mode accounts (not quota-mode)
    // Quota daily.remaining is a percentage (0-100), credits is a raw count — mixing them corrupts data
    const u = this._accounts[index].usage;
    if (u && u.daily && u.mode !== 'quota') {
      u.daily.remaining = credits;
    }
    this._save();
    this._notify();
  }

  /** Update comprehensive usage info (v6.9: + planStart/planEnd/gracePeriod for official alignment)
   *  Monotonic guard: a stale local-cache write must not clobber a recent fresh real-time write. */
  updateUsage(index, usageInfo) {
    if (index < 0 || index >= this._accounts.length || !usageInfo) return;
    const a = this._accounts[index];
    if (!shouldAcceptUsageWrite(a.usage, usageInfo)) return;
    const previousFingerprint = this._getUsageFingerprint(a.usage);
    const previousCredits = a.credits;
    const hadAuthError = !!a.authError;
    const now = Date.now();
    const nextUsage = {
      mode: usageInfo.mode || 'unknown',
      billingStrategy: usageInfo.billingStrategy || null,
      daily: usageInfo.daily || null,
      weekly: usageInfo.weekly || null,
      plan: usageInfo.plan || null,
      resetTime: usageInfo.resetTime || null,
      weeklyReset: usageInfo.weeklyReset || null,
      extraBalance: usageInfo.extraBalance || null,
      planStart: usageInfo.planStart || a.usage?.planStart || null,
      planEnd: usageInfo.planEnd || a.usage?.planEnd || null,
      source: usageInfo.source || a.usage?.source || 'unknown',
      fetchedAt: now,
      lastChecked: now,
    };
    if (a.authError) {
      delete a.authError;
    }
    // v7.4: Estimate planEnd for Trial accounts if only planStart is known
    if (!nextUsage.planEnd && nextUsage.planStart && nextUsage.plan) {
      const planName = (nextUsage.plan || '').toLowerCase();
      if (planName.includes('trial') || planName === 'free') {
        nextUsage.planEnd = nextUsage.planStart + (14 * 24 * 3600 * 1000); // 14-day trial
      }
    }
    // skipUntil: when depleted, skip network refresh until reset time (borrowed from windsurf-pool)
    const effRem = (() => {
      if (nextUsage.mode === 'quota') {
        const dd = nextUsage.daily?.remaining;
        const ww = nextUsage.weekly?.remaining;
        const hasD = dd !== null && dd !== undefined;
        const hasW = ww !== null && ww !== undefined;
        if (hasD && hasW) return Math.min(dd, ww);
        if (hasD) return dd;
        if (hasW) return ww;
      }
      return usageInfo.credits ?? null;
    })();
    if (effRem !== null && effRem <= 0) {
      const dr = nextUsage.resetTime;
      const wr = nextUsage.weeklyReset;
      const resetMs = (dr && wr) ? Math.min(dr, wr) : (dr || wr || null);
      if (resetMs && resetMs > Date.now()) {
        nextUsage.skipUntil = resetMs;
      }
    } else {
      delete nextUsage.skipUntil;
    }
    a.usage = nextUsage;
    // Keep legacy credits field in sync
    if (usageInfo.credits !== null && usageInfo.credits !== undefined) {
      a.credits = usageInfo.credits;
    }
    const nextFingerprint = this._getUsageFingerprint(a.usage);
    if (previousFingerprint === nextFingerprint && previousCredits === a.credits && !hadAuthError) {
      return;
    }
    this._save();
    this._notify();
  }

  _getUsageFingerprint(usage) {
    return JSON.stringify(usage ? { ...usage, lastChecked: undefined, fetchedAt: undefined, skipUntil: undefined } : null);
  }

  /** Check if an account should skip network refresh (depleted, waiting for reset) */
  shouldSkipRefresh(index) {
    const a = this.get(index);
    if (!a?.usage?.skipUntil) return false;
    return Date.now() < a.usage.skipUntil;
  }

  /**
   * Get effective remaining "capacity" for an account (unified metric).
   * Quota mode: min(daily, weekly) — matches official Windsurf vpe formula.
   *   Official: vpe = Z => Math.min(Z.dailyQuotaRemainingPercent, Z.weeklyQuotaRemainingPercent)
   * Credits mode: credits remaining.
   * Returns number or null if unknown.
   */
  effectiveRemaining(index) {
    const a = this.get(index);
    if (!a) return null;
    if (a.usage && a.usage.mode === 'quota') {
      const d = a.usage.daily?.remaining;
      const w = a.usage.weekly?.remaining;
      const hasD = d !== null && d !== undefined;
      const hasW = w !== null && w !== undefined;
      if (hasD && hasW) return Math.min(d, w);
      // v21.0: quota mode — one dimension missing means the other is abnormal/degraded.
      // Treat as depleted to exclude from auto-scheduling (conservative safety).
      if (hasD) return 0;
      if (hasW) return 0;
    }
    return a.credits !== undefined ? a.credits : null;
  }

  /** Get daily remaining % for quota-mode accounts, null otherwise */
  getDailyRemaining(index) {
    const a = this.get(index);
    if (!a || !a.usage || a.usage.mode !== 'quota') return null;
    const d = a.usage.daily?.remaining;
    if (d !== null && d !== undefined) return d;
    // Proto3 fix: daily missing but weekly present → daily is 0% (depleted)
    const w = a.usage.weekly?.remaining;
    if (w !== null && w !== undefined) return 0;
    return null;
  }

  /**
   * Get effective reset time for an account (matches official ype formula).
   * Official logic:
   *   Both exhausted: max(dailyReset, weeklyReset) — take the later one
   *   Weekly more restrictive (weekly < daily): weeklyReset
   *   Daily more restrictive: dailyReset
   * Returns timestamp (ms) or null.
   */
  effectiveResetTime(index) {
    const a = this.get(index);
    if (!a || !a.usage) return null;
    const d = a.usage.daily?.remaining;
    const w = a.usage.weekly?.remaining;
    const dr = a.usage.resetTime;    // daily reset (ms)
    const wr = a.usage.weeklyReset;  // weekly reset (ms)
    if (d === null || d === undefined || w === null || w === undefined) return dr || wr || null;
    if (d <= 0 && w <= 0) return (dr && wr) ? Math.max(dr, wr) : (dr || wr || null);
    if (w < d) return wr || dr || null;
    return dr || wr || null;
  }

  /** Get normalized scheduling mode for account selection */
  getSelectionMode(index) {
    const a = this.get(index);
    if (!a) return 'unknown';
    const usage = a.usage || {};
    if (
      usage.billingStrategy === 'quota' ||
      usage.mode === 'quota' ||
      usage.daily ||
      usage.weekly
    ) {
      return 'quota';
    }
    if (
      usage.billingStrategy === 'credits' ||
      usage.mode === 'credits' ||
      a.credits !== undefined
    ) {
      return 'credits';
    }
    return 'unknown';
  }

  /** Get detected usage mode across all accounts ('quota'|'credits'|'mixed'|'unknown') */
  getDetectedMode() {
    const modes = this._accounts
      .filter(a => a.usage && a.usage.mode !== 'unknown')
      .map(a => a.usage.mode);
    if (modes.length === 0) return 'unknown';
    const unique = [...new Set(modes)];
    return unique.length === 1 ? unique[0] : 'mixed';
  }

  incrementLoginCount(index) {
    if (index < 0 || index >= this._accounts.length) return;
    this._accounts[index].loginCount = (this._accounts[index].loginCount || 0) + 1;
    this._markPersistent();
    this._save();
  }

  // ========== Per-Account Fingerprint (v18.0: 防封控) ==========

  /** 获取账号绑定的设备指纹 (无则返回 null) */
  getFingerprint(index) {
    if (index < 0 || index >= this._accounts.length) return null;
    return this._accounts[index].fingerprint || null;
  }

  markAuthError(index, type, message) {
    if (index < 0 || index >= this._accounts.length) return;
    this._accounts[index].authError = {
      type: type || 'auth_failed',
      message: message || null,
      at: Date.now(),
    };
    this._save();
    this._notify();
  }

  clearAuthError(index) {
    if (index < 0 || index >= this._accounts.length) return;
    if (!this._accounts[index].authError) return;
    delete this._accounts[index].authError;
    this._save();
    this._notify();
  }

  /** v20.4: 批量清除指定类型的 authError (用于 transient 错误的批量恢复)
   *  返回清除的账号数 */
  clearAuthErrorByType(errorType) {
    let cleared = 0;
    for (const a of this._accounts) {
      if (a.authError && a.authError.type === errorType) {
        delete a.authError;
        cleared++;
      }
    }
    if (cleared > 0) {
      this._save();
      this._notify();
    }
    return cleared;
  }

  isInvalidAuth(index) {
    const a = this.get(index);
    return a?.authError?.type === 'invalid_credentials';
  }

  // why: switch failures may be transient (Firebase/proxy/network) — accumulate
  // count rather than mark on first failure so UI can show severity tier
  markSwitchFailure(index, reason) {
    if (index < 0 || index >= this._accounts.length) return;
    const a = this._accounts[index];
    const prev = a.authError && a.authError.type === 'switch_failed' ? a.authError : null;
    const count = (prev?.count || 0) + 1;
    a.authError = {
      type: 'switch_failed',
      message: reason || 'unknown',
      count,
      at: Date.now(),
      firstAt: prev?.firstAt || Date.now(),
    };
    this._save();
    this._notify();
    return count;
  }

  clearSwitchFailure(index) {
    if (index < 0 || index >= this._accounts.length) return;
    const a = this._accounts[index];
    if (a.authError?.type === 'switch_failed') {
      delete a.authError;
      this._save();
      this._notify();
    }
  }

  isAbnormal(index) {
    const a = this.get(index);
    return !!a?.authError;
  }

  // ========== Persisted apiKey (v23.0: GetUserStatus fast-path) ==========

  /** Persist long-lived apiKey/sessionToken. source: 'register_user' | 'devin_auth' | 'manual' */
  setApiKey(index, apiKey, source = 'unknown') {
    if (index < 0 || index >= this._accounts.length || !apiKey) return;
    const a = this._accounts[index];
    if (a.apiKey === apiKey && a.apiKeySource === source) return; // no-op
    a.apiKey = apiKey;
    a.apiKeyAt = Date.now();
    a.apiKeySource = source;
    this._markPersistent();
    this._save();
  }

  /** Drop apiKey when GetUserStatus returns 401/403 (key expired/revoked). */
  clearApiKey(index) {
    if (index < 0 || index >= this._accounts.length) return;
    const a = this._accounts[index];
    if (!a.apiKey) return;
    delete a.apiKey;
    delete a.apiKeyAt;
    delete a.apiKeySource;
    this._markPersistent();
    this._save();
  }

  getApiKey(index) {
    const a = this.get(index);
    if (!a?.apiKey) return null;
    return { apiKey: a.apiKey, source: a.apiKeySource || 'unknown', at: a.apiKeyAt || 0 };
  }

  /** 保存设备指纹到账号 (持久化) */
  setFingerprint(index, ids) {
    if (index < 0 || index >= this._accounts.length || !ids) return;
    this._accounts[index].fingerprint = ids;
    this._markPersistent();
    this._save();
  }

  /** Smart batch add — auto-detect ANY seller format
   *  Supports: email----pass | email:pass | email pass | 卡号/卡密 pairs | 账号/密码 pairs
   *  Returns: { added, skipped, errors, total, accounts: [{email, password}] } */
  addBatch(text) {
    const pairs = AccountManager.parseAccounts(text);
    let added = 0, skipped = 0;
    const addedAccounts = [];
    const existingEmails = new Set(this._accounts.map(a => a.email?.toLowerCase()));
    for (const {email, password} of pairs) {
      if (existingEmails.has(email.toLowerCase())) { skipped++; continue; }
      existingEmails.add(email.toLowerCase());
      this._accounts.push({ email, password, credits: undefined, loginCount: 0, addedAt: Date.now() });
      addedAccounts.push({email, password});
      added++;
    }
    if (added > 0) { this._markPersistent(); this._save(); this._notify(); }
    return { added, skipped, errors: 0, total: pairs.length, accounts: addedAccounts };
  }

  /** Universal account format parser (static, testable)
   *  Handles: email----pass | email:pass | email pass
   *  Chinese label pairs: 卡号N: email + 卡密N: pass | 账号: email + 密码: pass
   *  Raw paste from any seller: auto-finds email+password pairs */
  static parseAccounts(text) {
    return parseAccounts(text);
  }

  /** Export all accounts for sync (preserves all fields) */
  exportAll() {
    return this._accounts.map(a => ({
      email: a.email, password: a.password, credits: a.credits,
      loginCount: a.loginCount || 0, addedAt: a.addedAt || Date.now(),
      rateLimit: a.rateLimit || null,
      authError: a.authError || null,
      usage: a.usage || null,
      fingerprint: a.fingerprint || null,
      apiKey: a.apiKey || null,
      apiKeyAt: a.apiKeyAt || null,
      apiKeySource: a.apiKeySource || null,
    }));
  }

  /** Export to local file and return file path */
  exportToFile(storagePath) {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: this._accounts.length,
      accounts: this.exportAll()
    };
    const fname = `wam-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    const fpath = path.join(storagePath || path.dirname(this._filePath || ''), fname);
    safeWriteJsonSync(fpath, data);
    return fpath;
  }

  /** Import from backup JSON (merge strategy) */
  importFromFile(filePath) {
    const data = safeReadJsonSync(filePath, null);
    if (!data) throw new Error('invalid backup json');
    const accounts = data.accounts || data; // support both wrapped and raw array
    return this.merge(Array.isArray(accounts) ? accounts : []);
  }

  /** Merge external accounts into local pool
   *  - New emails: add
   *  - Existing emails: update credits/password if remote is fresher
   *  Returns: { added, updated, unchanged, total } */
  merge(externalAccounts) {
    if (!Array.isArray(externalAccounts)) return { added: 0, updated: 0, unchanged: 0, total: this._accounts.length };
    let added = 0, updated = 0, unchanged = 0;
    for (const ext of externalAccounts) {
      if (!ext.email || !ext.password) { unchanged++; continue; }
      const extLower = ext.email.toLowerCase();
      const idx = this._accounts.findIndex(a => a.email && a.email.toLowerCase() === extLower);
      if (idx < 0) {
        const newAccount = {
          email: ext.email, password: ext.password, credits: ext.credits,
          loginCount: ext.loginCount || 0, addedAt: ext.addedAt || Date.now()
        };
        if (ext.rateLimit && ext.rateLimit.until > Date.now()) {
          newAccount.rateLimit = ext.rateLimit;
          this._rateLimits.set(ext.email, ext.rateLimit);
        }
        if (ext.authError) newAccount.authError = ext.authError;
        if (ext.apiKey) {
          newAccount.apiKey = ext.apiKey;
          newAccount.apiKeyAt = ext.apiKeyAt || Date.now();
          newAccount.apiKeySource = ext.apiKeySource || 'imported';
        }
        this._accounts.push(newAccount);
        added++;
      } else {
        const local = this._accounts[idx];
        let changed = false;
        // Update credits if remote has fresher data
        const extChecked = ext.usage?.lastChecked || ext.lastChecked || 0;
        const localChecked = local.usage?.lastChecked || local.lastChecked || 0;
        if (ext.credits !== undefined && extChecked > localChecked) {
          local.credits = ext.credits;
          changed = true;
        }
        // Update password if remote has one and it differs
        if (ext.password && ext.password !== local.password) {
          local.password = ext.password;
          // v22.3: password changed — clear authError so account is re-verified on next scan
          if (local.authError) {
            delete local.authError;
          }
          // v23.0: apiKey was bound to the OLD password, drop it
          if (local.apiKey) {
            delete local.apiKey;
            delete local.apiKeyAt;
            delete local.apiKeySource;
          }
          changed = true;
        }
        // v23.0: sync apiKey if remote has fresher one
        if (ext.apiKey && (!local.apiKey || (ext.apiKeyAt || 0) > (local.apiKeyAt || 0))) {
          local.apiKey = ext.apiKey;
          local.apiKeyAt = ext.apiKeyAt || Date.now();
          local.apiKeySource = ext.apiKeySource || 'sync';
          changed = true;
        }
        // Sync rate limit state (remote RL always wins if still active)
        if (ext.rateLimit && ext.rateLimit.until > Date.now() && !local.rateLimit) {
          local.rateLimit = ext.rateLimit;
          this._rateLimits.set(local.email, ext.rateLimit);
          changed = true;
        }
        if (ext.authError && !local.authError) {
          local.authError = ext.authError;
          changed = true;
        }
        // Sync usage/quota state (fresher data wins)
        if (ext.usage && ext.usage.lastChecked > (local.usage?.lastChecked || 0)) {
          local.usage = ext.usage;
          changed = true;
        }
        if (changed) updated++; else unchanged++;
      }
    }
    if (added > 0 || updated > 0) { this._markPersistent(); this._save(); this._notify(); }
    return { added, updated, unchanged, total: this._accounts.length };
  }

  // ========== 均匀消耗追踪 (v12.0: Round-Robin) ==========

  /** 标记账号被使用(切换到该账号时调用) */
  markUsed(index) {
    this._lastUsedTs.set(index, Date.now());
  }

  /** 获取账号上次使用时间 (未使用过返回0) */
  getLastUsedTs(index) {
    return this._lastUsedTs.get(index) || 0;
  }

  // ========== Rate Limit State Tracking (v6.4: 动态冷却 + 提前恢复) ==========

  /** Mark an account as rate-limited with cooldown
   *  v6.4: cooldown根据type动态计算:
   *    message_rate: 60-90s (服务端通常1-2min恢复, 旧值1800s严重浪费号池)
   *    quota: 3600s (需等日重置)
   *    unknown: 使用传入值 */
  markRateLimited(index, resetsInSeconds = 3600, info = {}) {
    const a = this.get(index);
    if (!a) return;
    // v12.0: 指数退避 — 无服务端精确reset时间时，连续命中递增冷却
    // 有服务端时间(info.serverReset)直接用; 否则 base * 2^(hitCount-1), 上限3600s
    const hitCount = (this._rateLimitHitCount.get(a.email) || 0) + 1;
    this._rateLimitHitCount.set(a.email, hitCount);
    let effectiveCooldown = resetsInSeconds;
    if (!info.serverReset && hitCount > 1) {
      effectiveCooldown = Math.min(3600, resetsInSeconds * Math.pow(2, hitCount - 1));
    }
    const until = Date.now() + (effectiveCooldown * 1000);
    this._rateLimits.set(a.email, {
      until,
      resetsIn: effectiveCooldown,
      type: info.type || 'unknown',
      model: info.model || null,
      trigger: info.trigger || null,
      maxMessages: info.maxMessages || null,
      messagesRemaining: info.messagesRemaining || 0,
      hitAt: Date.now(),
      hitCount,
    });
    // Also store in account for persistence
    if (index >= 0 && index < this._accounts.length) {
      this._accounts[index].rateLimit = { until, resetsIn: resetsInSeconds, type: info.type || 'unknown', model: info.model || null };
      this._save();
    }
    console.log(`WAM: [限流] #${index+1} ${a.email.split('@')[0]} 已标记限流 ${resetsInSeconds}s (类型=${info.type || '?'}, 触发=${info.trigger || '?'})`);
    this._notify();
  }

  /** Check if an account is currently rate-limited
   *  v6.8: 提前恢复探测改进 — 适配1200s默认冷却
   *    - message_rate: 已过25%冷却期(min 60s)且额度>0 → 提前解锁
   *    - quota: 不支持提前恢复(必须等日重置) */
  isRateLimited(index) {
    const a = this.get(index);
    if (!a) return false;
    return this._isRateLimitActive(index, this._getRateLimitEntry(a));
  }

  _getRateLimitEntry(account) {
    const memory = this._rateLimits.get(account.email);
    const persisted = account.rateLimit || null;
    if (memory && persisted && persisted.until > memory.until) return persisted;
    return memory || persisted;
  }

  _isRateLimitActive(index, rl) {
    if (!rl || rl.until <= Date.now()) return false;
    return !this._isRateLimitRecoverable(index, rl);
  }

  _isRateLimitRecoverable(index, rl) {
    if (rl.type !== 'message_rate') return false;
    const totalCooldown = (rl.resetsIn || 1200) * 1000;
    const elapsed = rl.hitAt
      ? Date.now() - rl.hitAt
      : totalCooldown - (rl.until - Date.now());
    const minRecoveryMs = Math.max(60000, totalCooldown * 0.25);
    if (elapsed < minRecoveryMs) return false;
    const rem = this.effectiveRemaining(index);
    return rem !== null && rem > 0;
  }

  /** Clear expired/recoverable rate-limit records outside read paths. */
  sweepExpiredRateLimits() {
    let changed = false;
    let shouldSave = false;
    for (let i = 0; i < this._accounts.length; i++) {
      const a = this._accounts[i];
      const memory = this._rateLimits.get(a.email);
      if (memory && !this._isRateLimitActive(i, memory)) {
        this._rateLimits.delete(a.email);
        changed = true;
      }
      if (a.rateLimit && !this._isRateLimitActive(i, a.rateLimit)) {
        delete a.rateLimit;
        changed = true;
        shouldSave = true;
      }
    }
    if (!changed) return { changed: false, saved: false };
    if (shouldSave) this._save();
    this._notify();
    return { changed: true, saved: shouldSave };
  }

  /** Get rate limit info for an account */
  getRateLimitInfo(index) {
    const a = this.get(index);
    if (!a) return null;
    const rl = this._getRateLimitEntry(a);
    if (!this._isRateLimitActive(index, rl)) return null;
    return { ...rl, remainingCooldown: Math.ceil((rl.until - Date.now()) / 1000) };
  }

  /** Clear rate limit for an account */
  clearRateLimit(index) {
    const a = this.get(index);
    if (!a) return;
    this._rateLimits.delete(a.email);
    this._rateLimitHitCount.delete(a.email); // v12.0: 恢复后重置退避计数
    if (index >= 0 && index < this._accounts.length) {
      delete this._accounts[index].rateLimit;
      this._save();
    }
  }

  // ========== Per-Model Rate Limit Tracking (v7.2: per-(account,modelUid) bucket) ==========

  /** Mark a specific model as rate-limited on a specific account */
  markModelRateLimited(index, modelUid, resetsInSeconds = 600, info = {}) {
    const a = this.get(index);
    if (!a || !modelUid) return;
    const key = `${a.email}|${modelUid}`;
    this._modelRateLimits.set(key, {
      until: Date.now() + (resetsInSeconds * 1000),
      resetsIn: resetsInSeconds,
      hitAt: Date.now(),
      modelUid,
      trigger: info.trigger || null,
    });
    console.log(`WAM: [模型限流] #${index+1} ${a.email.split('@')[0]} 模型${modelUid} 已标记限流 ${resetsInSeconds}s`);
  }

  /** Check if a specific model is rate-limited on a specific account */
  isModelRateLimited(index, modelUid) {
    const a = this.get(index);
    if (!a || !modelUid) return false;
    const key = `${a.email}|${modelUid}`;
    const rl = this._modelRateLimits.get(key);
    if (!rl) return false;
    if (rl.until <= Date.now()) {
      this._modelRateLimits.delete(key);
      return false;
    }
    return true;
  }

  /** Clear model rate limit for a specific account+model (v13.1: 降级后清理) */
  clearModelRateLimit(index, modelUid) {
    const a = this.get(index);
    if (!a || !modelUid) return;
    const key = `${a.email}|${modelUid}`;
    this._modelRateLimits.delete(key);
  }

  /** Find first non-rate-limited model variant for an account from a list of UIDs */
  findAvailableModelVariant(index, modelUids) {
    if (!Array.isArray(modelUids) || modelUids.length === 0) return null;
    for (const uid of modelUids) {
      if (!this.isModelRateLimited(index, uid)) return uid;
    }
    return null; // all variants limited on this account
  }

  /** Find ordered candidates for a specific modelUid while preserving pool strategy */
  findBestForModel(modelUid, excludeIndex = -1, threshold = 0, excludeEmails = [], options = {}) {
    return findBestForModelWithSelector(
      this,
      modelUid,
      excludeIndex,
      threshold,
      excludeEmails,
      options,
    );
  }

  /** Get all model rate limit entries (for diagnostics) */
  getModelRateLimits() {
    const result = [];
    for (const [key, rl] of this._modelRateLimits) {
      if (rl.until > Date.now()) {
        result.push({ key, ...rl, remainingCooldown: Math.ceil((rl.until - Date.now()) / 1000) });
      }
    }
    return result;
  }

  /** Get count of currently rate-limited accounts */
  rateLimitedCount() {
    let count = 0;
    for (let i = 0; i < this._accounts.length; i++) {
      if (this.isRateLimited(i)) count++;
    }
    return count;
  }

  /** Check if ALL accounts are depleted (credits <= threshold) — legacy */
  allDepleted(threshold = 0) {
    if (this._accounts.length === 0) return true;
    return this._accounts.every((a, i) => {
      const rem = this.effectiveRemaining(i);
      return rem !== undefined && rem !== null && rem <= threshold;
    });
  }

  // ========== POOL AGGREGATION (v6.0 号池引擎) ==========

  /** Get unified pool statistics — single call for dashboard/status bar */
  getPoolStats(threshold = 5) {
    const n = this._accounts.length;
    let available = 0, depleted = 0, rateLimited = 0, unknown = 0, invalid = 0;
    let sumRemaining = 0, best = -Infinity, worst = Infinity;
    let nextReset = Infinity, nextWeeklyReset = Infinity;
    // v6.6: Aggregate D/W stats across ALL accounts (not just active)
    let sumDaily = 0, sumWeekly = 0, dailyCount = 0, weeklyCount = 0;
    let sumCredits = 0, creditsCount = 0;
    // Effective pool metrics (本源: effective = min(D,W) = 真实可用容量)
    let sumEffective = 0, effectiveCount = 0;
    let weeklyBottleneckCount = 0; // accounts where W < D (weekly is the binding constraint)
    let preResetWasteCount = 0, preResetWasteTotal = 0; // accounts with high remaining near reset

    for (let i = 0; i < n; i++) {
      const a = this._accounts[i];
      const rem = this.effectiveRemaining(i);
      const isInvalid = this.isInvalidAuth(i);
      const isRL = this.isRateLimited(i);
      if (isInvalid) { invalid++; }
      else if (isRL) { rateLimited++; }
      else if (rem === null || rem === undefined) { unknown++; }
      else if (rem <= threshold) { depleted++; }
      else { available++; }

      // v21.0: only aggregate D/W/credits for AVAILABLE accounts — depleted accounts
      // (weekly≤threshold, weekly=null) should not inflate pool daily/weekly averages.
      const isAvailable = !isInvalid && !isRL && rem !== null && rem !== undefined && rem > threshold;
      if (isAvailable) {
        if (a.usage && a.usage.mode === 'quota') {
          const d = a.usage.daily?.remaining;
          const w = a.usage.weekly?.remaining;
          if (d !== null && d !== undefined) { sumDaily += d; dailyCount++; }
          if (w !== null && w !== undefined) { sumWeekly += w; weeklyCount++; }
        } else if (a.credits !== undefined && a.credits !== null) {
          sumCredits += a.credits; creditsCount++;
        }
      }

      if (rem !== null && rem !== undefined && !isRL) {
        if (rem > threshold) sumRemaining += rem;
        if (rem > best) best = rem;
        if (rem < worst) worst = rem;
      }
      const effReset = this.effectiveResetTime(i);
      if (effReset && effReset > Date.now() && effReset < nextReset) nextReset = effReset;
      const u = a.usage;
      if (u?.weeklyReset && u.weeklyReset > Date.now() && u.weeklyReset < nextWeeklyReset) nextWeeklyReset = u.weeklyReset;

      // Effective capacity (min(D,W) per account — the TRUE usable quota)
      if (isAvailable) {
        sumEffective += rem;
        effectiveCount++;
      }
      // Weekly bottleneck detection (W < D means weekly is the binding constraint)
      if (isAvailable && a.usage && a.usage.mode === 'quota') {
        const dd = a.usage.daily?.remaining;
        const ww = a.usage.weekly?.remaining;
        if (dd !== null && dd !== undefined && ww !== null && ww !== undefined && ww < dd) {
          weeklyBottleneckCount++;
        }
      }
      // Pre-reset waste detection (high remaining + weekly reset within 24h = quota will be wasted)
      if (isAvailable && rem > 30) {
        const wr = a.usage?.weeklyReset;
        if (wr && wr > Date.now() && (wr - Date.now()) < 86400000) {
          preResetWasteCount++;
          preResetWasteTotal += rem;
        }
      }
    }

    // v7.4: Expiry distribution (UFEF awareness) + nearest plan expiry
    let expired = 0, nearestPlanEnd = Infinity;
    let urgentCount = 0, soonCount = 0, safeCount = 0, unknownExpiryCount = 0;
    for (let i = 0; i < n; i++) {
      const urg = this.getExpiryUrgency(i);
      if (urg === 3) expired++;
      else if (urg === 0) urgentCount++;
      else if (urg === 1) soonCount++;
      else if (urg === 2) safeCount++;
      else unknownExpiryCount++;
      const pe = this._accounts[i].usage?.planEnd;
      if (pe && pe > Date.now() && pe < nearestPlanEnd) nearestPlanEnd = pe;
    }

    return {
      total: n, available, depleted, rateLimited, invalid, unknown, expired, urgentCount, soonCount, safeCount, unknownExpiryCount,
      sumRemaining,
      bestRemaining: best === -Infinity ? 0 : best,
      worstRemaining: worst === Infinity ? 0 : worst,
      avgRemaining: available > 0 ? Math.round(sumRemaining / available) : 0,
      nextReset: nextReset === Infinity ? null : nextReset,
      nextWeeklyReset: nextWeeklyReset === Infinity ? null : nextWeeklyReset,
      nearestPlanEnd: nearestPlanEnd === Infinity ? null : nearestPlanEnd,
      health: n > 0 ? Math.round((available / n) * 100) : 0,
      mode: this.getDetectedMode(),
      sumDaily: dailyCount > 0 ? Math.round(sumDaily) : null,
      sumWeekly: weeklyCount > 0 ? Math.round(sumWeekly) : null,
      avgDaily: dailyCount > 0 ? Math.round(sumDaily / dailyCount) : null,
      avgWeekly: weeklyCount > 0 ? Math.round(sumWeekly / weeklyCount) : null,
      dailyCount, weeklyCount,
      sumCredits: creditsCount > 0 ? Math.round(sumCredits) : null,
      avgCredits: creditsCount > 0 ? Math.round(sumCredits / creditsCount) : null,
      creditsCount,
      // Effective pool metrics (本源推万法 — 从min(D,W)看真实容量)
      sumEffective: effectiveCount > 0 ? Math.round(sumEffective) : null,
      avgEffective: effectiveCount > 0 ? Math.round(sumEffective / effectiveCount) : null,
      effectiveCount,
      weeklyBottleneckCount, // accounts where W% < D% (weekly is binding)
      weeklyBottleneckRatio: effectiveCount > 0 ? +(weeklyBottleneckCount / effectiveCount * 100).toFixed(0) : 0,
      preResetWasteCount, // accounts with high remaining near weekly reset
      preResetWasteTotal: preResetWasteCount > 0 ? Math.round(preResetWasteTotal) : 0,
    };
  }

  /** Get active account quota snapshot for status bar (v6.9: + plan dates + countdowns) */
  getActiveQuota(index) {
    const a = this.get(index);
    if (!a) return null;
    const u = a.usage || {};
    const planDays = this.getPlanDaysRemaining(index);
    const resetCountdown = u.resetTime ? AccountManager.formatCountdown(u.resetTime) : null;
    const weeklyResetCountdown = u.weeklyReset ? AccountManager.formatCountdown(u.weeklyReset) : null;
    return {
      daily: u.daily?.remaining ?? null,
      weekly: u.weekly?.remaining ?? null,
      credits: a.credits ?? null,
      effective: this.effectiveRemaining(index),
      mode: u.mode || 'unknown',
      plan: u.plan || null,
      billingStrategy: u.billingStrategy || null,
      resetTime: this.effectiveResetTime(index),
      dailyResetRaw: u.resetTime || null,
      weeklyReset: u.weeklyReset || null,
      extraBalance: u.extraBalance || null,
      lastChecked: u.lastChecked || null,
      exhausted: this._isExhausted(index),
      expired: this.isExpired(index),
      planStart: u.planStart || null,
      planEnd: u.planEnd || null,
      planDays,
      resetCountdown,
      weeklyResetCountdown,
    };
  }

  /** Check if account is exhausted — official: daily≤0 OR weekly≤0 */
  _isExhausted(index) {
    const a = this.get(index);
    if (!a || !a.usage || a.usage.mode !== 'quota') return false;
    const d = a.usage.daily?.remaining;
    const w = a.usage.weekly?.remaining;
    return (d !== null && d !== undefined && d <= 0) || (w !== null && w !== undefined && w <= 0);
  }

  /** v6.9: Check if account's plan has expired (planEnd < now) */
  isExpired(index) {
    const a = this.get(index);
    if (!a || !a.usage) return false;
    const end = a.usage.planEnd;
    if (!end) return false;
    return end < Date.now();
  }

  /** v6.9: Get plan days remaining (null if unknown, negative if expired) */
  getPlanDaysRemaining(index) {
    const a = this.get(index);
    if (!a || !a.usage || !a.usage.planEnd) return null;
    return Math.ceil((a.usage.planEnd - Date.now()) / (24 * 3600 * 1000));
  }

  /** v7.4: Get expiry urgency tier for UFEF (Use-First-Expire-First) rotation
   *  0 = URGENT (≤3d), 1 = SOON (3-7d), 2 = SAFE (>7d), 3 = EXPIRED, -1 = UNKNOWN */
  getExpiryUrgency(index) {
    if (this.isExpired(index)) return 3;
    const days = this.getPlanDaysRemaining(index);
    if (days === null) return -1;
    if (days <= 3) return 0;
    if (days <= 7) return 1;
    return 2;
  }

  /** v7.4: Get plan summary for display */
  getPlanSummary(index) {
    const a = this.get(index);
    if (!a) return null;
    const u = a.usage || {};
    const days = this.getPlanDaysRemaining(index);
    const urgency = this.getExpiryUrgency(index);
    const urgencyLabels = { 0: '紧急', 1: '将到期', 2: '安全', 3: '已过期', [-1]: '未知' };
    return {
      plan: u.plan || null,
      billingStrategy: u.billingStrategy || null,
      days,
      urgency,
      urgencyLabel: urgencyLabels[urgency] || '未知',
      startDate: u.planStart ? new Date(u.planStart).toLocaleDateString() : null,
      endDate: u.planEnd ? new Date(u.planEnd).toLocaleDateString() : null,
      planStart: u.planStart || null,
      planEnd: u.planEnd || null,
    };
  }

  /** v6.9: Get countdown string for a timestamp (e.g. "2h30m" or "3d") */
  static formatCountdown(ts) {
    if (!ts) return null;
    const diff = ts - Date.now();
    if (diff <= 0) return '已过';
    const m = Math.floor(diff / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h${m % 60 > 0 ? (m % 60) + 'm' : ''}`;
    const d = Math.floor(h / 24);
    return `${d}d${h % 24 > 0 ? (h % 24) + 'h' : ''}`;
  }

  /** Select ordered candidates for seamless rotation with mixed-pool safety */
  selectOptimal(excludeIndex = -1, threshold = 5, excludeEmails = [], options = {}) {
    return selectOptimalWithSelector(
      this,
      excludeIndex,
      threshold,
      excludeEmails,
      options,
    );
  }

  /** Get switch recommendation with reason (v7.4: + expiry urgency awareness) */
  shouldSwitch(activeIndex, threshold = 5) {
    if (activeIndex < 0 || activeIndex >= this._accounts.length) return { switch: true, reason: 'no_active' };
    if (this.isInvalidAuth(activeIndex)) return { switch: true, reason: 'invalid_credentials' };
    if (this.isExpired(activeIndex)) return { switch: true, reason: 'expired' };
    const rem = this.effectiveRemaining(activeIndex);
    if (rem === null || rem === undefined) return { switch: false, reason: 'unknown' };
    if (rem <= 0) return { switch: true, reason: 'depleted' };
    if (rem <= threshold) return { switch: true, reason: 'low' };
    if (this.isRateLimited(activeIndex)) return { switch: true, reason: 'rate_limited' };
    // v12.0: UFEF逻辑移至extension.js T2-D统一管控(含10min冷却)，避免shouldSwitch每tick触发抖动
    return { switch: false, reason: 'ok', remaining: rem };
  }

  dispose() {
    this._flushSave();
    this.stopWatching();
    this._listeners = [];
    this._lastNotifyFingerprint = '';
  }
}

export { AccountManager };
