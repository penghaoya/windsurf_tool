/**
 * Fingerprint Manager — Windsurf设备指纹(机器码)管理
 * 
 * Windsurf通过6个ID识别设备:
 *   1. machineid文件 (UUID格式, %APPDATA%/Windsurf/machineid)
 *   2. storage.serviceMachineId (同machineid, in storage.json)
 *   3. telemetry.devDeviceId (UUID格式)
 *   4. telemetry.macMachineId (32位hex, 无短横)
 *   5. telemetry.machineId (32位hex, 无短横)
 *   6. telemetry.sqmId (32位hex, 无短横)
 * 
 * 重置这些ID → Windsurf视为全新设备 → 解除Rate limit绑定
 * 零外部依赖，纯Node.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { dbReadKeys } from '../infra/sqlite.js';

const TELEMETRY_KEYS = [
  'storage.serviceMachineId',
  'telemetry.devDeviceId',
  'telemetry.macMachineId',
  'telemetry.machineId',
  'telemetry.sqmId',
];

// v23.5: HTTP profile pools — used by auth.js for per-account login headers.
// Stored as 3 seed values (os/chromeVersion/acceptLanguage); dependent fields
// (sec-ch-ua, sec-ch-ua-platform, major version) are derived from these seeds
// so headers are strictly internally consistent (no Mac+Windows ch-ua mismatch).
const _HTTP_OS = [
  'Windows NT 10.0; Win64; x64',
  'Macintosh; Intel Mac OS X 10_15_7',
  'Macintosh; Intel Mac OS X 13_4_1',
  'Macintosh; Intel Mac OS X 14_2_1',
  'X11; Linux x86_64',
];
const _HTTP_CHROME = ['125.0.0.0', '126.0.0.0', '128.0.0.0', '130.0.0.0', '132.0.0.0', '134.0.0.0', '140.0.0.0'];
const _HTTP_LANG = ['en-US,en;q=0.9', 'zh-CN,zh;q=0.9,en;q=0.8', 'ja,en-US;q=0.9,en;q=0.8'];

function _uuid() { return crypto.randomUUID(); }
function _hex32() { return crypto.randomBytes(16).toString('hex'); }
function _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/** v23.5: Generate HTTP profile seeds for per-account binding.
 *  Three seed values; full request headers derived deterministically via
 *  httpProfileToHeaders() so dependent fields stay internally consistent. */
function generateHttpProfile() {
  return {
    os: _pick(_HTTP_OS),
    chromeVersion: _pick(_HTTP_CHROME),
    acceptLanguage: _pick(_HTTP_LANG),
  };
}

/** v23.5: Derive request headers from a stored HTTP profile (or generate if
 *  none provided). Same profile in → same headers out; sec-ch-ua-platform
 *  always agrees with the OS string, etc. */
function httpProfileToHeaders(profile) {
  const p = profile || generateHttpProfile();
  const major = String(p.chromeVersion || '').split('.')[0] || '140';
  const platform = p.os && p.os.includes('Windows') ? '"Windows"'
    : p.os && p.os.includes('Mac') ? '"macOS"' : '"Linux"';
  return {
    'User-Agent': `Mozilla/5.0 (${p.os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${p.chromeVersion} Safari/537.36`,
    'Accept-Language': p.acceptLanguage,
    'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not-A.Brand";v="99"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': platform,
  };
}

/** Generate a new fingerprint set (without applying to disk)
 *  v18.0: 用于 per-account 指纹绑定 — 生成后保存到账号数据
 *  v23.5: 同时生成 HTTP profile, 让单账号的硬件 ID + 浏览器/OS/语言一致绑定 */
function generateFingerprint() {
  const machineId = _uuid();
  return {
    'machineid': machineId,
    'storage.serviceMachineId': machineId,
    'telemetry.devDeviceId': _uuid(),
    'telemetry.macMachineId': _hex32(),
    'telemetry.machineId': _hex32(),
    'telemetry.sqmId': _hex32(),
    http: generateHttpProfile(),
    createdAt: Date.now(),
  };
}

/** Apply a pre-generated fingerprint to machineid file + storage.json (atomic write)
 *  v18.0: 不更新 state.vscdb (调用方通过 dbUpdateKeys 单独处理)
 *  v20.2 (方案B): 幂等化 — 写入前对比现状，完全一致时跳过所有写入。
 *                 防封控关键: 同一指纹反复重写 machineid 是反作弊系统的异常特征，
 *                 改为"每个账号的指纹只在首次绑定时写一次"。
 *  返回 skipped=true 表示磁盘上已是目标状态，调用方应同时跳过 state.vscdb 同步。 */
