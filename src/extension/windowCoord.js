/**
 * 多窗口协调引擎
 * 共享状态文件、窗口注册/心跳/注销、账号隔离、调度状态跨窗口同步
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  WINDOW_STATE_FILE, WINDOW_HEARTBEAT_MS, WINDOW_DEAD_MS, CACHE_TTL,
} from './config.js';
import {
  S, schedulerState, _normalizeEmail, _logInfo, _logWarn,
} from './engineState.js';

// ═══ 路径 ═══

/** 获取 Windsurf globalStorage 路径 (跨平台) */
export function _getWindsurfGlobalStoragePath() {
  const p = process.platform;
  if (p === "win32") {
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appdata, "Windsurf", "User", "globalStorage");
  } else if (p === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Windsurf", "User", "globalStorage");
  }
  return path.join(os.homedir(), ".config", "Windsurf", "User", "globalStorage");
}

export function _getWindowStatePath() {
  return path.join(_getWindsurfGlobalStoragePath(), WINDOW_STATE_FILE);
}

// ═══ 状态读写 ═══

export function _readWindowState(forceRefresh = false) {
  if (
    !forceRefresh &&
    S.cachedWindowState &&
    Date.now() - S.cacheTs < CACHE_TTL
  ) {
    return JSON.parse(JSON.stringify(S.cachedWindowState));
  }
  try {
    const p = _getWindowStatePath();
    if (!fs.existsSync(p)) return { windows: {} };
    const state = JSON.parse(fs.readFileSync(p, "utf8"));
    S.cachedWindowState = state;
    S.cacheTs = Date.now();
    return JSON.parse(JSON.stringify(state));
  } catch {
    return { windows: {} };
  }
}

export function _writeWindowState(state) {
  try {
    const p = _getWindowStatePath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = p + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, p);
    S.cachedWindowState = state;
    S.cacheTs = Date.now();
  } catch (e) {
    try {
      fs.writeFileSync(
        _getWindowStatePath(),
        JSON.stringify(state, null, 2),
        "utf8",
      );
    } catch {}
    _logWarn("窗口协调", "原子写入失败, 已降级直写", e.message);
  }
}

// ═══ 窗口生命周期 ═══

export function _registerWindow(accountIndex) {
  S.windowId = `w${process.pid}-${Date.now().toString(36)}`;
  const state = _readWindowState(true);
  const account = S.am ? S.am.get(accountIndex) : null;
  state.windows[S.windowId] = {
    accountIndex,
    accountEmail: account?.email || null,
    lastHeartbeat: Date.now(),
    pid: process.pid,
    startedAt: Date.now(),
  };
  _writeWindowState(state);
  _logInfo("窗口协调", `本窗口注册: ${S.windowId} → 使用账号#${accountIndex + 1} (${account?.email?.split('@')[0] || '未登录'})`);
}

export function _heartbeatWindow() {
  if (!S.windowId) return;
  _mergeSchedulerFromShared();
  const state = _readWindowState(true);
  if (!state.windows[S.windowId]) {
    state.windows[S.windowId] = { pid: process.pid, startedAt: Date.now() };
  }
  state.windows[S.windowId].accountIndex = S.activeIndex;
  state.windows[S.windowId].accountEmail = S.am?.get(S.activeIndex)?.email || null;
  state.windows[S.windowId].lastHeartbeat = Date.now();
  const now = Date.now();
  for (const [id, w] of Object.entries(state.windows)) {
    if (now - w.lastHeartbeat > WINDOW_DEAD_MS) delete state.windows[id];
  }
  _writeSchedulerToState(state);
  _writeWindowState(state);
}

export function _deregisterWindow() {
  if (!S.windowId) return;
  try {
    const state = _readWindowState(true);
    delete state.windows[S.windowId];
    _writeWindowState(state);
    _logInfo("窗口协调", `本窗口注销: ${S.windowId}`);
  } catch {}
}

// ═══ 窗口查询 ═══

