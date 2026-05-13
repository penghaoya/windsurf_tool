/**
 * Cross-window usage disk cache (borrowed from windsurf-pool)
 *
 * Atomic JSON file shared between windows so that when window A refreshes
 * an account's quota, window B can read it without issuing a duplicate
 * network request. Writes are queued to avoid concurrent corruption.
 */
import fs from 'fs';
import path from 'path';

const CACHE_FILE = 'usage-cache.json';
let _cachePath = null;
let _writeQueue = Promise.resolve();

export function initUsageDiskCache(storagePath) {
  if (!storagePath) return;
  try {
    if (!fs.existsSync(storagePath)) fs.mkdirSync(storagePath, { recursive: true });
    _cachePath = path.join(storagePath, CACHE_FILE);
  } catch {}
}

/** Read a single entry by email. Returns { remaining, daily, weekly, ts } or null */
export function readDiskCacheEntry(email) {
  if (!_cachePath || !email) return null;
  try {
    if (!fs.existsSync(_cachePath)) return null;
    const all = JSON.parse(fs.readFileSync(_cachePath, 'utf8'));
    const key = email.toLowerCase().trim();
    return all[key] || null;
  } catch { return null; }
}

/** Read all entries. Returns object keyed by lowercase email */
export function readAllDiskCache() {
  if (!_cachePath) return {};
  try {
    if (!fs.existsSync(_cachePath)) return {};
    return JSON.parse(fs.readFileSync(_cachePath, 'utf8')) || {};
  } catch { return {}; }
}

/** Write a single entry (atomic, queued) */
export function writeDiskCacheEntry(email, entry) {
  if (!_cachePath || !email || !entry) return;
  const key = email.toLowerCase().trim();
  _writeQueue = _writeQueue.catch(() => {}).then(() => {
    try {
      let all = {};
      try {
        if (fs.existsSync(_cachePath)) {
          all = JSON.parse(fs.readFileSync(_cachePath, 'utf8')) || {};
        }
      } catch {}
      all[key] = { ...entry, ts: Date.now() };
      const tmp = `${_cachePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(all), 'utf8');
      fs.renameSync(tmp, _cachePath);
    } catch (e) {
      try { fs.unlinkSync(`${_cachePath}.tmp.${process.pid}`); } catch {}
    }
  });
}

/** Pick the newer entry between two (memory vs disk) */
export function pickNewer(memEntry, diskEntry) {
  if (!memEntry && !diskEntry) return null;
  if (!memEntry) return diskEntry;
  if (!diskEntry) return memEntry;
  return (diskEntry.ts || 0) > (memEntry.ts || 0) ? diskEntry : memEntry;
}