function applyFingerprint(ids) {
  if (!ids) return { ok: false, error: 'no ids' };
  const paths = getFingerPrintPaths();
  try {
    // 1. 检查 machineid 文件是否已是目标值
    let machineidNeedsWrite = false;
    if (ids.machineid && fs.existsSync(path.dirname(paths.machineid))) {
      let currentMachineId = '';
      try {
        if (fs.existsSync(paths.machineid)) {
          currentMachineId = fs.readFileSync(paths.machineid, 'utf8').trim();
        }
      } catch {}
      if (currentMachineId !== ids.machineid) machineidNeedsWrite = true;
    }

    // 2. 检查 storage.json 是否已是目标值
    let storageData = {};
    try {
      if (fs.existsSync(paths.storageJson)) {
        storageData = JSON.parse(fs.readFileSync(paths.storageJson, 'utf8'));
      }
    } catch { storageData = {}; }

    let storageNeedsWrite = false;
    for (const k of TELEMETRY_KEYS) {
      if (ids[k] && storageData[k] !== ids[k]) {
        storageNeedsWrite = true;
        break;
      }
    }

    // 3. 完全一致 → skip 所有写入 (方案B 核心)
    if (!machineidNeedsWrite && !storageNeedsWrite) {
      return { ok: true, skipped: true };
    }

    // 4. 至少一处不一致 → 执行写入
    if (machineidNeedsWrite) {
      fs.writeFileSync(paths.machineid, ids.machineid, 'utf8');
    }

    if (storageNeedsWrite) {
      for (const k of TELEMETRY_KEYS) {
        if (ids[k]) storageData[k] = ids[k];
      }
      const dir = path.dirname(paths.storageJson);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpPath = paths.storageJson + '.tmp.' + process.pid;
      fs.writeFileSync(tmpPath, JSON.stringify(storageData, null, '\t'), 'utf8');
      try {
        fs.renameSync(tmpPath, paths.storageJson);
      } catch {
        // rename 失败时降级直写 (跨设备/跨分区时 rename 可能失败)
        fs.writeFileSync(paths.storageJson, JSON.stringify(storageData, null, '\t'), 'utf8');
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    }

    return { ok: true, skipped: false };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Discover fingerprint file paths based on platform */
function getFingerPrintPaths() {
  const p = process.platform;
  let globalBase;
  if (p === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    globalBase = path.join(appdata, 'Windsurf');
  } else if (p === 'darwin') {
    globalBase = path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf');
  } else {
    globalBase = path.join(os.homedir(), '.config', 'Windsurf');
  }
  return {
    globalBase,
    machineid: path.join(globalBase, 'machineid'),
    storageJson: path.join(globalBase, 'User', 'globalStorage', 'storage.json'),
    backupDir: path.join(globalBase, 'User', 'globalStorage', 'wam-fingerprint-backups'),
  };
}

/** Read current device fingerprint (all 6 IDs) */
function readFingerprint() {
  const paths = getFingerPrintPaths();
  const result = { paths, ids: {}, count: 0 };

  try {
    if (fs.existsSync(paths.machineid)) {
      result.ids.machineid = fs.readFileSync(paths.machineid, 'utf8').trim();
      result.count++;
    }
  } catch (e) { console.warn('WAM: read machineid failed:', e.message); }

  try {
    if (fs.existsSync(paths.storageJson)) {
      const data = JSON.parse(fs.readFileSync(paths.storageJson, 'utf8'));
      for (const k of TELEMETRY_KEYS) {
        if (data[k]) { result.ids[k] = data[k]; result.count++; }
      }
    }
  } catch (e) { console.warn('WAM: read storage.json failed:', e.message); }

  return result;
}

/**
 * Reset device fingerprint — generate new UUIDs for all 6 IDs
 * @param {object} options - { backup: true (default), dryRun: false }
 * @returns {{ ok, old, new, backupPath, error, requiresRestart }}
 */
function resetFingerprint(options = {}) {
  const paths = getFingerPrintPaths();
  const backup = options.backup !== false;
  const dryRun = options.dryRun === true;
  const result = { ok: false, old: {}, new: {}, backupPath: null, requiresRestart: false };

  // Read current
  const current = readFingerprint();
  result.old = current.ids;

  // Generate new IDs
  const newMachineId = _uuid();
  const newIds = {
    'machineid': newMachineId,
    'storage.serviceMachineId': newMachineId,
    'telemetry.devDeviceId': _uuid(),
    'telemetry.macMachineId': _hex32(),
    'telemetry.machineId': _hex32(),
    'telemetry.sqmId': _hex32(),
  };
  result.new = newIds;

  if (dryRun) { result.ok = true; return result; }

  // Backup old fingerprint
  if (backup) {
    try {
      if (!fs.existsSync(paths.backupDir)) fs.mkdirSync(paths.backupDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupFile = path.join(paths.backupDir, `fingerprint-${ts}.json`);
      fs.writeFileSync(backupFile, JSON.stringify({
        timestamp: ts,
        ids: current.ids,
        paths: { machineid: paths.machineid, storageJson: paths.storageJson },
      }, null, 2), 'utf8');
      result.backupPath = backupFile;
    } catch (e) { console.warn('WAM: fingerprint backup failed:', e.message); }
  }

  try {
    // Write machineid file
    if (fs.existsSync(path.dirname(paths.machineid))) {
      fs.writeFileSync(paths.machineid, newMachineId, 'utf8');
    }

    // Update storage.json
    let storageData = {};
    try {
      if (fs.existsSync(paths.storageJson)) {
        storageData = JSON.parse(fs.readFileSync(paths.storageJson, 'utf8'));
      }
    } catch (e) { console.warn('WAM: parse storage.json for reset:', e.message); storageData = {}; }

    for (const k of TELEMETRY_KEYS) {
      storageData[k] = newIds[k];
    }

    const storageDir = path.dirname(paths.storageJson);
    if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
    // Atomic write: tmp + rename
    const tmpPath = paths.storageJson + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(storageData, null, '\t'), 'utf8');
    try {
      fs.renameSync(tmpPath, paths.storageJson);
    } catch {
      fs.writeFileSync(paths.storageJson, JSON.stringify(storageData, null, '\t'), 'utf8');
      try { fs.unlinkSync(tmpPath); } catch {}
    }

    result.ok = true;
  } catch (e) {
    result.error = e.message;
  }

  return result;
}

/** Restore fingerprint from a backup file */
function restoreFingerprint(backupPath) {
  try {
    const data = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    if (!data.ids) return { ok: false, error: 'Invalid backup format' };

    const paths = getFingerPrintPaths();

    // Restore machineid
    if (data.ids.machineid) {
      fs.writeFileSync(paths.machineid, data.ids.machineid, 'utf8');
    }

    // Restore storage.json keys
    let storageData = {};
    try {
      if (fs.existsSync(paths.storageJson)) {
        storageData = JSON.parse(fs.readFileSync(paths.storageJson, 'utf8'));
      }
    } catch (e) { console.warn('WAM: parse storage.json for restore:', e.message); }

    for (const k of TELEMETRY_KEYS) {
      if (data.ids[k]) storageData[k] = data.ids[k];
    }
    fs.writeFileSync(paths.storageJson, JSON.stringify(storageData, null, '\t'), 'utf8');

    return { ok: true, restored: data.ids, timestamp: data.timestamp };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** List fingerprint reset history */
function listResetHistory() {
  const paths = getFingerPrintPaths();
  if (!fs.existsSync(paths.backupDir)) return [];
  try {
    return fs.readdirSync(paths.backupDir)
      .filter(f => f.startsWith('fingerprint-') && f.endsWith('.json'))
      .sort().reverse()
      .map(f => {
        const fp = path.join(paths.backupDir, f);
        try {
          const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
          return { name: f, path: fp, timestamp: data.timestamp, ids: Object.keys(data.ids).length };
        } catch (e) { console.warn('WAM: parse backup file:', e.message); return { name: f, path: fp }; }
      });
  } catch (e) { console.warn('WAM: listResetHistory failed:', e.message); return []; }
}

/**
 * Ensure all fingerprint IDs exist. Fill in any missing ones without changing existing.
 * P3 FIX: Missing macMachineId may cause server to flag device as abnormal.
 * @returns {{ fixed: string[], alreadyComplete: boolean }}
 */
function ensureComplete() {
  const paths = getFingerPrintPaths();
  const fixed = [];

  try {
    // Check machineid file
    if (!fs.existsSync(paths.machineid)) {
      const newId = _uuid();
      const dir = path.dirname(paths.machineid);
      if (fs.existsSync(dir)) {
        fs.writeFileSync(paths.machineid, newId, 'utf8');
        fixed.push('machineid');
      }
    }

    // Check storage.json keys
    let storageData = {};
    try {
      if (fs.existsSync(paths.storageJson)) {
        storageData = JSON.parse(fs.readFileSync(paths.storageJson, 'utf8'));
      }
    } catch (e) { console.warn('WAM: parse storage.json for ensureComplete:', e.message); storageData = {}; }

    let changed = false;
    for (const k of TELEMETRY_KEYS) {
      if (!storageData[k]) {
        if (k === 'telemetry.machineId' || k === 'telemetry.macMachineId') {
          storageData[k] = _hex32();
        } else {
          storageData[k] = _uuid();
        }
        fixed.push(k);
        changed = true;
      }
    }

    if (changed) {
      const dir = path.dirname(paths.storageJson);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(paths.storageJson, JSON.stringify(storageData, null, '\t'), 'utf8');
    }
  } catch (e) {
    console.warn('WAM: ensureComplete error:', e.message);
  }

  return { fixed, alreadyComplete: fixed.length === 0 };
}

/**
 * v23.5: Hot-verify with auto re-apply on mismatch.
 * VS Code's built-in telemetry service occasionally rewrites
 * telemetry.devDeviceId / machineId on its own schedule, silently breaking
 * per-account fingerprint binding. This wraps hotVerify() with up to N
 * re-apply attempts so the binding self-heals instead of staying broken.
 *
 * @param {object} expectedIds - same shape as hotVerify()
 * @param {object} [options]
 * @param {number} [options.maxRetries=2] — re-apply up to this many times after first failure
 * @param {number} [options.retryDelayMs=1500] — wait between attempts
 * @returns {{ verified, attempts, mismatches }}
 */
async function hotVerifyWithRetry(expectedIds, options = {}) {
  const maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : 2;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 1500;
  let last = { verified: false, mismatches: [] };
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (attempt > 1) {
      // Re-apply before re-verifying — assume VS Code (or another writer)
      // clobbered the value we wrote earlier.
      try { applyFingerprint(expectedIds); } catch {}
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
    last = hotVerify(expectedIds);
    if (last.verified) return { verified: true, attempts: attempt, mismatches: [] };
  }
  return { verified: false, attempts: maxRetries + 1, mismatches: last.mismatches };
}

/**
 * Hot-verify: confirm state.vscdb machine IDs match expected values.
 * Call after injection to verify LS restart picked up new fingerprint.
 * @param {object} expectedIds - { 'storage.serviceMachineId': '...', ... }
 * @returns {{ verified, mismatches: string[], dbIds: object }}
 */
function hotVerify(expectedIds) {
  if (!expectedIds || Object.keys(expectedIds).length === 0) return { verified: true, mismatches: [], dbIds: {} };
  const paths = getFingerPrintPaths();
  const dbPath = path.join(path.dirname(paths.storageJson), 'state.vscdb');
  if (!fs.existsSync(dbPath)) return { verified: false, mismatches: ['state.vscdb not found'], dbIds: {} };

  try {
    const keysToCheck = Object.keys(expectedIds).filter(k => TELEMETRY_KEYS.includes(k) || k === 'machineid');
    const dbQueryKeys = keysToCheck.map(k => k === 'machineid' ? 'storage.serviceMachineId' : k);
    const dbIds = dbReadKeys(dbPath, dbQueryKeys);
    const mismatches = [];
    for (const k of keysToCheck) {
      const dbKey = k === 'machineid' ? 'storage.serviceMachineId' : k;
      const expected = k === 'machineid' ? expectedIds[k] : expectedIds[k];
      const actual = dbIds[dbKey];
      if (actual && actual !== expected) {
        mismatches.push(`${dbKey}: expected=${expected?.slice(0,8)} actual=${actual?.slice(0,8)}`);
      }
    }
    return { verified: mismatches.length === 0, mismatches, dbIds };
  } catch (e) {
    return { verified: false, mismatches: [`verify error: ${e.message}`], dbIds: {} };
  }
}

export {
  readFingerprint, resetFingerprint, restoreFingerprint, listResetHistory,
  getFingerPrintPaths, ensureComplete, hotVerify, hotVerifyWithRetry,
  generateFingerprint, applyFingerprint,
  // v23.5: HTTP profile (per-account login fingerprint binding)
  generateHttpProfile, httpProfileToHeaders,
};