export function _getOtherWindowAccountEmails() {
  if (!S.windowId) return [];
  const state = _readWindowState();
  const now = Date.now();
  const claimed = [];
  for (const [id, w] of Object.entries(state.windows)) {
    if (id === S.windowId) continue;
    if (now - w.lastHeartbeat > WINDOW_DEAD_MS) continue;
    if (w.accountEmail) claimed.push(_normalizeEmail(w.accountEmail));
  }
  return claimed;
}

export function _getActiveWindowCount() {
  const state = _readWindowState();
  const now = Date.now();
  return Object.values(state.windows).filter(
    (w) => now - w.lastHeartbeat <= WINDOW_DEAD_MS,
  ).length;
}

// ═══ 调度状态跨窗口同步 ═══

/** 写本窗口的调度阻断状态到共享 state 对象 */
export function _writeSchedulerToState(state) {
  const now = Date.now();
  const sharedPc = state.scheduler?.poolCooldowns || {};
  for (const [key, cd] of schedulerState.poolCooldowns) {
    if (cd.until <= now) continue;
    if (!sharedPc[key] || cd.until > sharedPc[key].until) sharedPc[key] = { ...cd };
  }
  for (const k of Object.keys(sharedPc)) { if (sharedPc[k].until <= now) delete sharedPc[k]; }
  const sharedAq = state.scheduler?.accountQuarantines || {};
  for (const [email, q] of schedulerState.accountQuarantines) {
    if (q.until <= now) continue;
    if (!sharedAq[email] || q.until > sharedAq[email].until) sharedAq[email] = { ...q };
  }
  for (const e of Object.keys(sharedAq)) { if (sharedAq[e].until <= now) delete sharedAq[e]; }
  state.scheduler = { poolCooldowns: sharedPc, accountQuarantines: sharedAq };
}

/** 将本窗口调度状态立即写入共享文件 (arm/clear 时调用) */
export function _syncSchedulerToShared() {
  try {
    const state = _readWindowState(true);
    _writeSchedulerToState(state);
    _writeWindowState(state);
  } catch (e) { /* 非关键: 共享状态同步失败不影响本窗口 */ }
}

/** 从共享文件合并其他窗口的调度状态 (poolTick/heartbeat 时调用) */
export function _mergeSchedulerFromShared() {
  try {
    const state = _readWindowState();
    if (!state.scheduler) return;
    const now = Date.now();
    if (state.scheduler.poolCooldowns) {
      for (const [key, cd] of Object.entries(state.scheduler.poolCooldowns)) {
        if (cd.until <= now) continue;
        const local = schedulerState.poolCooldowns.get(key);
        if (!local || cd.until > local.until) {
          schedulerState.poolCooldowns.set(key, cd);
        }
      }
    }
    if (state.scheduler.accountQuarantines) {
      for (const [email, q] of Object.entries(state.scheduler.accountQuarantines)) {
        if (q.until <= now) continue;
        const local = schedulerState.accountQuarantines.get(email);
        if (!local || q.until > local.until) {
          schedulerState.accountQuarantines.set(email, q);
        }
      }
    }
  } catch {}
}

// ═══ 启动协调器 ═══

export function _startWindowCoordinator(context) {
  _registerWindow(S.activeIndex);
  S.windowTimer = setInterval(() => _heartbeatWindow(), WINDOW_HEARTBEAT_MS);
  context.subscriptions.push({
    dispose: () => {
      if (S.windowTimer) {
        clearInterval(S.windowTimer);
        S.windowTimer = null;
      }
      _deregisterWindow();
    },
  });
  const winCount = _getActiveWindowCount();
  _logInfo("窗口协调", `已启动 — 当前${winCount}个活跃窗口`);
  if (winCount > 1) {
    const others = _getOtherWindowAccountEmails();
    _logInfo(
      "窗口协调",
      `其他窗口占用账号: [${others.join(", ")}] (已排除不会重复选择)`,
    );
  }
}
