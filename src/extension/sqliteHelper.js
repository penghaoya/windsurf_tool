/**
 * SQLite Helper — node:sqlite DatabaseSync (Node.js 22.5+ 内置)
 * 同步 API，零外部依赖，替代 Python execSync 方案
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import os from 'os';

let _tmpCounter = 0; // 原子计数器,避免同毫秒临时文件名碰撞

/** 获取当前平台的 state.vscdb 路径 */
export function getStateDbPath() {
  const p = process.platform;
  if (p === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'Windsurf', 'User', 'globalStorage', 'state.vscdb');
  } else if (p === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(os.homedir(), '.config', 'Windsurf', 'User', 'globalStorage', 'state.vscdb');
}

/** 读取单个 key (使用临时副本避免锁冲突) */
export function dbReadKey(dbPath, key) {
  const tmpDb = path.join(os.tmpdir(), `wam_read_${Date.now()}_${++_tmpCounter}.db`);
  try {
    fs.copyFileSync(dbPath, tmpDb);
    const db = new DatabaseSync(tmpDb, { readOnly: true });
    try {
      const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
      const row = stmt.get(key);
      return row ? row.value : null;
    } finally { db.close(); }
  } catch { return null; }
  finally { try { fs.unlinkSync(tmpDb); } catch {} }
}

/** 读取多个 key (使用临时副本) */
export function dbReadKeys(dbPath, keys) {
  const tmpDb = path.join(os.tmpdir(), `wam_read_${Date.now()}_${++_tmpCounter}.db`);
  try {
    fs.copyFileSync(dbPath, tmpDb);
    const db = new DatabaseSync(tmpDb, { readOnly: true });
    try {
      const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
      const result = {};
      for (const key of keys) {
        const row = stmt.get(key);
        result[key] = row ? row.value : null;
      }
      return result;
    } finally { db.close(); }
  } catch { return {}; }
  finally { try { fs.unlinkSync(tmpDb); } catch {} }
}

/** 读取 LIKE 匹配的 key (使用临时副本) */
export function dbReadKeysLike(dbPath, patterns) {
  const tmpDb = path.join(os.tmpdir(), `wam_read_${Date.now()}_${++_tmpCounter}.db`);
  try {
    fs.copyFileSync(dbPath, tmpDb);
    const db = new DatabaseSync(tmpDb, { readOnly: true });
    try {
      const result = {};
      const stmt = db.prepare('SELECT key, value FROM ItemTable WHERE key LIKE ?');
      for (const pat of patterns) {
        for (const row of stmt.all(pat)) {
          if (!result[row.key]) result[row.key] = row.value;
        }
      }
      return result;
    } finally { db.close(); }
  } catch { return {}; }
  finally { try { fs.unlinkSync(tmpDb); } catch {} }
}

/** 写入单个 key (INSERT OR REPLACE) */
export function dbWriteKey(dbPath, key, value) {
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.prepare('INSERT OR REPLACE INTO ItemTable(key,value) VALUES(?,?)').run(key, value);
      return true;
    } finally { db.close(); }
  } catch { return false; }
}

/** 删除单个 key */
export function dbDeleteKey(dbPath, key) {
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.prepare('DELETE FROM ItemTable WHERE key = ?').run(key);
      return true;
    } finally { db.close(); }
  } catch { return false; }
}

/** UPDATE 多个 key (事务包裹,保证原子性) */
export function dbUpdateKeys(dbPath, pairs) {
  if (!pairs || pairs.length === 0) return false;
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const stmt = db.prepare('UPDATE ItemTable SET value=? WHERE key=?');
      db.exec('BEGIN');
      try {
        for (const { key, value } of pairs) {
          stmt.run(value, key);
        }
        db.exec('COMMIT');
        return true;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
      }
    } finally { db.close(); }
  } catch { return false; }
}

/** 批量操作 (真事务): [{type:'write'|'update'|'delete', key, value?}]
 *  BEGIN/COMMIT 包裹,失败时 ROLLBACK 保证原子性 */
export function dbTransaction(dbPath, operations) {
  if (!operations || operations.length === 0) return false;
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const writeStmt = db.prepare('INSERT OR REPLACE INTO ItemTable(key,value) VALUES(?,?)');
      const updateStmt = db.prepare('UPDATE ItemTable SET value=? WHERE key=?');
      const deleteStmt = db.prepare('DELETE FROM ItemTable WHERE key=?');
      db.exec('BEGIN');
      try {
        for (const op of operations) {
          if (op.type === 'write') writeStmt.run(op.key, op.value);
          else if (op.type === 'update') updateStmt.run(op.value, op.key);
          else if (op.type === 'delete') deleteStmt.run(op.key);
        }
        db.exec('COMMIT');
        return true;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
      }
    } finally { db.close(); }
  } catch { return false; }
}
