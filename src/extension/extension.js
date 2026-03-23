/**
 * 无感号池引擎 v1.0.0
 *
 * 道: 用户是号池，不是单个账号。切换必须在rate limit之前发生。
 *
 * 架构:
 *   认证: Firebase → idToken → provideAuthTokenToAuthProvider → session
 *   额度: QUOTA(daily%+weekly%) | CREDITS(固定积分) → effective=min(D,W)
 *   指纹: 6个ID轮转(切号前写入→LS重启读取=热重置)
 *   注入: S0=idToken → S1=OTAT → S2=apiKey → S3=DB直写
 *   预防: L5 gRPC容量探测(CheckUserMessageRateLimit)为本，辅以阈值/斜率/限流检测
 *
 * 详细版本演进见 FIRST_PRINCIPLES.md
 */
import vscode from 'vscode';
import { AccountManager } from './accountManager.js';
import { AuthService } from './authService.js';
import { openAccountPanel, AccountViewProvider } from './webviewProvider.js';
import {
  readFingerprint,
  resetFingerprint,
  ensureComplete as ensureFingerprintComplete,
  hotVerify,
} from './fingerprintManager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { execSync } from 'child_process';
import { getStateDbPath, dbReadKey, dbDeleteKey, dbUpdateKeys, dbTransaction } from './sqliteHelper.js';

// ═══ 号池状态 ═══
let statusBar, am, auth, _panelProvider, _panel;
let _activeIndex = -1; // 当前活跃账号
let _switching = false; // 切换锁
let _poolTimer = null; // 号池引擎定时器
let _lastQuota = null; // 上次活跃账号额度(变化检测)
let _lastCheckTs = 0; // 上次检查时间戳
let _boostUntil = 0; // 加速模式截止
let _switchCount = 0; // 本会话切换次数
let _discoveredAuthCmd = null; // 缓存发现的注入命令
let _outputChannel = null; // 结构化日志输出通道
let _eventLog = []; // 事件日志缓冲 [{ts, level, msg}]
const MAX_EVENT_LOG = 200; // 最大日志条数

// ═══ v7.5 Gate 4: Account-Tier Rate Limit Detection ═══
// 根因: Trial/Free账号有独立于Quota和Per-Model的硬性小时消息上限
// 证据: "Permission denied: Rate limit exceeded...no credits were used...upgrade to Pro...try again in about an hour"
// 关键区分: "no credits were used" + "upgrade to Pro" = 层级硬限, 非配额/非模型级
// 对策: 跳过模型轮转(无效), 直接账号切换 + 3600s冷却
const TIER_RL_RE = /rate\s*limit\s*exceeded[\s\S]*?no\s*credits\s*were\s*used/i;
const UPGRADE_PRO_RE = /upgrade\s*to\s*a?\s*pro/i;
const ABOUT_HOUR_RE = /try\s*again\s*in\s*about\s*an?\s*hour/i;
const MODEL_UNREACHABLE_RE = /model\s*provider\s*unreachable/i;
const PROVIDER_ERROR_RE = /provider.*(?:error|unavailable|unreachable)|(?:error|unavailable|unreachable).*provider/i;
const GLOBAL_TRIAL_RL_RE = /(?:all\s*)?(?:API\s*)?providers?\s*(?:are\s*)?over\s*(?:their\s*)?(?:global\s*)?rate\s*limit\s*for\s*trial/i;
const HOUR_WINDOW = 3600000; // 1小时滑动窗口
const TIER_MSG_CAP_ESTIMATE = 25; // Trial账号预估小时消息上限(保守)
const TIER_CAP_WARN_RATIO = 0.7; // 达到上限70%即预防
const TRIAL_GUARD_CONFIRM_WINDOW = 180000; // Trial Guard二次确认窗口 3min
const TRIAL_GUARD_SINGLE_CONFIRM_DROP = 5; // 单次降幅≥5%才允许直接确认 (Sonnet Thinking单条可消耗3%)
const TRIAL_GUARD_ACCOUNT_QUARANTINE_SEC = 3600; // Trial Guard命中后单账号隔离 1h
const GLOBAL_TRIAL_POOL_COOLDOWN_SEC = 1200; // Trial全局限流时，整组Trial候选冷却 20min
const TRIAL_GUARD_COOLDOWN_MS = 300000; // Trial Guard触发后冷却5min，避免重复触发噪音
let _tierRateLimitCount = 0; // 本会话Gate 4触发次数
let _lastTrialGuardActionTs = 0; // Trial Guard上次触发动作的时间戳


// ═══ 多窗口协调 (v6.3 P0) ═══
const WINDOW_STATE_FILE = "wam-window-state.json";
const WINDOW_HEARTBEAT_MS = 30000; // 30s心跳
const WINDOW_DEAD_MS = 90000; // 90s无心跳=死亡
let _windowId = null; // 本窗口唯一ID
let _windowTimer = null; // 心跳定时器

const POLL_NORMAL = 45000; // 正常轮询 45s
const POLL_BOOST = 8000; // 加速轮询 8s (v6.2: 从12s降至8s)
const POLL_BURST = 3000; // 并发burst轮询 3s (v6.4: 多Tab场景)
const BOOST_DURATION = 300000; // 加速持续 5min (v6.2: 从3min延至5min)
const DEFAULT_PREEMPTIVE_THRESHOLD = 15;
const SLOPE_WINDOW = 5; // 斜率预测窗口(样本数)
const SLOPE_HORIZON = 300000; // 预测视野5min(ms)

// ═══ 并发Tab感知 (v6.4 P0: 解决单窗口多Tab并发消息速率限流的核心矛盾) ═══
// 根因: 5个Cascade Tab共享1个账号session，并发请求形成burst → 触发消息速率限制(非配额耗尽)
// 截图证据: "Permission denied: Rate limit exceeded. no credits were used" = 请求被拦截在计费前
// 解法: 感知Tab数+追踪消息速率+动态调整轮询/冷却+主动轮转
const CONCURRENT_TAB_SAFE = 2; // 安全并发Tab数(超过即进入burst防护)
const MSG_RATE_WINDOW = 60000; // 消息速率统计窗口 60s
const MSG_RATE_LIMIT = 12; // 预估消息速率上限(条/分钟, 保守估计)
const BURST_DETECT_THRESHOLD = 0.7; // 速率达到上限的70%即触发预防
let _cascadeTabCount = 0; // 当前检测到的Cascade Tab数
let _lastTabCheck = 0; // 上次Tab检测时间
const TAB_CHECK_INTERVAL = 10000; // Tab检测间隔 10s
let _burstMode = false; // 是否处于burst防护模式

// ═══ 全池实时监控 (v6.7 P0: 检测所有账号额度变化 + 活跃账号变动即切) ═══
let _allQuotaSnapshot = new Map(); // index → {remaining, checkedAt} 全池额度快照
let _lastFullScanTs = 0; // 上次全池扫描时间戳
let _lastReactiveSwitchTs = 0; // 上次响应式切换时间戳
const FULL_SCAN_INTERVAL_NORMAL = 300000; // 全池扫描间隔 300s (正常模式)
const FULL_SCAN_INTERVAL_BOOST = 120000; // 全池扫描间隔 120s (加速模式)
const FULL_SCAN_INTERVAL_BURST = 60000; // 全池扫描间隔 60s (burst模式)
const REACTIVE_SWITCH_CD = 10000; // 响应式切换冷却 10s (v7.4: 从30s收紧，加速响应)
const REACTIVE_DROP_MIN = 5; // 响应式切换最小降幅阈值 (额度降>5%才触发，避免微波动)
const UFEF_COOLDOWN = 600000; // UFEF切换冷却 10min，避免safe↔urgent频繁抖动
let _lastUfefSwitchTs = 0; // 上次UFEF触发切换的时间戳

// ═══ v7.0 热重置引擎 (Hot Reset Engine) ═══
// 核心洞察: provideAuthTokenToAuthProvider → LS重启 → LS在启动时读取机器码
// 如果在注入BEFORE轮转指纹, LS重启自然拿到新ID = 热重置, 无需重启Windsurf
// 旧流程(v6.9): 注入 → LS重启(读旧ID) → 轮转指纹(写新ID到磁盘, 但LS已用旧ID)
// 新流程(v7.0): 轮转指纹(写新ID) → 注入 → LS重启(读新ID!) → 验证 = 热重置完成
let _lastRotatedIds = null; // 最近一次轮转生成的新ID (用于热验证)
let _hotResetCount = 0; // 本会话热重置成功次数
let _hotResetVerified = 0; // 本会话热重置已验证次数
// 积分速度追踪器 (v7.0: 检测高速消耗 → 主动触发热重置+切号)
const VELOCITY_WINDOW = 120000; // 速度计算窗口 120s
const VELOCITY_THRESHOLD = 10; // 速度阈值: 120s内降>10% = 高速消耗

// ═══ Per-Model Rate Limit Breakthrough Engine (Opus Guard) ═══
// 根因: 服务端对每个(apiKey, modelUid)维护独立滑动窗口消息速率桶
// Thinking模型分级预算 — 根据模型tier动态调整budget
//   - Thinking 1M: ACU=10x, 服务端桶≈3条/20min → Budget=1(每条即切!)
//   - Thinking:    ACU=8x,  服务端桶≈4条/20min → Budget=2
//   - Regular:     ACU=6x,  服务端桶≈5条/20min → Budget=3
// 核心洞察: L5探测返回-1/-1(Trial盲探) → 唯一可靠防线=自主计数+分级预算
//          Opus 6变体共享同一服务端桶(同底层API) → 变体轮转=浪费时间
const OPUS_VARIANTS = [
  'claude-opus-4-6-thinking-1m',
  'claude-opus-4-6-thinking',
  'claude-opus-4-6-1m',
  'claude-opus-4-6',
  'claude-opus-4-6-thinking-fast',
  'claude-opus-4-6-fast',
];
const SONNET_FALLBACK = 'claude-sonnet-4-6-thinking-1m';
let _currentModelUid = null; // 当前活跃模型UID (从windsurfConfigurations读取)
let _modelRateLimitCount = 0; // 本会话per-model rate limit触发次数
let _lastModelSwitch = 0; // 上次模型切换时间戳
let _downgradeLockUntil = 0; // 降级锁: 防止DB读取覆盖降级后的模型状态
let _lastTrialPoolCooldownFailTs = 0; // 上次Trial池冷却导致切换失败的时间戳
const TRIAL_POOL_COOLDOWN_RETRY_CD = 60000; // Trial池冷却切换失败后重试间隔 60s

// ═══ Layer 8: Opus消息预算守卫 (Thinking-Tier-Aware Prevention) ═══
// 实测: Opus Thinking 1M桶容量≈3条/20min → Resets in: 20m3s (1203s)
//       Opus Thinking桶容量≈4条/20min → Resets in: ~20min
//       Opus Regular桶容量≈5条/20min → Resets in: ~22min
// 分级预算 — Thinking 1M=1条即切, Thinking=2条, Regular=3条
const OPUS_THINKING_1M_BUDGET = 1; // Thinking 1M: 每条消息后立即切号!
const OPUS_THINKING_BUDGET = 2;    // Thinking: 2条后切号
const OPUS_REGULAR_BUDGET = 3;     // Regular Opus: 3条后切号
const OPUS_BUDGET_WINDOW = 1200000; // 20分钟滑动窗口(ms) — 匹配实测Opus Thinking 1M 20m3s
const OPUS_PREEMPT_RATIO = 1.0;    // 达到预算100%即切(分级预算已足够保守)
const OPUS_COOLDOWN_DEFAULT = 1500; // Opus per-model默认冷却1500s(25min) — 匹配实测
const CAPACITY_CHECK_THINKING = 3000; // Thinking模型L5探测间隔3s(更快检测hasCapacity=false)
let _opusGuardSwitchCount = 0; // 本会话Opus守卫主动切号次数

const schedulerState = {
  accounts: new Map(),
  accountQuarantines: new Map(),
  poolCooldowns: new Map(),
};

function _createAccountRuntime() {
  return {
    hourlyMsgLog: [],
    msgRateLog: [],
    quotaHistory: [],
    velocityLog: [],
    opusMsgLog: [],
    capacity: {
      lastCheck: 0,
      lastResult: null,
      failCount: 0,
      lastSuccessfulProbe: Date.now(),
      realMaxMessages: -1,
    },
    trialGuard: {
      consecutiveDrops: 0,
      lastDropTs: 0,
      lastQuota: null,
    },
  };
}

function _normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function _getAccountEmail(index = _activeIndex) {
  if (!am || index < 0) return '';
  return _normalizeEmail(am.get(index)?.email);
}

function _getAccountRuntimeByEmail(email, create = true) {
  const key = _normalizeEmail(email);
  if (!key) return null;
  if (!schedulerState.accounts.has(key) && create) {
    schedulerState.accounts.set(key, _createAccountRuntime());
  }
  return schedulerState.accounts.get(key) || null;
}

function _getAccountRuntime(index = _activeIndex, create = true) {
  return _getAccountRuntimeByEmail(_getAccountEmail(index), create);
}

function _getCapacityState(index = _activeIndex, create = true) {
  return _getAccountRuntime(index, create)?.capacity || null;
}

function _clearExpiredEntries(store) {
  const now = Date.now();
  for (const [key, value] of store.entries()) {
    if (!value?.until || value.until <= now) {
      store.delete(key);
    }
  }
}

function _getModelFamily(uid) {
  if (_isOpusModel(uid)) return 'opus';
  const model = String(uid || '').toLowerCase();
  if (model.includes('sonnet')) return 'sonnet';
  return model || 'unknown';
}

function _getTrialPoolCooldownKey(modelUid = _currentModelUid || _readCurrentModelUid()) {
  return `trial:${_getModelFamily(modelUid)}`;
}

function _getAccountQuarantineByEmail(email) {
  _clearExpiredEntries(schedulerState.accountQuarantines);
  return schedulerState.accountQuarantines.get(_normalizeEmail(email)) || null;
}

function _isAccountQuarantined(indexOrEmail) {
  const email = typeof indexOrEmail === 'number'
    ? _getAccountEmail(indexOrEmail)
    : _normalizeEmail(indexOrEmail);
  return !!_getAccountQuarantineByEmail(email);
}

function _setAccountQuarantine(indexOrEmail, seconds, reason, meta = {}) {
  const email = typeof indexOrEmail === 'number'
    ? _getAccountEmail(indexOrEmail)
    : _normalizeEmail(indexOrEmail);
  if (!email || !seconds) return;
  const until = Date.now() + seconds * 1000;
  const current = _getAccountQuarantineByEmail(email);
  if (current && current.until >= until) return;
  schedulerState.accountQuarantines.set(email, { until, reason, ...meta });
}

function _clearAccountQuarantine(indexOrEmail) {
  const email = typeof indexOrEmail === 'number'
    ? _getAccountEmail(indexOrEmail)
    : _normalizeEmail(indexOrEmail);
  if (!email) return;
  schedulerState.accountQuarantines.delete(email);
}

function _getTrialPoolCooldown(modelUid = _currentModelUid || _readCurrentModelUid()) {
  _clearExpiredEntries(schedulerState.poolCooldowns);
  return schedulerState.poolCooldowns.get(_getTrialPoolCooldownKey(modelUid)) || null;
}

function _armTrialPoolCooldown(modelUid, seconds, reason, meta = {}) {
  if (!seconds) return;
  const key = _getTrialPoolCooldownKey(modelUid);
  const until = Date.now() + seconds * 1000;
  const current = _getTrialPoolCooldown(modelUid);
  if (current && current.until >= until) return;
  schedulerState.poolCooldowns.set(key, { until, reason, ...meta });
}

function _isTrialLikeAccount(index) {
  if (!am || index < 0) return false;
  const account = am.get(index);
  if (!account) return false;
  const plan = String(account.usage?.plan || '').toLowerCase();
  return plan.includes('trial') || plan === 'free' || plan.startsWith('free ');
}

function _filterRuntimeCandidates(candidates, { modelUid = null } = {}) {
  const trialPoolCooldown = _getTrialPoolCooldown(modelUid);
  return candidates.filter((candidate) => {
    if (_isAccountQuarantined(candidate.email || candidate.index)) return false;
    if (trialPoolCooldown && _isTrialLikeAccount(candidate.index)) return false;
    return true;
  });
}

function _resetAccountRuntimeByEmail(email) {
  const key = _normalizeEmail(email);
  if (!key) return;
  schedulerState.accounts.set(key, _createAccountRuntime());
}

function _dropAccountRuntimeByEmail(email) {
  const key = _normalizeEmail(email);
  if (!key) return;
  schedulerState.accounts.delete(key);
}

function _resetTrialGuard(index = _activeIndex) {
  const runtime = _getAccountRuntime(index);
  if (!runtime) return;
  runtime.trialGuard = {
    consecutiveDrops: 0,
    lastDropTs: 0,
    lastQuota: null,
  };
}

function _getPreemptiveThreshold() {
  const raw = vscode.workspace.getConfiguration('wam').get('preemptiveThreshold', DEFAULT_PREEMPTIVE_THRESHOLD);
  const num = Number(raw);
  if (!Number.isFinite(num)) return DEFAULT_PREEMPTIVE_THRESHOLD;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function _getActiveSelectionMode() {
  return am && _activeIndex >= 0 && am.getSelectionMode ? am.getSelectionMode(_activeIndex) : null;
}

/** 读取当前活跃模型UID (从state.vscdb windsurfConfigurations/codeium.windsurf)
 *  v13.1: 降级锁 — _downgradeFromTrialPressure后60s内不从DB读取,防止覆盖 */
function _readCurrentModelUid() {
  // v13.1: 降级锁生效期间,直接返回缓存的降级后模型,不读DB
  if (_downgradeLockUntil > 0 && Date.now() < _downgradeLockUntil && _currentModelUid) {
    return _currentModelUid;
  }
  if (_downgradeLockUntil > 0 && Date.now() >= _downgradeLockUntil) {
    _downgradeLockUntil = 0; // 锁过期,恢复正常读取
  }
  try {
    if (!auth) return _currentModelUid;
    const cw = auth.readCachedValue && auth.readCachedValue('codeium.windsurf');
    if (cw) {
      const d = JSON.parse(cw);
      const uids = d['windsurf.state.lastSelectedCascadeModelUids'];
      if (Array.isArray(uids) && uids.length > 0) {
        _currentModelUid = uids[0];
        return _currentModelUid;
      }
    }
  } catch {}
  // v8.0 fallback: 如果state.vscdb读取失败但有缓存值则返回缓存
  // 防止_currentModelUid为null导致Gate 3 handler被跳过
  return _currentModelUid || 'claude-opus-4-6-thinking-1m'; // 默认假设Opus(保守策略)
}

/** 检测modelUid是否属于Opus家族 */
function _isOpusModel(uid) {
  return uid && uid.toLowerCase().includes('opus');
}

/** 检测是否为Thinking模型(更高token成本, 更低rate limit) */
function _isThinkingModel(uid) {
  return uid && uid.toLowerCase().includes('thinking');
}

/** 检测是否为Thinking 1M模型(最高成本, 最低rate limit) */
function _isThinking1MModel(uid) {
  if (!uid) return false;
  const u = uid.toLowerCase();
  return u.includes('thinking') && u.includes('1m');
}

/** 根据模型tier获取动态预算 — 道法自然, 因材施教 */
function _getModelBudget(uid) {
  if (!uid || !_isOpusModel(uid)) return OPUS_REGULAR_BUDGET;
  if (_isThinking1MModel(uid)) return OPUS_THINKING_1M_BUDGET; // 1条即切!
  if (_isThinkingModel(uid)) return OPUS_THINKING_BUDGET;       // 2条后切
  return OPUS_REGULAR_BUDGET;                                   // 3条后切
}

function _getModelVariants(uid) {
  if (_isOpusModel(uid)) return OPUS_VARIANTS;
  return uid ? [uid] : [];
}

/** v8.0: 追踪Opus消息 — 在quota%下降且当前模型=Opus时调用 */
function _trackOpusMsg(accountIndex) {
  const runtime = _getAccountRuntime(accountIndex);
  if (!runtime) return;
  runtime.opusMsgLog.push({ ts: Date.now() });
  const cutoff = Date.now() - OPUS_BUDGET_WINDOW;
  runtime.opusMsgLog = runtime.opusMsgLog.filter((m) => m.ts > cutoff);
}

/** v8.0: 获取当前账号在窗口内的Opus消息数 */
function _getOpusMsgCount(accountIndex) {
  const runtime = _getAccountRuntime(accountIndex, false);
  if (!runtime) return 0;
  const cutoff = Date.now() - OPUS_BUDGET_WINDOW;
  const valid = runtime.opusMsgLog.filter((m) => m.ts > cutoff);
  return valid.length;
}

/** 判断是否达到Opus消息预算 — 分级预算, Thinking 1M=1条即切 */
function _isNearOpusBudget(accountIndex) {
  const modelUid = _currentModelUid || _readCurrentModelUid();
  const budget = _getModelBudget(modelUid);
  const count = _getOpusMsgCount(accountIndex);
  return count >= budget; // budget=1时, 1条消息后即返回true → 立即切号
}

/** v8.0: 切号后重置该账号的Opus消息计数 */
function _resetOpusMsgLog(accountIndex) {
  const runtime = _getAccountRuntime(accountIndex);
  if (runtime) runtime.opusMsgLog = [];
}

// ═══ Layer 5: Active Rate Limit Capacity Probe ═══
// 根因突破: Windsurf workbench的rate limit分类器是死代码(GZt=Z=>!1)
//          → 不设置任何context key → WAM的4层检测全部盲区
// 解法: 主动调用CheckUserMessageRateLimit gRPC端点 → 获取精确容量数据 → 在用户消息失败前切号
// 逆向自 @exa/chat-client: 此端点是Cascade发送每条消息前的预检
// 返回: { hasCapacity, messagesRemaining, maxMessages, resetsInSeconds }
const CAPACITY_CHECK_INTERVAL = 45000; // 正常容量检查间隔 45s
const CAPACITY_CHECK_FAST = 15000; // 活跃使用时快速检查 15s
const CAPACITY_PREEMPT_REMAINING = 2; // 剩余≤2条消息时提前切号
let _cachedApiKey = null; // 缓存当前session apiKey
let _cachedApiKeyTs = 0; // apiKey缓存时间戳
const APIKEY_CACHE_TTL = 120000; // apiKey缓存2min(注入后刷新)
let _capacityProbeCount = 0; // 本会话容量探测次数
let _capacitySwitchCount = 0; // 本会话因容量不足触发的切号次数

// ═══ v7.5 Gate 4: Account-Tier Rate Limit Engine ═══

/** 分类限流类型 — 四重闸门路由
 *  Gate 1/2: quota (D%/W%耗尽) → 账号切换 + 等日/周重置
 *  Gate 3: per_model (单模型桶满) → 模型变体轮转 → 账号切换 → 降级
 *  Gate 4: tier_cap (层级硬限) → 跳过模型轮转, 直接账号切换 + 3600s
 */
function _classifyRateLimit(errorText, contextKey) {
  if (!errorText && !contextKey) return 'unknown';
  const text = (errorText || '') + ' ' + (contextKey || '');
  // "Model provider unreachable" → 立即切号(可能是账号被封或模型访问受限)
  if (MODEL_UNREACHABLE_RE.test(text) || PROVIDER_ERROR_RE.test(text)) {
    return 'tier_cap'; // 当作tier_cap处理：直接换号
  }
  // v12.0: "all API providers are over their global rate limit for trial users" → 全局Trial限流
  if (GLOBAL_TRIAL_RL_RE.test(text)) {
    return 'tier_cap';
  }
  // Gate 4 特征: "no credits were used" + "upgrade to Pro" 或 "about an hour"
  if (TIER_RL_RE.test(text) || (UPGRADE_PRO_RE.test(text) && /rate\s*limit/i.test(text))) {
    return 'tier_cap';
  }
  if (ABOUT_HOUR_RE.test(text)) return 'tier_cap';
  // Gate 3 特征: "for this model" 或 模型级context key
  if (/for\s*this\s*model/i.test(text) || /model.*rate.*limit/i.test(text)) {
    return 'per_model';
  }
  if (contextKey && (contextKey.includes('modelRateLimited') || contextKey.includes('messageRateLimited'))) {
    return 'per_model';
  }
  // Gate 1/2 特征: "quota" 相关
  if (/quota/i.test(text) && /exhaust|exceed/i.test(text)) return 'quota';
  if (contextKey && contextKey.includes('quota')) return 'quota';
  // v8.0: 当context key是通用限流(permissionDenied/rateLimited)且当前模型=Opus时
  // 高概率为per-model rate limit(Opus桶容量最小,最容易触发)
  // 防止这些通用key落入'unknown'导致Gate 3 handler被跳过
  if (contextKey && (contextKey.includes('permissionDenied') || contextKey.includes('rateLimited'))) {
    const model = _currentModelUid || _readCurrentModelUid();
    if (_isOpusModel(model)) return 'per_model';
  }
  return 'unknown';
}

/** 追踪每小时消息数(用于Gate 4预测) */
function _trackHourlyMsg() {
  const runtime = _getAccountRuntime();
  if (!runtime) return;
  runtime.hourlyMsgLog.push({ ts: Date.now() });
  const cutoff = Date.now() - HOUR_WINDOW;
  runtime.hourlyMsgLog = runtime.hourlyMsgLog.filter((m) => m.ts > cutoff);
}

/** 获取当前小时消息数 */
function _getHourlyMsgCount() {
  const runtime = _getAccountRuntime(_activeIndex, false);
  if (!runtime) return 0;
  const cutoff = Date.now() - HOUR_WINDOW;
  return runtime.hourlyMsgLog.filter((m) => m.ts > cutoff).length;
}

/** 判断是否接近Gate 4层级上限
 *  v12.0: L5 NO_DATA时降低Trial预估上限(15→25), 更早触发预防切号 */
function _isNearTierCap() {
  const capacity = _getCapacityState(_activeIndex, false);
  const lastResult = capacity?.lastResult;
  const isNoData = lastResult && lastResult.messagesRemaining < 0;
  const realMax = capacity?.realMaxMessages ?? -1;
  const effectiveCap = realMax > 0 ? realMax : (isNoData ? 15 : TIER_MSG_CAP_ESTIMATE);
  return _getHourlyMsgCount() >= effectiveCap * TIER_CAP_WARN_RATIO;
}

/** v7.5 Gate 4: 账号层级硬限处理 — 跳过模型轮转, 直接账号切换
 *  与_handlePerModelRateLimit的关键区别: Gate 4是账号级, 换模型无效 */
async function _handleTierRateLimit(context, resetSeconds, details = {}) {
  _tierRateLimitCount++;
  const logPrefix = `[TIER_RL #${_tierRateLimitCount}]`;
  _logWarn('层级限流', `${logPrefix} 账号层级硬限! 小时消息=${_getHourlyMsgCount()}条, 冷却=${resetSeconds}s`);
  // 标记当前账号 — 3600s冷却("about an hour")
  const cooldown = resetSeconds || 3600;
  const currentModel = _readCurrentModelUid();
  const messageText = String(details.message || '');
  const isGlobalTrial = GLOBAL_TRIAL_RL_RE.test(messageText);
  am.markRateLimited(_activeIndex, cooldown, {
    model: 'all',
    trigger: details.trigger || 'tier_rate_limit',
    type: 'tier_cap',
  });
  _setAccountQuarantine(_activeIndex, cooldown, isGlobalTrial ? 'global_trial_rate_limit' : 'tier_cap', {
    trigger: details.trigger || 'tier_rate_limit',
  });
  if (isGlobalTrial) {
    _armTrialPoolCooldown(currentModel, Math.min(cooldown, GLOBAL_TRIAL_POOL_COOLDOWN_SEC), 'global_trial_rate_limit', {
      model: currentModel,
    });
    if (await _downgradeFromTrialPressure(`${logPrefix} Trial全局限流`)) {
      return { action: 'fallback_model', cooldown, to: SONNET_FALLBACK };
    }
  }
  _pushRateLimitEvent({
    type: 'tier_cap',
    trigger: details.trigger || 'tier_rate_limit',
    cooldown,
    hourlyMsgs: _getHourlyMsgCount(),
    globalTrial: isGlobalTrial,
  });
  // 直接账号轮转(跳过模型变体轮转 — 对Gate 4无效)
  _activateBoost();
  await _doPoolRotate(context, true);
  // 重置小时计数器(新账号从0开始)
  const runtime = _getAccountRuntime();
  if (runtime) runtime.hourlyMsgLog = [];
  return { action: 'tier_account_switch', cooldown };
}

/** v8.0 核心: Per-model rate limit 三级突破 (Opus优化版)
 *  Opus路径(v8.0): 跳过L1变体轮转(同桶无效) → 直接L2账号切换 → L3降级Sonnet
 *  非Opus路径: L1变体轮转 → L2账号切换 → L3降级
 *  核心洞察: Opus 6变体共享同一服务端rate limit桶(同底层API) → L1变体轮转=浪费5+秒
 */
async function _handlePerModelRateLimit(context, modelUid, resetSeconds) {
  _modelRateLimitCount++;
  const logPrefix = `[MODEL_RL #${_modelRateLimitCount}]`;
  // v8.0: Opus使用专用冷却时间(1500s/25min)，匹配实测22m50s
  const effectiveCooldown = _isOpusModel(modelUid) ? Math.max(resetSeconds || 0, OPUS_COOLDOWN_DEFAULT) : (resetSeconds || 1200);
  _logWarn('模型限流', `${logPrefix} 检测到模型级限流: 模型=${modelUid}, 服务端冷却=${resetSeconds}s, 实际冷却=${effectiveCooldown}s`);

  // 标记当前(account, model)为limited — Opus时标记所有变体(共享桶)
  if (_isOpusModel(modelUid)) {
    for (const variant of OPUS_VARIANTS) {
      am.markModelRateLimited(_activeIndex, variant, effectiveCooldown, { trigger: 'per_model_rate_limit' });
    }
    // v8.0: 重置该账号的Opus消息计数(已触发限流,计数器已失效)
    _resetOpusMsgLog(_activeIndex);
  } else {
    am.markModelRateLimited(_activeIndex, modelUid, effectiveCooldown, { trigger: 'per_model_rate_limit' });
  }

  // v8.0: Opus跳过L1变体轮转 — 6变体共享同一服务端桶，轮转浪费时间
  // 直接进入L2账号切换(不同apiKey = 不同桶 = 立即可用)
  if (_isOpusModel(modelUid)) {
    _logInfo('模型限流', `${logPrefix} Opus共享桶 → 跳过变体轮转, 直接切换账号`);
  } else {
    const modelVariants = _getModelVariants(modelUid);
    const availableVariant = modelVariants.length > 1
      ? am.findAvailableModelVariant(_activeIndex, modelVariants)
      : null;
    if (availableVariant && availableVariant !== modelUid) {
      _logInfo('模型限流', `${logPrefix} L1变体轮转: ${modelUid} → ${availableVariant}`);
      await _switchModelUid(availableVariant);
      return { action: 'variant_switch', from: modelUid, to: availableVariant };
    }
  }

  // === L2: 换账号继续用同模型 (核心: 不同apiKey = 不同rate limit桶) ===
  const threshold = _getPreemptiveThreshold();
  const modelCandidates = am.findBestForModel(
    modelUid,
    _activeIndex,
    threshold,
    _getOtherWindowAccountEmails(),
    { preferredMode: _getActiveSelectionMode() },
  );
  if (modelCandidates.length > 0) {
    const switchResult = await _performSwitch(context, {
      threshold,
      targetPolicy: 'same_model',
      modelUid,
      candidates: modelCandidates,
    });
    if (switchResult.ok) {
      _logInfo('模型限流', `${logPrefix} L2切换账号: → #${switchResult.index + 1} 继续使用${modelUid}`);
      _pushRateLimitEvent({ type: 'per_model', trigger: 'opus_guard_reactive', model: modelUid, cooldown: effectiveCooldown, switchTo: switchResult.index + 1 });
      return { action: 'account_switch', to: switchResult.index, model: modelUid };
    }
  }
  _logInfo('模型限流', `${logPrefix} L2全部不可用 → 尝试L3降级`);
 
  // === L3: 智能降级到Sonnet ===
  if (_isOpusModel(modelUid)) {
    _logWarn('模型限流', `${logPrefix} L3降级: 所有账号Opus均已限流 → 降级到${SONNET_FALLBACK}`);
    await _switchModelUid(SONNET_FALLBACK);
    await _doPoolRotate(context, true);
    return { action: 'fallback', from: modelUid, to: SONNET_FALLBACK };
  }

  // 非Opus模型: 直接账号轮转
  await _doPoolRotate(context, true);
  return { action: 'account_rotate', model: modelUid };
}

/** 切换Windsurf当前模型UID (写入state.vscdb windsurfConfigurations) */
async function _switchModelUid(targetUid) {
  if (!targetUid || Date.now() - _lastModelSwitch < 5000) return false;
  _lastModelSwitch = Date.now();
  try {
    // 通过VS Code命令切换模型
    await vscode.commands.executeCommand('windsurf.cascadeSetModel', targetUid);
    _currentModelUid = targetUid;
    _logInfo('模型切换', `✅ 已切换到: ${targetUid}`);
    return true;
  } catch (e1) {
    // 备用: 直接写state.vscdb
    try {
      if (auth && auth.writeModelSelection) {
        auth.writeModelSelection(targetUid);
        _currentModelUid = targetUid;
        _logInfo('模型切换', `✅ 已切换(DB直写): ${targetUid}`);
        return true;
      }
    } catch {}
    _logWarn('模型切换', `❌ 切换失败: ${targetUid}`, e1.message);
    return false;
  }
}

// ═══ 结构化日志系统 (v6.2 P1) ═══
function _log(level, tag, msg, data) {
  const ts = new Date().toLocaleTimeString();
  const prefix = `[${ts}] [${level}] [${tag}]`;
  const full =
    data !== undefined
      ? `${prefix} ${msg} ${JSON.stringify(data)}`
      : `${prefix} ${msg}`;
  // OutputChannel (用户可见)
  if (_outputChannel) _outputChannel.appendLine(full);
  // Console (开发者工具)
  if (level === "ERROR") console.error(`WAM: ${full}`);
  else console.log(`WAM: ${full}`);
  // 事件缓冲 (诊断用)
  _eventLog.push({
    ts: Date.now(),
    level,
    tag,
    msg: data !== undefined ? `${msg} ${JSON.stringify(data)}` : msg,
  });
  if (_eventLog.length > MAX_EVENT_LOG)
    _eventLog = _eventLog.slice(-MAX_EVENT_LOG);
}
function _logInfo(tag, msg, data) {
  _log("INFO", tag, msg, data);
}
function _logWarn(tag, msg, data) {
  _log("WARN", tag, msg, data);
}
function _logError(tag, msg, data) {
  _log("ERROR", tag, msg, data);
}

function _isBoost() {
  return Date.now() < _boostUntil;
}
function _activateBoost() {
  _boostUntil = Date.now() + BOOST_DURATION;
}

// ═══ 多窗口协调引擎 (v6.3 P0: 解决多窗口抢占同一账号的核心矛盾) ═══
// 原理: 每个Windsurf窗口是独立VS Code进程，号池引擎各自独立运行。
// 若不协调，所有窗口选同一"最优"账号 → N窗口×1账号 = N倍消耗 → rate limit命中加速。
// 解法: 共享状态文件，窗口注册+心跳+账号隔离，selectOptimal排除其他窗口占用。

/** 获取 Windsurf globalStorage 路径 (跨平台) */
function _getWindsurfGlobalStoragePath() {
  const p = process.platform;
  if (p === "win32") {
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appdata, "Windsurf", "User", "globalStorage");
  } else if (p === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Windsurf", "User", "globalStorage");
  }
  return path.join(os.homedir(), ".config", "Windsurf", "User", "globalStorage");
}

function _getWindowStatePath() {
  return path.join(_getWindsurfGlobalStoragePath(), WINDOW_STATE_FILE);
}

let _cachedWindowState = null; // 内存缓存，减少磁盘读取
let _cacheTs = 0;
const CACHE_TTL = 5000; // 缓存5s有效

function _readWindowState(forceRefresh = false) {
  if (
    !forceRefresh &&
    _cachedWindowState &&
    Date.now() - _cacheTs < CACHE_TTL
  ) {
    return JSON.parse(JSON.stringify(_cachedWindowState)); // 返回深拷贝防止外部修改
  }
  try {
    const p = _getWindowStatePath();
    if (!fs.existsSync(p)) return { windows: {} };
    const state = JSON.parse(fs.readFileSync(p, "utf8"));
    _cachedWindowState = state;
    _cacheTs = Date.now();
    return JSON.parse(JSON.stringify(state));
  } catch {
    return { windows: {} };
  }
}

function _writeWindowState(state) {
  try {
    const p = _getWindowStatePath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // 原子写入: 写临时文件 → rename，防止并发写入导致JSON损坏
    const tmp = p + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, p);
    _cachedWindowState = state;
    _cacheTs = Date.now();
  } catch (e) {
    // rename失败时降级为直写
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

function _registerWindow(accountIndex) {
  _windowId = `w${process.pid}-${Date.now().toString(36)}`;
  const state = _readWindowState(true);
  const account = am ? am.get(accountIndex) : null;
  state.windows[_windowId] = {
    accountIndex,
    accountEmail: account?.email || null,
    lastHeartbeat: Date.now(),
    pid: process.pid,
    startedAt: Date.now(),
  };
  _writeWindowState(state);
  _logInfo("窗口协调", `本窗口注册: ${_windowId} → 使用账号#${accountIndex + 1} (${account?.email?.split('@')[0] || '未登录'})`);
}

function _heartbeatWindow() {
  if (!_windowId) return;
  const state = _readWindowState();
  if (!state.windows[_windowId]) {
    state.windows[_windowId] = { pid: process.pid, startedAt: Date.now() };
  }
  state.windows[_windowId].accountIndex = _activeIndex;
  state.windows[_windowId].accountEmail = am?.get(_activeIndex)?.email || null;
  state.windows[_windowId].lastHeartbeat = Date.now();
  const now = Date.now();
  for (const [id, w] of Object.entries(state.windows)) {
    if (now - w.lastHeartbeat > WINDOW_DEAD_MS) delete state.windows[id];
  }
  _writeWindowState(state);
}

function _deregisterWindow() {
  if (!_windowId) return;
  try {
    const state = _readWindowState(true); // 注销时强制刷新
    delete state.windows[_windowId];
    _writeWindowState(state);
    _logInfo("窗口协调", `本窗口注销: ${_windowId}`);
  } catch {}
}

/** 获取其他活跃窗口占用的账号索引 */
function _getOtherWindowAccountEmails() {
  if (!_windowId) return [];
  const state = _readWindowState();
  const now = Date.now();
  const claimed = [];
  for (const [id, w] of Object.entries(state.windows)) {
    if (id === _windowId) continue;
    if (now - w.lastHeartbeat > WINDOW_DEAD_MS) continue;
    if (w.accountEmail) claimed.push(_normalizeEmail(w.accountEmail));
  }
  return claimed;
}

/** 获取活跃窗口数(含自身) */
function _getActiveWindowCount() {
  const state = _readWindowState();
  const now = Date.now();
  return Object.values(state.windows).filter(
    (w) => now - w.lastHeartbeat <= WINDOW_DEAD_MS,
  ).length;
}

function _startWindowCoordinator(context) {
  _registerWindow(_activeIndex);
  _windowTimer = setInterval(() => _heartbeatWindow(), WINDOW_HEARTBEAT_MS);
  context.subscriptions.push({
    dispose: () => {
      if (_windowTimer) {
        clearInterval(_windowTimer);
        _windowTimer = null;
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

// ═══ 并发Tab感知引擎 (v6.4 P0) ═══

/** 探测当前窗口活跃Cascade对话数
 *  策略: 多层探测，取最高值
 *  L1: VS Code tabGroups API (最准确 — 直接枚举所有打开的Tab)
 *  L2: editor文档计数 (降级方案)
 *  L3: 窗口标题推断 (最后手段) */
function _detectCascadeTabs() {
  const now = Date.now();
  if (now - _lastTabCheck < TAB_CHECK_INTERVAL) return _cascadeTabCount;
  _lastTabCheck = now;

  let count = 0;
  try {
    // L1: tabGroups API — 精确枚举所有打开的tab
    if (vscode.window.tabGroups) {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          // Cascade tabs have specific viewType or label patterns
          const label = (tab.label || "").toLowerCase();
          const inputUri =
            tab.input && tab.input.uri ? tab.input.uri.toString() : "";
          if (
            label.includes("cascade") ||
            label.includes("chat") ||
            inputUri.includes("cascade") ||
            inputUri.includes("chat") ||
            (tab.input &&
              tab.input.viewType &&
              /cascade|chat|copilot/i.test(tab.input.viewType))
          ) {
            count++;
          }
        }
      }
    }
  } catch {}

  // L2: 如果tabGroups检测不到，用活跃编辑器数做保守估计
  // (用户通常每个Tab对应一个并行任务，多个可见编辑器≈多个并行对话)
  if (count === 0) {
    try {
      const visibleEditors = vscode.window.visibleTextEditors.length;
      // 保守估计: 至少有1个cascade tab (我们知道有因为检测到了rate limit)
      if (visibleEditors > 1)
        count = Math.max(1, Math.floor(visibleEditors / 2));
    } catch {}
  }

  // L3: context key探测 — 如果任何quota/rate context key为true，至少1个活跃对话
  if (count === 0) count = 1; // 至少1个(插件本身在运行)

  const prev = _cascadeTabCount;
  _cascadeTabCount = count;
  if (count !== prev) {
    _logInfo(
      "对话感知",
      `并发对话数: ${prev} → ${count}${count > CONCURRENT_TAB_SAFE ? " ⚠️ 超过安全阈值!" : ""}`,
    );
    // 进入/退出burst防护模式
    if (count > CONCURRENT_TAB_SAFE && !_burstMode) {
      _burstMode = true;
      _activateBoost(); // 立即加速轮询
      _logWarn(
        "对话感知",
        `🔥 BURST防护开启 — 检测到${count}个并发对话, 加速轮询+预防性轮转`,
      );
    } else if (count <= CONCURRENT_TAB_SAFE && _burstMode) {
      _burstMode = false;
      _logInfo("对话感知", "BURST防护关闭 — 并发数回到安全水平");
    }
  }
  return count;
}

/** 记录一次消息/请求事件(每次quota变化≈一次API消息) */
function _trackMessageRate() {
  const runtime = _getAccountRuntime();
  if (!runtime) return;
  runtime.msgRateLog.push({ ts: Date.now() });
  const cutoff = Date.now() - MSG_RATE_WINDOW;
  runtime.msgRateLog = runtime.msgRateLog.filter((m) => m.ts > cutoff);
}

/** 获取当前消息速率(条/分钟) */
function _getCurrentMsgRate() {
  const runtime = _getAccountRuntime(_activeIndex, false);
  if (!runtime) return 0;
  const cutoff = Date.now() - MSG_RATE_WINDOW;
  const recent = runtime.msgRateLog.filter((m) => m.ts > cutoff);
  return recent.length; // 直接等于条/分钟(窗口是60s)
}

/** 判断是否接近消息速率上限 */
function _isNearMsgRateLimit() {
  const rate = _getCurrentMsgRate();
  const tabAdjustedLimit = Math.max(
    3,
    MSG_RATE_LIMIT / Math.max(1, _cascadeTabCount),
  );
  return rate >= tabAdjustedLimit * BURST_DETECT_THRESHOLD;
}

/** 获取当前最优轮询间隔(自适应: 正常→加速→burst) */
function _getAdaptivePollMs() {
  if (_burstMode) return POLL_BURST;
  if (_isBoost()) return POLL_BOOST;
  return POLL_NORMAL;
}

function activate(context) {
  // 仅在 Windsurf 中激活，VS Code 等其他宿主静默跳过
  const appName = (vscode.env.appName || '').toLowerCase();
  if (!appName.includes('windsurf')) {
    return;
  }
  try {
    _activate(context);
  } catch (e) {
    _logError("启动", "激活失败", e.message);
  }
}

function _activate(context) {
  // 设置上下文键，让 package.json 的 when 条件生效（侧边栏/命令仅 Windsurf 可见）
  vscode.commands.executeCommand('setContext', 'windsurf-tools.active', true);

  // ═══ 结构化日志通道 (v6.2 P1: 用户可见) ═══
  _outputChannel = vscode.window.createOutputChannel("Fuck 小助手");
  context.subscriptions.push(_outputChannel);
  _logInfo(
    "启动",
    "WAM 号池引擎 v13.1 启动中...",
  );

  // 指纹完整性
  try {
    const r = ensureFingerprintComplete();
    if (r.fixed.length > 0) _logInfo("指纹", `已补全缺失的设备ID: ${r.fixed.join(", ")}`);
  } catch (e) {
    _logWarn("指纹", "补全检查跳过", e.message);
  }

  const storagePath = context.globalStorageUri.fsPath;
  am = new AccountManager(storagePath);
  auth = new AuthService(storagePath);
  am.startWatching();

  // ═══ 状态栏：号池视图 ═══
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = "wam.openPanel";
  statusBar.tooltip = "号池管理 · 点击查看";
  context.subscriptions.push(statusBar);

  // 恢复状态
  const savedIndex = context.globalState.get("wam-current-index", -1);
  const accounts = am.getAll();
  if (savedIndex >= 0 && savedIndex < accounts.length)
    _activeIndex = savedIndex;
  _updatePoolBar();
  statusBar.show();

  // 恢复代理
  const savedMode = context.globalState.get("wam-proxy-mode", null);
  if (savedMode) auth.setMode(savedMode);

  // 后台代理探测
  setTimeout(() => {
    if (!auth) return;
    auth
      .reprobeProxy()
      .then((r) => {
        if (r.port > 0) context.globalState.update("wam-proxy-mode", r.mode);
        _updatePoolBar();
        _logInfo("代理", `探测完成 → 模式:${r.mode} 端口:${r.port}`);
      })
      .catch((e) => {
        _logWarn("代理", "探测失败", e.message);
      });
  }, 1200);

  // ═══ 侧边栏 ═══
  const sidebarProvider = new AccountViewProvider(
    context.extensionUri,
    am,
    auth,
    (action, arg) => _handleAction(context, action, arg),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "windsurf-assistant.assistantView",
      sidebarProvider,
    ),
  );
  _panelProvider = sidebarProvider;

  // ═══ 命令集 (精简 — 用户无需感知单个账号) ═══
  context.subscriptions.push(
    vscode.commands.registerCommand("wam.switchAccount", () =>
      _doPoolRotate(context),
    ),
    vscode.commands.registerCommand("wam.refreshCredits", () =>
      _doRefreshPool(context),
    ),
    vscode.commands.registerCommand("wam.openPanel", () => {
      const result = openAccountPanel(
        context,
        am,
        auth,
        (a, b) => _handleAction(context, a, b),
        _panel,
      );
      if (result) _panel = result.panel;
    }),
    vscode.commands.registerCommand("wam.switchMode", () =>
      _doSwitchMode(context),
    ),
    vscode.commands.registerCommand("wam.reprobeProxy", async () => {
      const r = await auth.reprobeProxy();
      context.globalState.update("wam-proxy-mode", r.mode);
      _updatePoolBar();
    }),
    vscode.commands.registerCommand("wam.resetFingerprint", () =>
      _doResetFingerprint(),
    ),
    vscode.commands.registerCommand("wam.panicSwitch", () =>
      _doPoolRotate(context, true),
    ),
    vscode.commands.registerCommand("wam.batchAdd", () => _doBatchAdd()),
    vscode.commands.registerCommand("wam.refreshAllCredits", () =>
      _doRefreshPool(context),
    ),
    vscode.commands.registerCommand("wam.smartRotate", () =>
      _doPoolRotate(context),
    ),
    vscode.commands.registerCommand("wam.importAccounts", () =>
      _doImport(context),
    ),
    vscode.commands.registerCommand("wam.initWorkspace", () =>
      _doInitWorkspace(context),
    ),
  );

  // ═══ 号池引擎启动 ═══
  _startPoolEngine(context);
  // ═══ 多窗口协调 (v6.3) ═══
  _startWindowCoordinator(context);
  // ═══ 并发Tab感知 (v6.4) ═══
  _detectCascadeTabs();
  const proxyInfo = auth.getProxyStatus();
  const winCount = _getActiveWindowCount();
  _logInfo(
    "启动",
    `✅ 号池引擎就绪 v13.1 | 账号: ${accounts.length}个 | 代理: ${proxyInfo.mode}:${proxyInfo.port} | 窗口: ${winCount}个 | 对话: ${_cascadeTabCount}个${_burstMode ? ' (BURST防护)' : ''} | Opus预算: T1M=${OPUS_THINKING_1M_BUDGET}/T=${OPUS_THINKING_BUDGET}/R=${OPUS_REGULAR_BUDGET}条`,
  );
  _logInfo(
    "启动",
    `检测层: L1=上下文键(2s) L3=缓存配额(10s) L5=gRPC探测(Thinking:3s/加速:15s/正常:45s) | Trial防御+模型降级`,
  );
}

// ========== Refresh Helpers (deduplicated from 8 call sites) ==========

/** Refresh one account's usage/credits. Returns { credits, usageInfo }
 *  v5.11.0: Supplements QUOTA data from cachedPlanInfo when API doesn't return daily% */
async function _refreshOne(index) {
  const account = am.get(index);
  if (!account) return { credits: undefined };
  try {
    const usageInfo = await auth.getUsageInfo(account.email, account.password);
    if (usageInfo) {
      // v5.11.0+v6.9: Supplement from cachedPlanInfo for active account (single read)
      if (index === _activeIndex && auth) {
        try {
          const cached = auth.readCachedQuota();
          if (cached) {
            // Supplement daily% if billingStrategy=quota but API didn't return it
            if (usageInfo.billingStrategy === "quota" && !usageInfo.daily && cached.daily !== null) {
              usageInfo.daily = {
                used: Math.max(0, 100 - cached.daily),
                total: 100,
                remaining: cached.daily,
              };
              if (cached.weekly !== null)
                usageInfo.weekly = {
                  used: Math.max(0, 100 - cached.weekly),
                  total: 100,
                  remaining: cached.weekly,
                };
              if (cached.resetTime) usageInfo.resetTime = cached.resetTime;
              if (cached.weeklyReset) usageInfo.weeklyReset = cached.weeklyReset;
              if (cached.extraBalance)
                usageInfo.extraBalance = cached.extraBalance;
              usageInfo.mode = "quota";
              _logInfo(
                "额度补充",
                `#${index + 1} 从缓存配额补充: 天=${cached.daily}% 周=${cached.weekly}%`,
              );
            }
            // Always supplement plan dates (official alignment)
            if (cached.planStart && !usageInfo.planStart)
              usageInfo.planStart = cached.planStart;
            if (cached.planEnd && !usageInfo.planEnd)
              usageInfo.planEnd = cached.planEnd;
            if (cached.plan && !usageInfo.plan) usageInfo.plan = cached.plan;
          }
        } catch {}
      }
      am.updateUsage(index, usageInfo);
      return { credits: usageInfo.credits, usageInfo };
    }
  } catch {}
  try {
    const credits = await auth.getCredits(account.email, account.password);
    if (credits !== undefined) am.updateCredits(index, credits);
    return { credits };
  } catch {}
  return { credits: undefined };
}

/** Refresh all accounts with parallel batching. Optional progress callback(i, total).
 *  Concurrency=3 balances speed vs API rate limits. ~3x faster than sequential. */
async function _refreshAll(progressFn) {
  const accounts = am.getAll();
  const CONCURRENCY = 3;
  let completed = 0;
  for (let batch = 0; batch < accounts.length; batch += CONCURRENCY) {
    const slice = accounts.slice(batch, batch + CONCURRENCY);
    const promises = slice.map((_, j) => {
      const idx = batch + j;
      return _refreshOne(idx).then(() => {
        completed++;
        if (progressFn) progressFn(completed - 1, accounts.length);
      });
    });
    await Promise.allSettled(promises);
  }
}

// ========== 号池引擎 (v6.0 核心) ==========

function _getOrderedCandidates({
  excludeIndex = _activeIndex,
  threshold = _getPreemptiveThreshold(),
  targetPolicy = 'same_strategy',
  modelUid = null,
  excludeClaimed = true,
} = {}) {
  const preferredMode = targetPolicy === 'same_strategy' || targetPolicy === 'same_model'
    ? _getActiveSelectionMode()
    : null;
  const excludedEmails = excludeClaimed ? _getOtherWindowAccountEmails() : [];
  const options = { preferredMode, modelUid };
  const primary = modelUid
    ? am.findBestForModel(modelUid, excludeIndex, threshold, excludedEmails, options)
    : am.selectOptimal(excludeIndex, threshold, excludedEmails, options);
  const filteredPrimary = _filterRuntimeCandidates(primary, { modelUid });
  if (filteredPrimary.length > 0 || !excludeClaimed) return filteredPrimary;
  const fallback = modelUid
    ? am.findBestForModel(modelUid, excludeIndex, threshold, [], options)
    : am.selectOptimal(excludeIndex, threshold, [], options);
  return _filterRuntimeCandidates(fallback, { modelUid });
}

function _recordTrialGuardDrop(prevQuota, curQuota) {
  const runtime = _getAccountRuntime();
  if (!runtime) {
    return { confirmed: false, consecutiveDrops: 0, quotaDrop: 0 };
  }
  const now = Date.now();
  if (now - runtime.trialGuard.lastDropTs > TRIAL_GUARD_CONFIRM_WINDOW) {
    runtime.trialGuard.consecutiveDrops = 0;
  }
  runtime.trialGuard.consecutiveDrops += 1;
  runtime.trialGuard.lastDropTs = now;
  runtime.trialGuard.lastQuota = curQuota;
  const quotaDrop = prevQuota !== null && curQuota !== null ? prevQuota - curQuota : 0;
  const currentModel = _readCurrentModelUid();
  const confirmed =
    quotaDrop >= TRIAL_GUARD_SINGLE_CONFIRM_DROP ||
    runtime.trialGuard.consecutiveDrops >= 2 ||
    _isNearTierCap() ||
    (_isOpusModel(currentModel) && _isNearOpusBudget(_activeIndex));
  return {
    confirmed,
    consecutiveDrops: runtime.trialGuard.consecutiveDrops,
    quotaDrop,
  };
}

async function _downgradeFromTrialPressure(reason) {
  const currentModel = _readCurrentModelUid();
  if (!_isOpusModel(currentModel) || currentModel === SONNET_FALLBACK) return false;
  const switched = await _switchModelUid(SONNET_FALLBACK);
  if (switched) {
    // v13.1: 降级成功后彻底清理Opus守卫状态,防止残留触发循环
    _downgradeLockUntil = Date.now() + 120000; // 120s降级锁,防止DB读取覆盖回Opus
    _resetOpusMsgLog(_activeIndex); // 清Opus消息计数
    for (const variant of OPUS_VARIANTS) {
      am.clearModelRateLimit && am.clearModelRateLimit(_activeIndex, variant);
    }
    _logWarn('模型降级', `${reason} → 降级到${SONNET_FALLBACK}，避免Trial账号互切 (降级锁120s)`);
  }
  return switched;
}

async function _validateSwitchCandidate(targetIndex, threshold) {
  if (_isAccountQuarantined(targetIndex)) {
    return { ok: false, remaining: null, reason: 'account_quarantined' };
  }
  const trialPoolCooldown = _getTrialPoolCooldown(_readCurrentModelUid());
  if (trialPoolCooldown && _isTrialLikeAccount(targetIndex)) {
    return { ok: false, remaining: null, reason: 'trial_pool_cooldown' };
  }
  try {
    await Promise.race([
      _refreshOne(targetIndex),
      new Promise((_, reject) => setTimeout(() => reject(new Error('preheat_timeout')), 5000)),
    ]);
    if (am.isRateLimited(targetIndex)) {
      return { ok: false, remaining: null, reason: 'rate_limited' };
    }
    const remaining = am.effectiveRemaining(targetIndex);
    if (remaining !== null && remaining <= threshold) {
      return { ok: false, remaining, reason: 'insufficient_quota' };
    }
    return { ok: true, remaining };
  } catch (e) {
    return { ok: false, remaining: null, reason: e.message };
  }
}

async function _performSwitch(context, {
  excludeIndex = _activeIndex,
  threshold = _getPreemptiveThreshold(),
  targetPolicy = 'same_strategy',
  panic = false,
  refreshPool = false,
  modelUid = null,
  candidates = null,
  allowThresholdFallback = false,
} = {}) {
  if (refreshPool) await _refreshAll();
  let ordered = Array.isArray(candidates) && candidates.length > 0
    ? _filterRuntimeCandidates(candidates, { modelUid })
    : _getOrderedCandidates({ excludeIndex, threshold, targetPolicy, modelUid, excludeClaimed: true });
  if (ordered.length === 0 && allowThresholdFallback && threshold > 0) {
    ordered = _getOrderedCandidates({ excludeIndex, threshold: 0, targetPolicy, modelUid, excludeClaimed: false });
  }
  if (ordered.length === 0 && !modelUid && _getTrialPoolCooldown(_readCurrentModelUid())) {
    const downgraded = await _downgradeFromTrialPressure('Trial候选池冷却中');
    if (downgraded) {
      ordered = _getOrderedCandidates({
        excludeIndex,
        threshold,
        targetPolicy,
        modelUid: SONNET_FALLBACK,
        excludeClaimed: true,
      });
      if (ordered.length === 0 && allowThresholdFallback && threshold > 0) {
        ordered = _getOrderedCandidates({
          excludeIndex,
          threshold: 0,
          targetPolicy,
          modelUid: SONNET_FALLBACK,
          excludeClaimed: false,
        });
      }
    }
  }
  for (const candidate of ordered) {
    const preheat = await _validateSwitchCandidate(candidate.index, threshold);
    if (!preheat.ok) {
      _logWarn('切换', `预热跳过 #${candidate.index + 1}: ${preheat.reason}${preheat.remaining !== null ? ` (${preheat.remaining}%≤${threshold}%)` : ''}`);
      continue;
    }
    const switched = await _seamlessSwitch(context, candidate.index);
    if (switched) return { ok: true, index: candidate.index, candidate };
  }
  if (!panic) _logWarn('切换', '候选账号全部预热失败或不可切换');
  return { ok: false, index: -1 };
}

function evaluateActiveAccount({ accounts, threshold, curQuota }) {
  const decision = { action: 'none', reason: 'ok', cooldown: null, targetPolicy: 'same_strategy' };
  const capacity = _getCapacityState(_activeIndex, false);
  const lastCapacityResult = capacity?.lastResult || null;
  const lastCapacityCheck = capacity?.lastCheck || 0;
  const realMaxMessages = capacity?.realMaxMessages ?? -1;
  const l5Valid = lastCapacityResult &&
    lastCapacityResult.messagesRemaining >= 0 &&
    (Date.now() - lastCapacityCheck < 120000);

  if (l5Valid && !lastCapacityResult.hasCapacity) {
    decision.action = 'switch_account';
    decision.reason = `L5_no_capacity(remaining=${lastCapacityResult.messagesRemaining}/${lastCapacityResult.maxMessages},resets=${lastCapacityResult.resetsInSeconds}s)`;
    return decision;
  }

  if (l5Valid && lastCapacityResult.hasCapacity) {
    const capMax = lastCapacityResult.maxMessages > 0 ? lastCapacityResult.maxMessages : TIER_MSG_CAP_ESTIMATE;
    const capRem = lastCapacityResult.messagesRemaining;
    if (capRem <= CAPACITY_PREEMPT_REMAINING || (capMax > 0 && capRem <= capMax * 0.2)) {
      decision.action = 'switch_account';
      decision.reason = `L5_capacity_low(remaining=${capRem}/${capMax},resets=${lastCapacityResult.resetsInSeconds}s)`;
      return decision;
    }
  }

  const baseDecision = am.shouldSwitch(_activeIndex, threshold);
  if (baseDecision.switch) {
    decision.action = 'switch_account';
    decision.reason = baseDecision.reason;
    return decision;
  }

  if (am.isRateLimited(_activeIndex)) {
    decision.action = 'switch_account';
    decision.reason = 'rate_limited';
    return decision;
  }

  if (curQuota !== null && curQuota > threshold) {
    const currentModel = _readCurrentModelUid();
    // v13.1: 降级锁生效期间或当前模型已非Opus时,跳过Opus守卫
    if (_isOpusModel(currentModel) && _downgradeLockUntil <= Date.now() && _isNearOpusBudget(_activeIndex)) {
      const opusCount = _getOpusMsgCount(_activeIndex);
      const tierBudget = _getModelBudget(currentModel);
      decision.action = 'switch_account';
      decision.reason = `opus_budget_guard(model=${currentModel},msgs=${opusCount}/${tierBudget},tier=${_isThinking1MModel(currentModel) ? 'T1M' : _isThinkingModel(currentModel) ? 'T' : 'R'})`;
      return decision;
    }
  }

  if (
    curQuota !== null &&
    curQuota > threshold &&
    Date.now() - _lastUfefSwitchTs > UFEF_COOLDOWN
  ) {
    const activeUrg = am.getExpiryUrgency(_activeIndex);
    if (activeUrg >= 2 || activeUrg < 0) {
      for (let i = 0; i < accounts.length; i++) {
        if (i === _activeIndex) continue;
        if (am.isRateLimited(i) || am.isExpired(i)) continue;
        const iUrg = am.getExpiryUrgency(i);
        const iRem = am.effectiveRemaining(i);
        if (iUrg === 0 && iRem !== null && iRem > threshold) {
          decision.action = 'switch_account';
          decision.reason = `ufef_urgent(active_urg=${activeUrg},#${i + 1}_urg=${iUrg},#${i + 1}_rem=${iRem},#${i + 1}_days=${am.getPlanDaysRemaining(i)})`;
          decision.targetPolicy = 'quota_first';
          return decision;
        }
      }
    }
  }

  if (!l5Valid) {
    if (curQuota !== null && curQuota > threshold) {
      const predicted = _slopePredict();
      if (predicted !== null && predicted <= threshold) {
        decision.action = 'switch_account';
        decision.reason = `fallback_slope(cur=${curQuota},pred=${predicted})`;
        return decision;
      }
    }
    if (_burstMode && _isNearMsgRateLimit()) {
      decision.action = 'switch_account';
      decision.reason = `fallback_burst(tabs=${_cascadeTabCount},rate=${_getCurrentMsgRate()}/${MSG_RATE_LIMIT})`;
      return decision;
    }
    if (_cascadeTabCount > CONCURRENT_TAB_SAFE && curQuota !== null) {
      const dynamicThreshold = threshold + (_cascadeTabCount - CONCURRENT_TAB_SAFE) * 5;
      if (curQuota <= dynamicThreshold && curQuota > threshold) {
        decision.action = 'switch_account';
        decision.reason = `fallback_tab_pressure(tabs=${_cascadeTabCount},cur=${curQuota},dyn=${dynamicThreshold})`;
        return decision;
      }
    }
    if (_isHighVelocity() && curQuota !== null && curQuota > threshold) {
      const vel = _getVelocity();
      decision.action = 'switch_account';
      decision.reason = `fallback_velocity(vel=${vel.toFixed(1)}%/min,cur=${curQuota})`;
      return decision;
    }
    if (curQuota !== null && curQuota > threshold && _isNearTierCap()) {
      const effectiveCap = realMaxMessages > 0 ? realMaxMessages : TIER_MSG_CAP_ESTIMATE;
      decision.action = 'switch_account';
      decision.reason = `fallback_tier_cap(hourly=${_getHourlyMsgCount()}/${effectiveCap})`;
      return decision;
    }
  }

  return decision;
}

/** 启动号池引擎 — 自适应轮询 + 自动选号 + 实时监控 + 并发Tab感知(v6.4) */
function _startPoolEngine(context) {
  const scheduleNext = () => {
    const ms = _getAdaptivePollMs();
    _poolTimer = setTimeout(async () => {
      try {
        await _poolTick(context);
      } catch (e) {
        _logError("号池", "心跳异常", e.message);
      }
      scheduleNext();
    }, ms);
  };
  setTimeout(async () => {
    await _poolTick(context);
    scheduleNext();
  }, 3000);
  _startQuotaWatcher(context);
}

/** 号池心跳 — 每次tick检查活跃账号，必要时自动轮转 */
async function _poolTick(context) {
  const accounts = am.getAll();
  if (accounts.length === 0) return;

  _detectCascadeTabs();

  const autoRotate = vscode.workspace.getConfiguration("wam").get("autoRotate", true);
  const threshold = _getPreemptiveThreshold();

  if (_activeIndex < 0 || _activeIndex >= accounts.length) {
    const switchResult = await _performSwitch(context, {
      excludeIndex: -1,
      threshold,
      targetPolicy: 'quota_first',
    });
    if (!switchResult.ok) _logWarn("号池", "无活跃账号且无可用账号");
    return;
  }

  if (am.isExpired(_activeIndex)) {
    _logWarn("号池", `活跃账号 #${_activeIndex + 1} 已过期 → 立即轮转`);
    if (autoRotate) {
      await _performSwitch(context, { threshold, targetPolicy: 'same_strategy' });
    }
    return;
  }

  const prevQuota = _lastQuota;
  await _refreshOne(_activeIndex);
  const curQuota = am.effectiveRemaining(_activeIndex);
  _lastQuota = curQuota;
  _lastCheckTs = Date.now();

  const runtime = _getAccountRuntime();
  if (runtime && curQuota !== null && curQuota !== undefined) {
    runtime.quotaHistory.push({ ts: Date.now(), remaining: curQuota });
    if (runtime.quotaHistory.length > SLOPE_WINDOW * 2) {
      runtime.quotaHistory = runtime.quotaHistory.slice(-SLOPE_WINDOW);
    }
  }

  const quotaChanged = prevQuota !== null && prevQuota !== undefined && curQuota !== prevQuota;
  if (curQuota !== null) _trackVelocity(curQuota);
  if (quotaChanged) {
    _trackMessageRate();
    _trackHourlyMsg();
    if (curQuota < prevQuota) {
      const currentModel = _readCurrentModelUid();
      if (_isOpusModel(currentModel)) {
        _trackOpusMsg(_activeIndex);
        const opusCount = _getOpusMsgCount(_activeIndex);
        const tierBudget = _getModelBudget(currentModel);
        const tierLabel = _isThinking1MModel(currentModel) ? 'Thinking-1M' : _isThinkingModel(currentModel) ? 'Thinking' : 'Regular';
        _logInfo('Opus守卫', `#${_activeIndex + 1} 已发${opusCount}/${tierBudget}条 (${tierLabel})${opusCount >= tierBudget ? ' → 达到预算上限,即将切号!' : ''}`);
      }
    }
    const vel = _getVelocity();
    const acct = am.get(_activeIndex);
    const emailPrefix = acct?.email?.split('@')[0] || '?';
    const quotaDelta = curQuota - prevQuota;
    _logInfo("额度监控", `#${_activeIndex + 1} ${emailPrefix}: ${prevQuota}% → ${curQuota}% (${quotaDelta > 0 ? '+' : ''}${quotaDelta}) | 消息速率=${_getCurrentMsgRate()}条/min 消耗速度=${vel.toFixed(1)}%/min 并发对话=${_cascadeTabCount}`);
    _activateBoost();
    _updatePoolBar();
    _refreshPanel();

    const activeCapacity = _getCapacityState(_activeIndex, false);
    const isNoData = activeCapacity?.lastResult && activeCapacity.lastResult.messagesRemaining < 0;
    const currentModel = _readCurrentModelUid();
    const downgradeLockActive = _downgradeLockUntil > 0 && Date.now() < _downgradeLockUntil;
    const isOnSonnet = !_isOpusModel(currentModel);
    const trialGuardInCooldown = Date.now() - _lastTrialGuardActionTs < TRIAL_GUARD_COOLDOWN_MS;

    // v14.0: TRIAL_GUARD 跳过条件:
    //   1. 降级锁生效中 — 已降级到Sonnet,正常Sonnet消耗不应触发
    //   2. 当前已在Sonnet — Sonnet消耗是预期行为
    //   3. TRIAL_GUARD冷却中 — 避免5min内重复触发噪音
    if (curQuota < prevQuota && isNoData && autoRotate && accounts.length > 1) {
      if (downgradeLockActive || isOnSonnet) {
        // 已降级到Sonnet,额度下降是正常Sonnet消耗,静默跳过
      } else if (trialGuardInCooldown) {
        // TRIAL_GUARD冷却中,跳过避免重复触发
      } else {
        const trialGuard = _recordTrialGuardDrop(prevQuota, curQuota);
        if (!trialGuard.confirmed) {
          _logInfo(
            'Trial防御',
            `⚙️ 第${trialGuard.consecutiveDrops}次下降(需≥2次确认): 额度${prevQuota}%→${curQuota}% 且L5无精确数据 → 等待二次确认避免误切`,
          );
        } else {
          _lastTrialGuardActionTs = Date.now(); // 设置冷却,防止5min内重复触发
          _logWarn(
            'Trial防御',
            `⚠️ 确认Trial限流! 连续${trialGuard.consecutiveDrops}次额度下降(${prevQuota}%→${curQuota}%) + L5无精确数据 → 启动Trial池冷却+账号隔离`,
          );
          // v14.0: 仅在池冷却未激活时才arm,避免重复重置冷却计时器
          if (!_getTrialPoolCooldown(currentModel)) {
            _armTrialPoolCooldown(currentModel, GLOBAL_TRIAL_POOL_COOLDOWN_SEC, 'trial_nodata_guard', {
              trigger: 'trial_nodata_guard',
              source: 'trial_guard',
            });
          }
          _pushRateLimitEvent({
            type: 'tier_cap',
            trigger: 'trial_nodata_guard',
            cooldown: TRIAL_GUARD_ACCOUNT_QUARANTINE_SEC,
            model: currentModel,
            globalTrial: false,
            trialPoolCooldown: GLOBAL_TRIAL_POOL_COOLDOWN_SEC,
            quotaDrop: trialGuard.quotaDrop,
          });
          if (_isOpusModel(currentModel)) {
            const downgraded = await _downgradeFromTrialPressure('[TRIAL_GUARD] Trial压力确认');
            if (downgraded) {
              _activateBoost();
              _resetTrialGuard(_activeIndex);
              _updatePoolBar();
              _refreshPanel();
              return;
            }
          }
          // v14.0: 仅在未隔离时才标记,避免重复重置隔离计时器
          if (!_isAccountQuarantined(_activeIndex)) {
            am.markRateLimited(_activeIndex, TRIAL_GUARD_ACCOUNT_QUARANTINE_SEC, {
              type: 'tier_cap',
              trigger: 'trial_nodata_guard',
              serverReset: false,
            });
            _setAccountQuarantine(_activeIndex, TRIAL_GUARD_ACCOUNT_QUARANTINE_SEC, 'trial_nodata_guard', {
              model: currentModel,
            });
          }
          const trialSwitch = await _performSwitch(context, {
            threshold,
            targetPolicy: 'same_strategy',
          });
          if (trialSwitch.ok) return;
        }
      }
    } else if (!isNoData) {
      _resetTrialGuard(_activeIndex);
    }
  }

  const quotaDrop = prevQuota !== null && curQuota !== null ? prevQuota - curQuota : 0;
  if (
    quotaChanged &&
    curQuota < prevQuota &&
    quotaDrop >= REACTIVE_DROP_MIN &&
    autoRotate &&
    Date.now() - _lastReactiveSwitchTs > REACTIVE_SWITCH_CD
  ) {
    const otherClaimed = new Set(_getOtherWindowAccountEmails());
    const stableCandidates = [];
    for (let i = 0; i < accounts.length; i++) {
      if (i === _activeIndex) continue;
      const email = _normalizeEmail(accounts[i]?.email);
      if (!email || otherClaimed.has(email)) continue;
      if (am.isRateLimited(i) || am.isExpired(i)) continue;
      const rem = am.effectiveRemaining(i);
      if (rem === null || rem === undefined || rem <= threshold) continue;
      const snap = _allQuotaSnapshot.get(i);
      if ((snap && snap.remaining === rem) || !snap) {
        stableCandidates.push({ index: i, remaining: rem });
      }
    }
    if (stableCandidates.length > 0) {
      stableCandidates.sort((a, b) => {
        const aUrg = am.getExpiryUrgency(a.index);
        const bUrg = am.getExpiryUrgency(b.index);
        const aTier = aUrg < 0 ? 2 : aUrg;
        const bTier = bUrg < 0 ? 2 : bUrg;
        if (aTier !== bTier) return aTier - bTier;
        return b.remaining - a.remaining;
      });
      _lastReactiveSwitchTs = Date.now();
      const reactiveSwitch = await _performSwitch(context, {
        threshold,
        targetPolicy: 'quota_first',
        candidates: stableCandidates,
      });
      if (reactiveSwitch.ok) return;
    }
  }

  const fullScanInterval = _burstMode ? FULL_SCAN_INTERVAL_BURST : _isBoost() ? FULL_SCAN_INTERVAL_BOOST : FULL_SCAN_INTERVAL_NORMAL;
  if (Date.now() - _lastFullScanTs > fullScanInterval) {
    _lastFullScanTs = Date.now();
    _logInfo("全池扫描", `开始刷新全部${accounts.length}个账号额度...`);
    await _refreshAll();
    for (let i = 0; i < accounts.length; i++) {
      const rem = am.effectiveRemaining(i);
      const prev = _allQuotaSnapshot.get(i);
      if (prev && prev.remaining !== rem) {
        const acct = am.get(i);
        const emailPrefix = acct?.email?.split('@')[0] || '?';
        const delta = rem !== null && prev.remaining !== null ? rem - prev.remaining : null;
        const deltaStr = delta !== null ? ` (${delta > 0 ? '+' : ''}${delta})` : '';
        _logInfo("全池扫描", `#${i + 1} ${emailPrefix}: 额度 ${prev.remaining}% → ${rem}%${deltaStr}`);
      }
      _allQuotaSnapshot.set(i, { remaining: rem, checkedAt: Date.now() });
    }
    _refreshPanel();
  }

  if (autoRotate) {
    // v13.1: Trial池冷却+降级锁期间,跳过预防性轮转(避免无候选重试风暴)
    const trialPoolActive = !!_getTrialPoolCooldown(_readCurrentModelUid());
    const downgradeActive = _downgradeLockUntil > 0 && Date.now() < _downgradeLockUntil;
    if (trialPoolActive && downgradeActive) {
      // 静默模式: 当前已降级到Sonnet且Trial池冷却中,不再尝试账号轮转
    } else if (trialPoolActive && Date.now() - _lastTrialPoolCooldownFailTs < TRIAL_POOL_COOLDOWN_RETRY_CD) {
      // 防抖: Trial池冷却上次失败后60s内不重试
    } else {
      const decision = evaluateActiveAccount({ accounts, threshold, curQuota });
      if (decision.action === 'switch_account') {
        if (decision.reason.startsWith('ufef_urgent')) _lastUfefSwitchTs = Date.now();
        if (decision.reason.startsWith('opus_budget_guard')) {
          const currentModel = _readCurrentModelUid();
          const opusCount = _getOpusMsgCount(_activeIndex);
          const tierBudget = _getModelBudget(currentModel);
          _opusGuardSwitchCount++;
          for (const variant of OPUS_VARIANTS) {
            am.markModelRateLimited(_activeIndex, variant, OPUS_COOLDOWN_DEFAULT, { trigger: 'opus_budget_guard' });
          }
          _pushRateLimitEvent({ type: 'per_model', trigger: 'opus_budget_guard', model: currentModel, msgs: opusCount, budget: tierBudget, tier: _isThinking1MModel(currentModel) ? 'T1M' : _isThinkingModel(currentModel) ? 'T' : 'R' });
        }
        _logInfo("调度决策", `预防性切号: ${decision.reason}`);
        const switchResult = await _performSwitch(context, {
          threshold,
          targetPolicy: decision.targetPolicy || 'same_strategy',
        });
        if (!switchResult.ok) {
          // v13.1: 记录Trial池冷却失败时间戳,用于防抖
          if (trialPoolActive) _lastTrialPoolCooldownFailTs = Date.now();
          _updatePoolBar();
          _logWarn("调度决策", "预防性切号失败: 所有账号额度不足或预热失败");
        }
      }
    }
  }

  _updatePoolBar();
}

/** 全感知限流检测 (v6.4: + 并发Tab感知 + 动态冷却 + burst加速检测) */
function _startQuotaWatcher(context) {
  const CONTEXTS = [
    "chatQuotaExceeded", // 对话配额耗尽
    "rateLimitExceeded", // 通用限流
    "windsurf.quotaExceeded", // Windsurf配额耗尽
    "windsurf.rateLimited", // Windsurf限流
    "cascade.rateLimited", // Cascade限流
    "windsurf.messageRateLimited", // 消息级限流(截图中的错误类型)
    "windsurf.modelRateLimited", // 模型级限流
    "windsurf.permissionDenied", // 权限拒绝
    "windsurf.modelProviderUnreachable", // 模型不可达
    "cascade.modelProviderUnreachable", // 模型不可达
    "windsurf.connectionError", // 连接错误
    "cascade.error", // 通用cascade错误
  ];
  let _lastTriggered = 0;

  // v6.8: 智能冷却 — 优先使用服务端报告的实际重置时间
  // 根因: v6.4假设message_rate=60-90s，但实测"Resets in: 19m27s"=1167s
  // 服务端有3级限流: burst_rate(<120s) / session_rate(120-3600s) / quota(>3600s)
  // 修复: 默认1200s(20min)匹配观测值，优先从state.vscdb或错误文本提取精确值
  const _smartCooldown = (rlType, serverResetSec) => {
    // 优先级1: 服务端报告的精确重置时间
    if (serverResetSec && serverResetSec > 0) return serverResetSec;
    // 优先级2: 从state.vscdb读取限流状态
    if (auth) {
      try {
        const cached = auth.readCachedRateLimit();
        if (cached && cached.resetsInSec && cached.resetsInSec > 0) {
          _logInfo(
            "冷却",
            `从gate.vscdb获取实际冷却时间: ${cached.resetsInSec}s (类型=${cached.type})`,
          );
          return cached.resetsInSec;
        }
      } catch {}
    }
    // 优先级3: 基于类型的默认值 (v8.0修正: message_rate从1200s→1500s匹配Opus 22m50s)
    if (rlType === "message_rate") return 1500; // 25min — 匹配实测"Resets in: 22m50s"(1370s)+裕量
    if (rlType === "quota") return 3600; // 1h — 等待日重置
    return 600; // unknown default 10min (保守)
  };

  // v6.8→v7.5: 从错误文本提取服务端重置时间
  // 支持: "Resets in: 19m27s" → 1167 | "about an hour" → 3600 | "Xh" → X*3600
  const _extractResetSeconds = (text) => {
    if (!text) return null;
    // Pattern 1: "Resets in: 19m27s"
    const m = text.match(/resets?\s*in:?\s*(\d+)m(?:(\d+)s)?/i);
    if (m) return parseInt(m[1]) * 60 + (parseInt(m[2]) || 0);
    // Pattern 2: "Resets in: 45s"
    const s = text.match(/resets?\s*in:?\s*(\d+)s/i);
    if (s) return parseInt(s[1]);
    // Pattern 3: "try again in about an hour" → 3600
    if (ABOUT_HOUR_RE.test(text)) return 3600;
    // Pattern 4: "try again in Xh" or "resets in Xh"
    const h = text.match(/(?:resets?|try\s*again)\s*in:?\s*(\d+)\s*h/i);
    if (h) return parseInt(h[1]) * 3600;
    return null;
  };

  // v7.4: 动态防抖 — 紧缩以快速响应(burst=2s, 正常=5s)
  const _getDebounce = () => (_burstMode ? 2000 : 5000);

  // ═══ Layer 1: Context Key检测 (v6.4: burst模式3s, 正常5s) ═══
  const checkContextKeys = async () => {
    if (_activeIndex < 0 || _switching) return;
    for (const ctx of CONTEXTS) {
      try {
        const exceeded = await vscode.commands.executeCommand(
          "getContext",
          ctx,
        );
        if (
          exceeded &&
          !_switching &&
          Date.now() - _lastTriggered > _getDebounce()
        ) {
          _lastTriggered = Date.now();
          const rlType =
            ctx.includes("quota") || ctx.includes("Quota")
              ? "quota"
              : "message_rate";
          const cooldown = _smartCooldown(rlType);
          _trackMessageRate(); // v6.4: 限流事件也计入消息速率
          _logWarn(
            "限流检测",
            `L1检测到限流: ${ctx} (类型=${rlType}, 冷却=${cooldown}s, 并发=${_cascadeTabCount}) → 立即轮转`,
          );
          // v7.5: 四重闸门路由 — 根据context key分类限流类型
          const currentModel = _readCurrentModelUid();
          const gateType = _classifyRateLimit(null, ctx);
          // Gate 4: 账号层级硬限 → 跳过模型轮转, 直接账号切换
          if (gateType === 'tier_cap') {
            _logWarn('限流检测', `L1→层级限流: 账号层级硬限 (${ctx})`);
            await _handleTierRateLimit(context, cooldown, { trigger: ctx, message: ctx });
            return;
          }
          // Gate 3: per-model rate limit → 模型变体轮转策略
          if (gateType === 'per_model' && currentModel) {
            _logWarn('限流检测', `L1→模型限流: ${currentModel} (${ctx})`);
            await _handlePerModelRateLimit(context, currentModel, cooldown);
            return;
          }
          // Gate 1/2: quota exhaustion → 标准账号切换
          am.markRateLimited(_activeIndex, cooldown, {
            model: currentModel || "current",
            trigger: ctx,
            type: rlType,
          });
          // v6.8: 推送限流事件到安全中枢(非阻塞)
          _pushRateLimitEvent({
            type: rlType,
            trigger: ctx,
            cooldown,
            tabs: _cascadeTabCount,
          });
          _activateBoost();
          await _doPoolRotate(context, true);
          return;
        }
      } catch (e) {
        // Suppress known harmless errors (getContext not found, Unknown context)
        // These flood logs every 2s × 12 keys = 360 noise events/min when command doesn't exist
        if (e.message && !e.message.includes("Unknown context") && !e.message.includes("not found")) {
          _logWarn("限流检测", `上下文键 ${ctx} 检测异常`, e.message);
        }
      }
    }
  };
  // v6.4: burst模式下加速context key轮询到3s
  // v7.4: 加速 context key 轮询(2s/1.5s)
  let ctxTimer = setInterval(checkContextKeys, 2000);
  const adaptiveCtxTimer = setInterval(() => {
    const targetMs = _burstMode ? 1500 : 2000;
    clearInterval(ctxTimer);
    ctxTimer = setInterval(checkContextKeys, targetMs);
  }, 30000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(ctxTimer);
      clearInterval(adaptiveCtxTimer);
    },
  });

  // ═══ Layer 3: cachedPlanInfo实时监控 (v6.2+v6.4: 动态防抖+智能冷却) ═══
  const checkCachedQuota = async () => {
    if (_activeIndex < 0 || _switching || !auth) return;
    try {
      const cached = auth.readCachedQuota();
      if (
        cached &&
        cached.exhausted &&
        !_switching &&
        Date.now() - _lastTriggered > _getDebounce()
      ) {
        _lastTriggered = Date.now();
        const cooldown = _smartCooldown("quota");
        _logWarn(
          "限流检测",
          `L3缓存配额显示耗尽: 天=${cached.daily}% 周=${cached.weekly}% 冷却=${cooldown}s → 立即轮转`,
        );
        am.markRateLimited(_activeIndex, cooldown, {
          model: "current",
          trigger: "cachedPlanInfo_exhausted",
          type: "quota",
        });
        _pushRateLimitEvent({
          type: "quota",
          trigger: "cachedPlanInfo_exhausted",
          cooldown,
          daily: cached.daily,
          weekly: cached.weekly,
        });
        _activateBoost();
        await _doPoolRotate(context, true);
      }
    } catch (e) {
      _logWarn("限流检测", "L3缓存配额检查异常", e.message);
    }
  };
  // v7.4: 加速 cachedPlanInfo 轮询(5s/10s)
  const cacheTimer = setInterval(checkCachedQuota, _burstMode ? 5000 : 10000);
  context.subscriptions.push({ dispose: () => clearInterval(cacheTimer) });

  // ═══ Layer 5: Active Rate Limit Capacity Probe — 主动调用gRPC预检端点 ═══
  // 核心突破: 主动调用 CheckUserMessageRateLimit gRPC 端点
  // Windsurf 在发送每条消息前调用此端点预检，我们也调用它获取精确容量数据
  // 当 hasCapacity=false 或 messagesRemaining<=2 → 立即切号，在用户消息失败前
  const checkCapacityProbe = async () => {
    if (_activeIndex < 0 || _switching || !auth) return;
    // 自适应间隔 — Thinking模型3s(最快), boost/burst 5s, 正幅45s
    const modelUid = _currentModelUid || _readCurrentModelUid();
    const isThinking = _isOpusModel(modelUid) && _isThinkingModel(modelUid);
    const capacityState = _getCapacityState();
    if (!capacityState) return;
    const interval = isThinking ? CAPACITY_CHECK_THINKING
      : (_isBoost() || _burstMode) ? CAPACITY_CHECK_FAST : CAPACITY_CHECK_INTERVAL;
    if (Date.now() - capacityState.lastCheck < interval) return;

    try {
      const capacity = await _probeCapacity();
      if (!capacity) return;

      // 🚫 容量已耗尽 → 立即切号(在用户下一条消息失败前!)
      if (!capacity.hasCapacity) {
        if (!_switching && Date.now() - _lastTriggered > _getDebounce()) {
          _lastTriggered = Date.now();
          _logWarn('L5探测', `🚫 容量已耗尽 → 立即切号`);
          await _handleCapacityExhausted(context, capacity);
          return;
        }
      }

      // ⚠️ 容量即将耗尽(剩余≤CAPACITY_PREEMPT_REMAINING) → 提前切号
      if (capacity.messagesRemaining >= 0 && capacity.messagesRemaining <= CAPACITY_PREEMPT_REMAINING) {
        if (!_switching && Date.now() - _lastTriggered > _getDebounce()) {
          _lastTriggered = Date.now();
          _logWarn('L5探测', `⚠️ 容量即将耗尽: 剩余${capacity.messagesRemaining}/${capacity.maxMessages}条 → 提前切号`);
          await _handleCapacityExhausted(context, capacity);
          return;
        }
      }
    } catch (e) {
      // 非关键，静默处理
    }
  };
  // Layer 5 定时器: 首次延迟10s(等API key就绪), 之后每30s检查一次
  const l5Timer = setTimeout(() => {
    checkCapacityProbe(); // 首次探测
    const l5Interval = setInterval(checkCapacityProbe, 30000);
    context.subscriptions.push({ dispose: () => clearInterval(l5Interval) });
  }, 10000);
  context.subscriptions.push({ dispose: () => clearTimeout(l5Timer) });

  _logInfo(
    "检测层",
    `已启动: L1=上下文键监听(${CONTEXTS.length}个键,每2s) | L3=缓存配额监控(每${_burstMode ? '5' : '10'}s) | L5=gRPC容量探测(Thinking:${CAPACITY_CHECK_THINKING/1000}s/加速:${CAPACITY_CHECK_FAST/1000}s/正常:${CAPACITY_CHECK_INTERVAL/1000}s) | 防抖:${_burstMode ? '2' : '5'}s`,
  );
}

// ═══ Layer 5: Active Rate Limit Capacity Probe ═══
// 核心突破: 主动调用 CheckUserMessageRateLimit gRPC 端点
// Windsurf 在发送每条消息前调用此端点预检，我们也调用它获取精确容量数据
// 当 hasCapacity=false 或 messagesRemaining<=2 → 立即切号，在用户消息失败前

/** 获取缓存的apiKey(自动刷新) */
function _getCachedApiKey() {
  if (_cachedApiKey && Date.now() - _cachedApiKeyTs < APIKEY_CACHE_TTL) {
    return _cachedApiKey;
  }
  try {
    const key = auth?.readCurrentApiKey();
    if (key && key.length > 10) {
      _cachedApiKey = key;
      _cachedApiKeyTs = Date.now();
      return key;
    }
  } catch {}
  return _cachedApiKey; // 返回可能过期的缓存值(比null好)
}

/** 切号后使apiKey缓存失效(新账号有新apiKey) */
function _invalidateApiKeyCache() {
  _cachedApiKey = null;
  _cachedApiKeyTs = 0;
}

/** Layer 5: 主动容量探测 — 调用CheckUserMessageRateLimit获取精确容量
 *  返回: capacity result 或 null (失败时) */
async function _probeCapacity() {
  if (!auth || _activeIndex < 0) return null;
  const capacityState = _getCapacityState();
  if (!capacityState) return null;

  // Reduced backoff: max 60s
  if (capacityState.failCount >= 5) {
    if (Date.now() - capacityState.lastCheck < 60000) return capacityState.lastResult;
  }

  const apiKey = _getCachedApiKey();
  if (!apiKey) {
    _logWarn('L5探测', 'apiKey未获取，跳过容量探测');
    return null;
  }

  const modelUid = _readCurrentModelUid();
  if (!modelUid) return null;

  capacityState.lastCheck = Date.now();
  _capacityProbeCount++;

  try {
    const result = await auth.checkRateLimitCapacity(apiKey, modelUid);
    if (result) {
      // -1/-1 means server returned empty/useless data — don't count as success
      const hasUsefulData = result.messagesRemaining >= 0 || result.maxMessages >= 0 || !result.hasCapacity;
      if (hasUsefulData) {
        capacityState.failCount = 0;
        capacityState.lastSuccessfulProbe = Date.now();
      } else {
        capacityState.failCount++;
      }
      capacityState.lastResult = result;

      // 更新真实消息上限(服务端权威数据)
      if (result.maxMessages > 0 && result.maxMessages !== capacityState.realMaxMessages) {
        const old = capacityState.realMaxMessages;
        capacityState.realMaxMessages = result.maxMessages;
        _logInfo('L5探测', `服务端消息上限更新: ${old} → ${capacityState.realMaxMessages}条 (模型=${modelUid})`);
      }

      // Log capacity status (reduce noise for repeated NO_DATA)
      const modelShort = modelUid.replace('claude-', '').replace(/-\d{4}.*$/, '');
      if (!result.hasCapacity) {
        _logWarn('L5探测', `🚫 #${_capacityProbeCount} 容量耗尽! 剩余${result.messagesRemaining}/${result.maxMessages}条 ${result.resetsInSeconds}s后恢复 (${modelShort}) → 即将切号`);
      } else if (hasUsefulData) {
        if (_capacityProbeCount % 5 === 0 || result.messagesRemaining <= 2) {
          _logInfo('L5探测', `✅ #${_capacityProbeCount} 剩余${result.messagesRemaining}/${result.maxMessages}条 (${modelShort})`);
        }
      } else {
        // NO_DATA: Trial账号服务端不返回精确容量数据, 每10次报告一次减少刷屏
        if (_capacityProbeCount <= 1 || _capacityProbeCount % 10 === 0) {
          _logInfo('L5探测', `✅ #${_capacityProbeCount} 可用(无精确数据—Trial账号服务端不报告剩余条数) (${modelShort})`);
        }
      }

      return result;
    }
    capacityState.failCount++;
    return null;
  } catch (e) {
    capacityState.failCount++;
    _logWarn('L5探测', `探测失败 (第${capacityState.failCount}次): ${e.message}`);
    return null;
  }
}

/** 处理容量不足 — 立即切号 */
async function _handleCapacityExhausted(context, capacityResult) {
  _capacitySwitchCount++;
  const logPrefix = `[CAPACITY_RL #${_capacitySwitchCount}]`;
  const cooldown = capacityResult.resetsInSeconds || 3600;
  const model = _readCurrentModelUid();

  _logWarn('L5探测', `${logPrefix} 容量不足! 可用=${capacityResult.hasCapacity} 剩余=${capacityResult.messagesRemaining}/${capacityResult.maxMessages}条 冷却=${cooldown}s`);

  // 根据容量探测结果精确分类
  const gateType = _classifyRateLimit(capacityResult.message, null);
  const isGlobalTrial = GLOBAL_TRIAL_RL_RE.test(String(capacityResult.message || ''));

  // 标记当前账号限流
  am.markRateLimited(_activeIndex, cooldown, {
    model: model || 'current',
    trigger: 'capacity_probe',
    type: gateType || 'tier_cap',
    capacityData: {
      remaining: capacityResult.messagesRemaining,
      max: capacityResult.maxMessages,
      resets: capacityResult.resetsInSeconds,
    },
  });
  _setAccountQuarantine(_activeIndex, cooldown, isGlobalTrial ? 'global_trial_rate_limit' : (gateType || 'tier_cap'), {
    trigger: 'capacity_probe',
    model,
  });
  if (isGlobalTrial) {
    _armTrialPoolCooldown(model, Math.min(cooldown, GLOBAL_TRIAL_POOL_COOLDOWN_SEC), 'global_trial_rate_limit', {
      model,
    });
  }

  _pushRateLimitEvent({
    type: gateType || 'tier_cap',
    trigger: 'capacity_probe_L5',
    cooldown,
    model,
    messagesRemaining: capacityResult.messagesRemaining,
    maxMessages: capacityResult.maxMessages,
    resetsInSeconds: capacityResult.resetsInSeconds,
    message: capacityResult.message,
    globalTrial: isGlobalTrial,
  });

  // Gate 4 or unknown → 直接账号切换
  if (gateType === 'tier_cap' || gateType === 'unknown') {
    const runtime = _getAccountRuntime();
    if (runtime) runtime.hourlyMsgLog = [];
    if (isGlobalTrial && await _downgradeFromTrialPressure(`${logPrefix} Trial全局限流`)) {
      return { action: 'fallback_model', cooldown, to: SONNET_FALLBACK };
    }
    _invalidateApiKeyCache(); // 切号后apiKey变化
    _activateBoost();
    await _doPoolRotate(context, true);
    return { action: 'capacity_account_switch', cooldown };
  }

  // Gate 3 (per-model) → 走模型级处理链
  if (gateType === 'per_model' && model) {
    _invalidateApiKeyCache();
    return await _handlePerModelRateLimit(context, model, cooldown);
  }

  // Default: 账号切换
  _invalidateApiKeyCache();
  _activateBoost();
  await _doPoolRotate(context, true);
  return { action: 'capacity_rotate', cooldown };
}

// ═══ 安全中枢融合 (v6.8: 限流事件推送 + 跨会话追踪) ═══

/** 推送限流事件到安全中枢 :9877 (非阻塞, 失败静默) */
function _pushRateLimitEvent(eventData) {
  try {
    const payload = JSON.stringify({
      event: "rate_limit",
      timestamp: Date.now(),
      activeIndex: _activeIndex,
      activeEmail: am?.get(_activeIndex)?.email?.split("@")[0] || "?",
      windowId: _windowId,
      cascadeTabs: _cascadeTabCount,
      burstMode: _burstMode,
      switchCount: _switchCount,
      poolStats: am?.getPoolStats(_getPreemptiveThreshold()) || {},
      ...eventData,
    });
    const req = http.request({
      hostname: "127.0.0.1",
      port: 9877,
      method: "POST",
      path: "/api/wam/rate_limit_event",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 3000,
    });
    req.on("error", () => {}); // 静默失败
    req.on("timeout", () => req.destroy());
    req.write(payload);
    req.end();
    _logInfo(
      "安全中枢",
      `限流事件已推送 (类型=${eventData.type}, 触发=${eventData.trigger})`,
    );
  } catch {}
}

// ========== 号池状态栏 ==========

// ═══ v7.0: 积分速度检测器 — 检测高速消耗模式 ═══
// 与斜率预测(slopePredict)不同: 速度检测器关注短期突变(2min内降>10%)
// 斜率预测关注长期趋势(5样本线性外推), 速度检测器关注即时危险

/** 追踪积分速度样本 */
function _trackVelocity(remaining) {
  if (remaining === null || remaining === undefined) return;
  const runtime = _getAccountRuntime();
  if (!runtime) return;
  runtime.velocityLog.push({ ts: Date.now(), remaining });
  const cutoff = Date.now() - VELOCITY_WINDOW;
  runtime.velocityLog = runtime.velocityLog.filter((s) => s.ts >= cutoff);
}

/** 计算当前积分消耗速度 (%/min), 正值=消耗中 */
function _getVelocity() {
  const runtime = _getAccountRuntime(_activeIndex, false);
  if (!runtime || runtime.velocityLog.length < 2) return 0;
  const first = runtime.velocityLog[0];
  const last = runtime.velocityLog[runtime.velocityLog.length - 1];
  const dtMin = (last.ts - first.ts) / 60000;
  if (dtMin <= 0) return 0;
  const drop = first.remaining - last.remaining; // 正值=额度在降
  return drop / dtMin; // %/min
}

/** 检测是否处于高速消耗模式 (120s内降>VELOCITY_THRESHOLD%) */
function _isHighVelocity() {
  const runtime = _getAccountRuntime(_activeIndex, false);
  if (!runtime || runtime.velocityLog.length < 2) return false;
  const first = runtime.velocityLog[0];
  const last = runtime.velocityLog[runtime.velocityLog.length - 1];
  const drop = first.remaining - last.remaining;
  return drop >= VELOCITY_THRESHOLD;
}

/** 斜率预测: 基于最近N个quota样本，线性外推SLOPE_HORIZON后的剩余额度 */
function _slopePredict() {
  const runtime = _getAccountRuntime(_activeIndex, false);
  if (!runtime || runtime.quotaHistory.length < 2) return null;
  const recent = runtime.quotaHistory.slice(-SLOPE_WINDOW);
  if (recent.length < 2) return null;
  const first = recent[0],
    last = recent[recent.length - 1];
  const dt = last.ts - first.ts;
  if (dt <= 0) return null;
  const rate = (last.remaining - first.remaining) / dt; // per ms (负值=消耗中)
  if (rate >= 0) return null; // 额度在增加或不变，无需预测
  const predicted = last.remaining + rate * SLOPE_HORIZON;
  return Math.round(predicted);
}

function _updatePoolBar() {
  if (!statusBar || !am) return;
  const accounts = am.getAll();
  const threshold = _getPreemptiveThreshold();
  const capacityState = _getCapacityState(_activeIndex, false);
  const lastCapacityResult = capacityState?.lastResult || null;
  const probeFailCount = capacityState?.failCount || 0;
  const lastSuccessfulProbe = capacityState?.lastSuccessfulProbe || Date.now();
  if (accounts.length === 0) {
    statusBar.text = "$(add) 添加账号";
    statusBar.color = new vscode.ThemeColor("disabledForeground");
    statusBar.tooltip = "号池为空，点击添加账号";
    return;
  }

  const pool = am.getPoolStats(threshold);
  const mode = auth ? auth.getProxyStatus().mode : "?";
  const modeIcon = mode === "relay" ? "☁" : "⚡";

  // v8.2: Clean plain-text quota display (天/周)
  let quotaDisplay = "?";
  let isLow = false;
  if (pool.avgDaily !== null) {
    const dPct = Math.min(100, pool.avgDaily);
    const wPct = pool.avgWeekly !== null ? Math.min(100, pool.avgWeekly) : null;
    const poolEffective = wPct !== null ? Math.min(dPct, wPct) : dPct;
    quotaDisplay = wPct !== null ? `天${dPct}%·周${wPct}%` : `天${dPct}%`;
    isLow = poolEffective <= 10;
  } else if (pool.avgCredits !== null) {
    quotaDisplay = `均${pool.avgCredits}分`;
    isLow = pool.avgCredits <= threshold;
  } else {
    quotaDisplay = `${pool.health}%`;
    isLow = pool.health <= 10;
  }

  // 号池健康度
  const poolTag = `${pool.available}/${pool.total}`;
  const boost = _isBoost() ? "⚡" : "";
  const burst = _burstMode ? "🔥" : ""; // v6.4: burst模式标识
  const auto = vscode.workspace.getConfiguration("wam").get("autoRotate", true)
    ? ""
    : "⏸";

  const winCount = _getActiveWindowCount();
  const winTag = winCount > 1 ? ` W${winCount}` : "";
  const tabTag =
    _cascadeTabCount > CONCURRENT_TAB_SAFE ? ` T${_cascadeTabCount}` : ""; // v6.4: 高并发Tab数
  statusBar.text = `${modeIcon} ${quotaDisplay} ${poolTag}${winTag}${tabTag}${burst}${boost}${auto}`;
  statusBar.color = isLow
    ? new vscode.ThemeColor("errorForeground")
    : pool.available === 0
      ? new vscode.ThemeColor("errorForeground")
      : _burstMode
        ? new vscode.ThemeColor("editorWarning.foreground") // v6.4: burst模式黄色警示
        : new vscode.ThemeColor("testing.iconPassed");

  // v8.4: Official Plan Info style tooltip (MarkdownString)
  const slopeInfo = _slopePredict();
  const vel = _getVelocity();
  const hourlyCount = _getHourlyMsgCount();
  const currentModel = _currentModelUid || _readCurrentModelUid();

  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.supportHtml = true;
  const L = (...s) => md.appendMarkdown(s.join('') + '\n\n');
  const _fmtDate = (ts) => { const d = new Date(ts); return `${d.getMonth()+1}月${d.getDate()}日 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };

  // ── Active Account (mirrors official Plan Info) ──
  if (_activeIndex >= 0) {
    const q = am.getActiveQuota(_activeIndex);
    const a = am.get(_activeIndex);
    if (q && a) {
      L(`**${q.plan || '计划'}**`);
      L(`额度按 天/周 重置`);
      if (q.planDays !== null) {
        if (q.planDays > 0) L(`计划剩余 **${q.planDays} 天**`);
        else L(`计划 **已过期**`);
      }
      L(`---`);
      if (q.daily !== null) {
        const used = Math.max(0, 100 - q.daily);
        L(`**天额度已用：** &nbsp;&nbsp; **${used}%**`);
        if (q.dailyResetRaw) L(`重置于 ${_fmtDate(q.dailyResetRaw)}`);
        else if (q.resetCountdown) L(`${q.resetCountdown} 后重置`);
      }
      if (q.weekly !== null) {
        const wUsed = Math.max(0, 100 - q.weekly);
        L(`**周额度已用：** &nbsp;&nbsp; **${wUsed}%**`);
        if (q.weeklyReset) L(`重置于 ${_fmtDate(q.weeklyReset)}`);
        else if (q.weeklyResetCountdown) L(`${q.weeklyResetCountdown} 后重置`);
      }
      if (q.extraBalance !== null) L(`**额外余额：** &nbsp;&nbsp;&nbsp; **$${q.extraBalance.toFixed(2)}**`);
      L(`---`);
      L(`**${q.plan || '计划'}**`);
      L(`${a.email}`);
    }
  }

  // ── Pool Aggregate ──
  L(`---`);
  const poolStatus = [`**${pool.available}**可用 / **${pool.total}**总计`];
  if (pool.depleted > 0) poolStatus.push(`${pool.depleted}耗尽`);
  if (pool.rateLimited > 0) poolStatus.push(`${pool.rateLimited}限流`);
  if (pool.expired > 0) poolStatus.push(`${pool.expired}过期`);
  L(`**号池** &nbsp; ${poolStatus.join(' · ')}`);
  if (pool.avgEffective !== null) L(`均剩 **${pool.avgEffective}%** (${pool.effectiveCount}个账号均值)`);
  if (pool.avgDaily !== null) {
    const parts = [`天 **${pool.avgDaily}%**`];
    if (pool.avgWeekly !== null) parts.push(`周 **${pool.avgWeekly}%**`);
    L(parts.join(' &nbsp; '));
  }
  if (pool.urgentCount > 0) L(`⚠ ${pool.urgentCount}个紧急(≤3天)`);
  if (pool.preResetWasteCount > 0) L(`⚠ ${pool.preResetWasteCount}个即将浪费${pool.preResetWasteTotal}%额度`);

  // ── Runtime & Defense (structured rows) ──
  const hasRuntime = vel > 0 || hourlyCount > 0 || _switchCount > 0 || slopeInfo !== null || winCount > 1 || _cascadeTabCount > 1 || _burstMode;
  const hasDefense = (_isOpusModel(currentModel) && _activeIndex >= 0) || lastCapacityResult || probeFailCount > 0;
  if (hasRuntime) {
    L(`---`);
    L(`**实时监控**`);
    if (vel > 0) L(`消耗速度 &nbsp; **${vel.toFixed(1)}%/min**${_isHighVelocity() ? ' ⚡高速' : ''}`);
    if (hourlyCount > 0) L(`小时消息 &nbsp; **${hourlyCount}/${TIER_MSG_CAP_ESTIMATE}**${_isNearTierCap() ? ' ⚠接近上限' : ''}`);
    if (slopeInfo !== null) L(`趋势预测 &nbsp; **${slopeInfo}%**`);
    if (_switchCount > 0) L(`已切换 &nbsp; **${_switchCount}次**`);
    if (winCount > 1) L(`活跃窗口 &nbsp; **${winCount}个**`);
    if (_cascadeTabCount > 1) L(`并发对话 &nbsp; **${_cascadeTabCount}个**`);
    if (_burstMode) L(`🔥 **BURST防护模式**`);
  }
  if (hasDefense) {
    L(`---`);
    L(`**防御状态**`);
    if (_isOpusModel(currentModel) && _activeIndex >= 0) {
      const opusCount = _getOpusMsgCount(_activeIndex);
      const tierBudget = _getModelBudget(currentModel);
      const tierLabel = _isThinking1MModel(currentModel) ? 'T1M' : _isThinkingModel(currentModel) ? 'T' : 'R';
      L(`Opus预算 &nbsp; **${opusCount}/${tierBudget}条** (${tierLabel})`);
    }
    if (lastCapacityResult) {
      const cap = lastCapacityResult;
      const capIcon = cap.hasCapacity ? '✓' : '✗';
      const capRem = cap.messagesRemaining >= 0 ? cap.messagesRemaining : '?';
      const capMax = cap.maxMessages >= 0 ? cap.maxMessages : '?';
      L(`L5容量 &nbsp; ${capIcon} **${capRem}/${capMax}条** (第${_capacityProbeCount}次探测)`);
    }
    if (probeFailCount > 0) L(`探测失败 &nbsp; **${probeFailCount}次**连续`);
  }
  L(`---`);
  L(`${mode} · 阈值${threshold}% · 10层防御`);
  statusBar.tooltip = md;
}

/** Round-Robin fallback — 当_performSwitch失败时的最后兑底
 *  统一过滤: 限流/过期/隔离/Trial池冷却 */
function _roundRobinFallback() {
  const accounts = am.getAll();
  if (accounts.length <= 1) return -1;
  for (let r = 1; r < accounts.length; r++) {
    const ci = (_activeIndex + r) % accounts.length;
    if (am.isRateLimited(ci) || am.isExpired(ci) || _isAccountQuarantined(ci)) continue;
    const trialCd = _getTrialPoolCooldown(_readCurrentModelUid());
    if (trialCd && _isTrialLikeAccount(ci)) continue;
    return ci;
  }
  return (_activeIndex + 1) % accounts.length; // 全部不可用时强制轮转
}

// ========== 号池轮转 (无感切换) ==========

/** 无感切换 — 用户无需任何操作 */
async function _seamlessSwitch(context, targetIndex) {
  if (_switching || targetIndex === _activeIndex) return false;
  _switching = true;
  const prevBar = statusBar.text;
  statusBar.text = "$(sync~spin) ...";
  const prevIndex = _activeIndex;
  const prevEmail = _getAccountEmail(prevIndex);

  try {
    _invalidateApiKeyCache(); // 切号后apiKey变化
    await _loginToAccount(context, targetIndex);
    _switchCount++;
    am.markUsed(targetIndex); // v12.0: Round-Robin均匀消耗追踪
    _lastQuota = null;
    _dropAccountRuntimeByEmail(prevEmail);
    _resetAccountRuntimeByEmail(_getAccountEmail(targetIndex));
    _resetOpusMsgLog(targetIndex);
    _heartbeatWindow();
    _logInfo(
      "切换",
      `✅ 无感切换 #${prevIndex + 1}→#${targetIndex + 1} (第${_switchCount}次, ${_getActiveWindowCount()}窗口)`,
    );
    return true;
  } catch (e) {
    _logError("切换", `❌ 切换失败 #${targetIndex + 1}`, e.message);
    statusBar.text = prevBar;
    return false;
  } finally {
    _switching = false;
    _updatePoolBar();
    _refreshPanel();
  }
}

/** 号池轮转命令 (用户触发或自动触发)
 *  v11.0: isPanic=true跳过_refreshAll(用缓存直切)，但注入始终完整验证 */
async function _doPoolRotate(context, isPanic = false) {
  if (_switching) return;
  const accounts = am.getAll();
  if (accounts.length === 0) {
    vscode.commands.executeCommand("wam.openPanel");
    return;
  }

  const threshold = _getPreemptiveThreshold();

  // ═══ 紧急切换(跳过全池刷新，用缓存数据直切) ═══
  // 完整验证，不再跳过注入验证
  if (isPanic && _activeIndex >= 0) {
    statusBar.text = "$(zap) 即时切换...";
    const t0 = Date.now();
    _logWarn("轮转", `紧急切换: 标记 #${_activeIndex + 1} 限流 → 用缓存选最优`);
    if (!am.isRateLimited(_activeIndex)) {
      am.markRateLimited(_activeIndex, 300, { model: "unknown", trigger: "panic_rotate" });
    }
    const panicSwitch = await _performSwitch(context, {
      threshold,
      targetPolicy: 'same_strategy',
      panic: true,
      allowThresholdFallback: true,
    });
    if (panicSwitch.ok) {
      _logInfo("轮转", `✅ 紧急切换完成: → #${panicSwitch.index + 1} (耗时${Date.now() - t0}ms)`);
      _updatePoolBar();
      _refreshPanel();
      setTimeout(() => _refreshAll().then(() => { _updatePoolBar(); _refreshPanel(); }).catch(() => {}), 5000);
      return;
    }
    if (accounts.length > 1) {
      const next = _roundRobinFallback();
      if (next >= 0) await _seamlessSwitch(context, next);
      _logInfo("轮转", `✅ 紧急轮转: → #${next + 1} (耗时${Date.now() - t0}ms)`);
    }
    _updatePoolBar();
    _refreshPanel();
    return;
  }

  // ═══ 非紧急模式: 完整刷新+选优 ═══
  statusBar.text = "$(sync~spin) 轮转中...";
  const rotateResult = await _performSwitch(context, {
    threshold,
    targetPolicy: 'same_strategy',
    refreshPool: true,
  });
  if (rotateResult.ok) {
    _updatePoolBar();
    _refreshPanel();
    return;
  } else if (am.allDepleted(threshold)) {
    statusBar.text = "$(warning) 号池耗尽";
    statusBar.color = new vscode.ThemeColor("errorForeground");
    vscode.window.showWarningMessage(
      "WAM: 所有账号额度不足。SWE-1.5模型免费无限使用。",
      "确定",
    );
  } else {
    // Round-robin fallback (跳过不可用账号)
    if (accounts.length > 1) {
      const next = _roundRobinFallback();
      if (next >= 0) await _seamlessSwitch(context, next);
    }
  }
  _updatePoolBar();
  _refreshPanel();
}

// ========== Core: Auth Infrastructure (battle-tested, kept intact) ==========

/** Discover the correct auth injection command at runtime */
async function _discoverAuthCommand() {
  if (_discoveredAuthCmd) return _discoveredAuthCmd;
  const allCmds = await vscode.commands.getCommands(true);
  const candidates = [
    ...allCmds.filter(
      (c) => /provideAuthToken.*AuthProvider/i.test(c) && !/Shit/i.test(c),
    ),
    ...allCmds.filter((c) => /provideAuthToken.*Shit/i.test(c)),
    ...allCmds.filter(
      (c) =>
        /windsurf/i.test(c) &&
        /auth/i.test(c) &&
        /token/i.test(c) &&
        c !== "windsurf.loginWithAuthToken",
    ),
  ];
  const seen = new Set();
  const unique = candidates.filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });
  _logInfo(
    "认证",
    `发现${unique.length}个认证命令: [${unique.join(", ")}]`,
  );
  if (unique.length > 0) _discoveredAuthCmd = unique;
  return unique;
}

function _resetDiscoveredCommands() {
  _discoveredAuthCmd = null;
}

// ═══ v11.0 会话过渡等待 ═══
// 根因修正: provideAuthTokenToAuthProvider → handleAuthToken → registerUser → restartLS
// 是Windsurf内部自动完成的。旧版错误地重启TypeScript LS(无关)和清理.vscode-server(远程开发)。
// 真正需要的只是等待Windsurf内部的auth handler完成会话切换。

// v14.0: _waitForSessionTransition 已移除,由 _waitForApiKeyChange 自适应轮询替代


// ═══════════════════════════════════════════════════════════════════
// v6.0 CORE CHANGE: Split into checkAccount (SAFE) vs injectAuth (DISRUPTIVE)
//
// Root cause of "breaks Cascade": provideAuthTokenToAuthProvider switches the
// active auth session, invalidating any ongoing Cascade conversation.
//
// Solution: Default operations (login button, credit check, rotation monitoring)
// use checkAccount() which ONLY does Firebase auth + credit query — ZERO impact
// on Windsurf's internal auth state. Auth injection is a separate explicit action.
// ═══════════════════════════════════════════════════════════════════

/**
 * SAFE: Check account credentials and refresh credits.
 * Does Firebase login + GetPlanStatus only. Does NOT touch Windsurf auth.
 * Returns { ok, credits, usageInfo }
 */
async function _checkAccount(context, index) {
  const account = am.get(index);
  if (!account) return { ok: false };

  const result = await _refreshOne(index);
  _activeIndex = index;
  context.globalState.update("wam-current-index", index);
  _updatePoolBar();

  return { ok: true, credits: result.credits, usageInfo: result.usageInfo };
}

/**
 * DISRUPTIVE: Inject auth token into Windsurf to switch active account.
 * WARNING: This WILL disconnect any active Cascade conversation.
 * Should only be called with explicit user consent.
 * Returns { ok, injected, method }
 *
 * v5.8.0 Strategy (reverse-engineered from Windsurf 1.108.2):
 *   S0: idToken → PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER (PRIMARY — Windsurf internally registerUser)
 *   S1: OneTimeAuthToken → command (FALLBACK — relay only, legacy)
 *   S2: registerUser apiKey → command (LAST RESORT)
 */
async function injectAuth(context, index) {
  const account = am.get(index);
  if (!account) return { ok: false };

  // ═══ v11.0 指纹轮转 + 会话过渡 ═══
  // 根因修正: provideAuthTokenToAuthProvider内部自动触发registerUser→restartLS
  // 不再手动重启LS(旧版错误地重启TypeScript LS)
  // 只需: 轮转指纹(写磁盘) → 等待 → 注入(Windsurf内部完成LS重启+读新ID)
  const config = vscode.workspace.getConfiguration("wam");
  if (config.get("rotateFingerprint", true)) {
    _rotateFingerprintForSwitch();
    _hotResetCount++;
    _logInfo("热重置", `指纹已轮转 (第${_hotResetCount}次)`);
    // v14.0: 指纹writeFileSync是同步的,200ms足够OS刷新缓冲区(原1000ms过保守)
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  let injected = false;
  let method = "none";
  const discoveredCmds = await _discoverAuthCommand();

  // Strategy 0 (PRIMARY — Windsurf 1.108.2+): idToken direct
  // PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER accepts firebase idToken,
  // internally calls registerUser(idToken) → {apiKey, name} → session
  try {
    // v14.0: 优先使用缓存token(预热阶段已刷新,50min TTL内有效,省1-2s网络延迟)
    const loginResult = await auth.login(account.email, account.password, false);
    const idToken = loginResult?.ok ? loginResult.idToken : await auth.getFreshIdToken(account.email, account.password);
    if (idToken) {
      // Try well-known command name first
      try {
        const result = await vscode.commands.executeCommand(
          "windsurf.provideAuthTokenToAuthProvider",
          idToken,
        );
        // FIX: Check return value — command returns {session, error}, not throwing on auth failure
        if (result && result.error) {
          _logWarn(
            "注入",
            `[S0] 命令返回错误: ${JSON.stringify(result.error)}`,
          );
        } else {
          injected = true;
          method = "S0-provideAuth-idToken";
          _logInfo(
            "注入",
            `[S0] 已注入idToken → 会话: ${result?.session?.account?.label || "未知"}`,
          );
        }
      } catch (e) {
        _logWarn("注入", `[S0] 主命令失败: ${e.message}`);
      }
      // Try discovered commands with idToken
      if (!injected) {
        for (const cmd of discoveredCmds || []) {
          if (injected) break;
          try {
            const result = await vscode.commands.executeCommand(cmd, idToken);
            if (result && result.error) {
              _logWarn(
                "注入",
                `[S0-发现] ${cmd} 返回错误: ${JSON.stringify(result.error)}`,
              );
            } else {
              injected = true;
              method = `S0-${cmd}-idToken`;
              _logInfo("注入", `[S0-发现] 已通过${cmd}注入idToken`);
            }
          } catch {}
        }
      }
    }
  } catch (e) {
    _logWarn("注入", "[S0] idToken注入失败", e.message);
  }

  // Strategy 1 (FALLBACK): OneTimeAuthToken via relay
  if (!injected) {
    try {
      const authToken = await auth.getOneTimeAuthToken(
        account.email,
        account.password,
      );
      if (authToken && authToken.length >= 30 && authToken.length <= 200) {
        try {
          await vscode.commands.executeCommand(
            "windsurf.provideAuthTokenToAuthProvider",
            authToken,
          );
          injected = true;
          method = "S1-provideAuth-otat";
          _logInfo(
            "注入",
            "[S1] 已注入OneTimeAuthToken",
          );
        } catch {}
        if (!injected) {
          for (const cmd of discoveredCmds || []) {
            if (injected) break;
            try {
              await vscode.commands.executeCommand(cmd, authToken);
              injected = true;
              method = `S1-${cmd}-otat`;
              _logInfo(
                "注入",
                `[S1-发现] 已通过${cmd}注入OneTimeAuthToken`,
              );
            } catch {}
          }
        }
        if (injected) _writeAuthFilesCompat(authToken);
      }
    } catch (e) {
      _logWarn("注入", "[S1] OneTimeAuthToken降级失败", e.message);
    }
  }

  // Strategy 2: registerUser apiKey via command
  if (!injected) {
    try {
      const regResult = await auth.registerUser(
        account.email,
        account.password,
      );
      if (regResult && regResult.apiKey) {
        for (const cmd of discoveredCmds || []) {
          if (injected) break;
          try {
            await vscode.commands.executeCommand(cmd, regResult.apiKey);
            injected = true;
            method = `S2-${cmd}-apiKey`;
            _logInfo("注入", `[S2] 已通过${cmd}注入apiKey`);
          } catch (e) {
            _logError("注入", `[S2] ${cmd}失败`, e.message);
          }
        }
        // Strategy 3 (DB DIRECT-WRITE — bypasses command system):
        // Writes new apiKey to windsurfAuthStatus in state.vscdb.
        // NOTE: sessions secret is DPAPI-encrypted → can't update via DB.
        // Must trigger window reload so Windsurf re-reads auth state from DB.
        if (!injected) {
          const dbResult = _dbInjectApiKey(regResult.apiKey);
          if (dbResult.ok) {
            injected = true;
            method = "S3-db-inject";
            _logInfo(
              "注入",
              `[S3] DB直写: ${dbResult.oldPrefix}→${dbResult.newPrefix}`,
            );
            // DB injection requires window reload to take effect (encrypted session unchanged)
            setTimeout(async () => {
              const reload = await vscode.window.showInformationMessage(
                "WAM: 账号已切换(DB注入)。需要重新加载窗口使新账号生效。",
                "立即重载",
                "稍后",
              );
              if (reload === "立即重载") {
                vscode.commands.executeCommand("workbench.action.reloadWindow");
              }
            }, 500);
          } else {
            _logWarn("注入", `[S3] DB注入失败: ${dbResult.error}`);
          }
        }
      }
    } catch (e) {
      _logWarn("注入", "[S2/S3] registerUser+DB降级失败", e.message);
    }
  }

  // ═══ POST-INJECTION STATE REFRESH SEQUENCE ═══
  // Root cause chain (reverse-engineered 2026-03-20):
  //   1. handleAuthToken → registerUser → new session → restartLS → fireSessionChange
  //   2. But workbench's Zustand store keeps stale quota_exhausted banner (sticky!)
  //   3. cachedPlanInfo in state.vscdb is stale (in-memory state is separate)
  //   4. Status bar "Trial - Quota Exhausted" persists until explicitly cleared
  if (injected) {
    await _postInjectionRefresh();
  }

  return { ok: injected, injected, method };
}

/** Login to account: inject auth → adaptive verify
 *  v14.0: 消除冗余Firebase登录(预热已验证) + 自适应apiKey变化检测 */
async function _loginToAccount(context, index) {
  const account = am.get(index);
  if (!account) return;

  // v11.0: 始终设置activeIndex(即使后续注入失败，也有正确的目标)
  _activeIndex = index;
  context.globalState.update("wam-current-index", index);

  // v14.0: 移除冗余Firebase登录 — 预热阶段(_validateSwitchCandidate)已验证凭据有效
  // 直接进入注入流程,节省1-2s网络延迟

  const apiKeyBefore = _readAuthApiKeyPrefix();
  const injectResult = await injectAuth(context, index);

  if (injectResult.injected) {
    // v14.0: 自适应apiKey变化检测 — 替代固定等待,快则200ms慢则2s
    const changed = await _waitForApiKeyChange(apiKeyBefore, 2000);
    _logInfo(
      "登录",
      `✅ ${injectResult.method} → #${index + 1} | apiKey ${changed ? "已更新" : "未变"}`,
    );
  }

  am.incrementLoginCount(index);
  _updatePoolBar();
}

/** v14.0: 自适应等待apiKey变化 — 替代固定sleep,检测到变化立即返回 */
async function _waitForApiKeyChange(oldPrefix, maxWaitMs = 2000) {
  const interval = 200;
  const maxAttempts = Math.ceil(maxWaitMs / interval);
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, interval));
    if (_readAuthApiKeyPrefix() !== oldPrefix) return true;
  }
  return false;
}

// ========== Auth File Compatibility (v4.0) ==========
// Write windsurf-auth.json + cascade-auth.json for cross-compatibility.
// These files are written by windsurf-assistant and may be read by Windsurf.
// Only called AFTER successful command injection with a valid short authToken.
function _writeAuthFilesCompat(authToken) {
  if (!authToken || authToken.length < 30 || authToken.length > 60) return;
  try {
    const gsPath = _getWindsurfGlobalStoragePath();
    if (!fs.existsSync(gsPath)) return; // don't create dir, must already exist
    const authData = JSON.stringify(
      {
        authToken,
        token: authToken,
        api_key: authToken,
        timestamp: Date.now(),
      },
      null,
      2,
    );
    fs.writeFileSync(path.join(gsPath, "windsurf-auth.json"), authData, "utf8");
    fs.writeFileSync(path.join(gsPath, "cascade-auth.json"), authData, "utf8");
    _logInfo("认证", "认证文件已写入(跨扩展兼容)");
  } catch (e) {
    // Non-critical, don't break main flow
    _logWarn("认证", "认证文件写入跳过", e.message);
  }
}

// ========== 号池命令 (v6.0 精简) ==========

/** 刷新号池 — 全部账号额度 + 自动轮转 */
async function _doRefreshPool(context) {
  const accounts = am.getAll();
  if (accounts.length === 0) return;
  statusBar.text = "$(sync~spin) 刷新号池...";
  await _refreshAll((i, n) => {
    statusBar.text = `$(sync~spin) ${i + 1}/${n}...`;
  });
  // 刷新后自动轮转
  const threshold = _getPreemptiveThreshold();
  if (
    vscode.workspace.getConfiguration("wam").get("autoRotate", true) &&
    _activeIndex >= 0
  ) {
    const decision = am.shouldSwitch(_activeIndex, threshold);
    if (decision.switch) {
      await _performSwitch(context, { threshold, targetPolicy: 'same_strategy' });
    }
  }
  _updatePoolBar();
  _refreshPanel();
}

/** Webview动作处理器 (v6.0 精简) */
function _handleAction(context, action, arg) {
  switch (action) {
    case "login":
      return _seamlessSwitch(context, arg);
    case "checkAccount":
      return _checkAccount(context, arg);
    case "explicitSwitch":
      return _seamlessSwitch(context, arg);
    case "refreshAll":
      return _doRefreshPool(context);
    case "refreshOne":
      return _refreshOne(arg).then(() => {
        _updatePoolBar();
        _refreshPanel();
      });
    case "clearRateLimit":
      if (arg !== undefined) {
        am.clearRateLimit(arg);
        _clearAccountQuarantine(arg);
        // v13.1: 清限流时也清Trial池冷却+降级锁,允许恢复Opus
        schedulerState.poolCooldowns.clear();
        _downgradeLockUntil = 0;
        _lastTrialPoolCooldownFailTs = 0;
        _updatePoolBar();
        _refreshPanel();
      }
      return;
    case "getCurrentIndex":
      return _activeIndex;
    case "getProxyStatus":
      return auth ? auth.getProxyStatus() : { mode: "?", port: 0 };
    case "getPoolStats":
      return am.getPoolStats(_getPreemptiveThreshold());
    case "getActiveQuota":
      return am.getActiveQuota(_activeIndex);
    case "getSwitchCount":
      return _switchCount;
    case "setMode":
      if (auth && arg) {
        auth.setMode(arg);
        context.globalState.update("wam-proxy-mode", arg);
        _updatePoolBar();
        _refreshPanel();
      }
      return;
    case "setProxyPort":
      if (auth && arg) {
        auth.setPort(arg);
        context.globalState.update("wam-proxy-mode", "local");
        _updatePoolBar();
        _refreshPanel();
      }
      return;
    case "reprobeProxy":
      if (auth)
        return auth.reprobeProxy().then((r) => {
          context.globalState.update("wam-proxy-mode", r.mode);
          _updatePoolBar();
          _refreshPanel();
          return r;
        });
      return;
    case "exportAccounts":
      return _doExport(context);
    case "importAccounts":
      return _doImport(context);
    case "resetFingerprint":
      return _doResetFingerprint();
    case "panicSwitch":
      return _doPoolRotate(context, true);
    case "batchAdd":
      return _doBatchAdd(arg);
    case "refreshAllAndRotate":
      return _doRefreshPool(context);
    case "getFingerprint":
      return readFingerprint();
    case "smartRotate":
      return _doPoolRotate(context);
    case "setAutoRotate":
      if (arg !== undefined)
        vscode.workspace
          .getConfiguration("wam")
          .update("autoRotate", !!arg, true);
      return;
    case "setCreditThreshold":
    case "setPreemptiveThreshold":
      if (arg !== undefined) {
        const next = Math.max(0, Math.min(100, Number(arg) || 0));
        return vscode.workspace
          .getConfiguration("wam")
          .update("preemptiveThreshold", next, true)
          .then(() => {
            _updatePoolBar();
            _refreshPanel();
          });
      }
      return;
  }
}

/** 重置指纹 */
async function _doResetFingerprint() {
  const confirm = await vscode.window.showWarningMessage(
    "重置设备指纹？下次切号时自动热生效(无需重启Windsurf)。",
    "重置",
    "取消",
  );
  if (confirm !== "重置") return;
  const result = resetFingerprint();
  if (result.ok) {
    _lastRotatedIds = result.new;
    vscode.window.showInformationMessage(
      "WAM: ✅ 指纹已重置，下次切号时热生效(无需重启)。",
    );
  } else {
    vscode.window.showErrorMessage(`WAM: 重置失败: ${result.error}`);
  }
}

/** 导入账号 */
async function _doImport(context) {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "WAM Backup": ["json"] },
    title: "导入号池备份",
  });
  if (!uris || !uris.length) return;
  try {
    const r = am.importFromFile(uris[0].fsPath);
    vscode.window.showInformationMessage(
      `WAM: 导入 +${r.added} ↻${r.updated} =${r.total}`,
    );
    _refreshPanel();
  } catch (e) {
    vscode.window.showErrorMessage(`WAM: 导入失败: ${e.message}`);
  }
}

/** 导出账号 */
async function _doExport(context) {
  if (am.count() === 0) return;
  try {
    const fpath = am.exportToFile(context.globalStorageUri.fsPath);
    vscode.window
      .showInformationMessage(`WAM: ✅ 已导出 ${am.count()} 个账号`, "打开目录")
      .then((sel) => {
        if (sel)
          vscode.commands.executeCommand(
            "revealFileInOS",
            vscode.Uri.file(fpath),
          );
      });
  } catch (e) {
    vscode.window.showErrorMessage(`WAM: 导出失败: ${e.message}`);
  }
}

/** 切换代理模式 */
async function _doSwitchMode(context) {
  const status = auth.getProxyStatus();
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "$(globe) 本地代理",
        description: `端口 ${status.port}`,
        value: "local",
      },
      { label: "$(cloud) 网络中转", description: "无需VPN", value: "relay" },
    ],
    { placeHolder: `当前: ${status.mode}` },
  );
  if (pick) {
    auth.setMode(pick.value);
    context.globalState.update("wam-proxy-mode", pick.value);
    _updatePoolBar();
    _refreshPanel();
  }
}

/** 批量添加账号 */
async function _doBatchAdd(textFromWebview) {
  let text = textFromWebview;
  if (!text) {
    text = await vscode.window.showInputBox({
      prompt: "粘贴卖家消息，自动识别账号密码",
      placeHolder: "支持: 卡号/卡密 | 账号/密码 | email:pass | email----pass",
      value: "",
    });
  }
  if (!text) return { added: 0, skipped: 0 };

  const result = am.addBatch(text);
  if (result.added > 0) {
    _logInfo("批量添加", `已添加${result.added}个账号(智能解析)`);
  }
  _refreshPanel();
  return result;
}

// ========== (v6.0: 旧监控已合并到号池引擎 _poolTick + _startQuotaWatcher) ==========

function _refreshPanel() {
  if (_panelProvider) {
    try {
      _panelProvider.refresh();
    } catch {}
  }
}

// ========== Post-Injection State Refresh (v5.9.0 — 核心锚定点修复) ==========
//
// Reverse-engineered anchoring points (2026-03-20):
//   Anchor 1: provideAuthTokenToAuthProvider → handleAuthToken → registerUser
//             → creates new session → restarts LS → fires onDidChangeSessions
//             → BUT workbench's in-memory state may lag
//   Anchor 2: quota_exhausted banner in Zustand store is STICKY
//             → DVe=Z=>false means client never checks quota locally
//             → banner persists until server returns success on next message
//   Anchor 3: cachedPlanInfo in state.vscdb is separate from in-memory state
//             → deleting DB record doesn't affect loaded workbench state
//
// Solution: Force a complete state refresh chain after confirmed injection.

async function _postInjectionRefresh() {
  try {
    // ═══ v14.0: 精简刷新链 — 并行化+缩短等待,总耗时从~3.5s降至~1s ═══

    // Step 1: 清除旧的cachedPlanInfo(防止Windsurf继续用旧账号数据)
    _clearCachedPlanInfo();

    // Step 2+3: 并行执行PlanInfo刷新和认证会话刷新(互不依赖)
    const refreshTasks = [
      vscode.commands.executeCommand("windsurf.updatePlanInfo").catch(() => {}),
      vscode.commands.executeCommand("windsurf.refreshAuthenticationSession").catch(() => {}),
    ];
    await Promise.allSettled(refreshTasks);
    _logInfo("注入后刷新", "已并行刷新PlanInfo+认证会话");

    // Step 4: 短暂等待Windsurf内部状态同步(v14.0: 500ms足够,会话过渡由apiKey轮询保障)
    await new Promise((r) => setTimeout(r, 500));

    // Step 5: 验证apiKey已更新
    const newApiKey = _readAuthApiKeyPrefix();
    _logInfo("注入后刷新", `刷新后apiKey: ${newApiKey?.slice(0, 16) || "未知"}`);

    // Step 6: 异步验证热重置(不阻塞后续操作)
    if (_lastRotatedIds) {
      setTimeout(() => {
        try {
          const verify = hotVerify(_lastRotatedIds);
          if (verify.verified) {
            _hotResetVerified++;
            _logInfo("热重置", `✅ 验证成功 (#${_hotResetVerified}/${_hotResetCount})`);
          }
        } catch {}
      }, 3000);
    }
  } catch (e) {
    _logWarn("注入后刷新", "刷新序列异常(非关键)", e.message);
  }
}

/** Clear cachedPlanInfo from state.vscdb so workbench fetches fresh data from server.
 *  Root cause: after token injection, workbench continues using old account's cached plan. */
function _clearCachedPlanInfo() {
  try {
    const dbPath = getStateDbPath();
    if (!fs.existsSync(dbPath)) return;
    if (dbDeleteKey(dbPath, 'windsurf.settings.cachedPlanInfo')) {
      _logInfo("缓存", "已清除state.vscdb中的cachedPlanInfo");
    } else {
      _logWarn("缓存", "缓存清除跳过(非关键)");
    }
  } catch (e) {
    _logWarn("缓存", "清除cachedPlanInfo异常", e.message);
  }
}

/** v5.8.0: Direct DB injection — write new apiKey to windsurfAuthStatus in state.vscdb.
 *  This is the MOST RELIABLE injection path, bypassing VS Code command system entirely.
 *  Uses temp file to handle 49KB+ windsurfAuthStatus JSON (too large for CLI args).
 *  Returns { ok, oldPrefix, newPrefix } */
function _dbInjectApiKey(newApiKey) {
  try {
    const dbPath = getStateDbPath();
    if (!fs.existsSync(dbPath))
      return { ok: false, error: "state.vscdb not found" };

    // Step 1: Read current windsurfAuthStatus
    const currentJson = dbReadKey(dbPath, 'windsurfAuthStatus');
    if (!currentJson)
      return { ok: false, error: "windsurfAuthStatus not found" };

    // Step 2: Parse, replace apiKey
    const data = JSON.parse(currentJson);
    const oldPrefix = (data.apiKey || "").substring(0, 20);
    data.apiKey = newApiKey;

    // Step 3: Write back + clear cache in one transaction
    const ok = dbTransaction(dbPath, [
      { type: 'write', key: 'windsurfAuthStatus', value: JSON.stringify(data) },
      { type: 'delete', key: 'windsurf.settings.cachedPlanInfo' },
    ]);
    if (!ok) return { ok: false, error: "write failed" };

    const newPrefix = newApiKey.substring(0, 20);
    _logInfo("数据库", `apiKey更新: ${oldPrefix}→${newPrefix}`);
    return { ok: true, oldPrefix, newPrefix };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Read current windsurfAuthStatus apiKey prefix for injection verification */
function _readAuthApiKeyPrefix() {
  try {
    const dbPath = getStateDbPath();
    if (!fs.existsSync(dbPath)) return null;
    const raw = dbReadKey(dbPath, 'windsurfAuthStatus');
    if (!raw) return null;
    const d = JSON.parse(raw);
    return (d.apiKey || "").substring(0, 20) || null;
  } catch {
    return null;
  }
}

// ========== Fingerprint Rotation on Switch (v5.10.0→v7.0 热重置核心) ==========
// v5.10.0: serviceMachineId未轮转 → 服务端关联所有账号到同一设备
// v7.0: 轮转移到注入BEFORE → LS重启自动拿新ID = 热重置, requiresRestart=false
// 关键: 此函数必须在injectAuth()的任何injection strategy之前调用

/** Rotate device fingerprint for account switch (v7.0: pre-injection for hot reset) */
function _rotateFingerprintForSwitch() {
  try {
    // Step 1: Rotate in storage.json + machineid file (persists across restarts)
    const result = resetFingerprint({ backup: false }); // no backup on auto-rotate (avoid clutter)
    if (!result.ok) {
      _logWarn("指纹", "轮转失败", result.error);
      return;
    }
    const oldId = result.old["storage.serviceMachineId"]?.slice(0, 8) || "?";
    const newId = result.new["storage.serviceMachineId"]?.slice(0, 8) || "?";
    // v7.0: Save new IDs for post-injection hot verification
    _lastRotatedIds = result.new;
    _logInfo("指纹", `已轮转: ${oldId}→${newId} (已保存待验证)`);

    // Step 2: Also update state.vscdb for runtime effect
    // (LS may re-read serviceMachineId on next request or after restart)
    const dbPath = getStateDbPath();
    if (!fs.existsSync(dbPath)) return;

    const dbKeys = [
      "storage.serviceMachineId",
      "telemetry.devDeviceId",
      "telemetry.machineId",
      "telemetry.macMachineId",
      "telemetry.sqmId",
    ];
    const pairs = dbKeys
      .filter((k) => result.new[k])
      .map((k) => ({ key: k, value: result.new[k] }));

    if (pairs.length === 0) return;

    try {
      if (dbUpdateKeys(dbPath, pairs)) {
        _logInfo("指纹", "state.vscdb已更新(运行时生效)");
      } else {
        _logWarn("指纹", "state.vscdb更新跳过(非关键)");
      }
    } catch (e) {
      _logWarn("指纹", "state.vscdb更新跳过(非关键)", e.message);
    }
  } catch (e) {
    _logWarn("指纹", "指纹轮转异常(非关键)", e.message);
  }
}

// ========== Init Workspace (智慧部署 + 源启动) ==========

async function _doInitWorkspace(context) {
  // Get workspace path
  const wsFolders = vscode.workspace.workspaceFolders;
  const defaultPath =
    wsFolders && wsFolders.length > 0 ? wsFolders[0].uri.fsPath : "";

  const targetPath = await vscode.window.showInputBox({
    prompt: "目标工作区路径 (智慧部署)",
    placeHolder: defaultPath || "输入工作区绝对路径",
    value: defaultPath,
  });
  if (targetPath === undefined) return;

  const action = await vscode.window.showQuickPick(
    [
      { label: "🔍 扫描", description: "查看智慧模板安装状态", value: "scan" },
      {
        label: "⬇ 注入智慧框架",
        description: "部署规则+技能+工作流到目标工作区",
        value: "inject",
      },
      {
        label: "⬇ 注入(覆盖)",
        description: "覆盖已有文件重新注入",
        value: "inject_overwrite",
      },
      {
        label: "✨ 生成源启动提示词",
        description: "生成激活认知框架的初始提示词",
        value: "prompt",
      },
      {
        label: "🖥 检测环境",
        description: "检测IDE/OS/MCP/Python环境",
        value: "detect",
      },
      {
        label: "🌐 打开智慧部署器",
        description: "在浏览器打开 http://localhost:9876/",
        value: "browser",
      },
    ],
    { placeHolder: "选择操作", title: "工作区配置向导" },
  );

  if (!action) return;

  if (action.value === "browser") {
    vscode.env.openExternal(vscode.Uri.parse("http://localhost:9876/"));
    vscode.window.showInformationMessage(
      "WAM: 已打开智慧部署器 (需先启动: python 安全管理/windsurf_wisdom.py serve)",
    );
    return;
  }

  const base = "http://127.0.0.1:9876";
  const targ = targetPath.trim();

  const callApi = (apiPath, method = "GET", body = null) =>
    new Promise((resolve, reject) => {
      const url = new URL(base + apiPath);
      const bodyStr = body ? JSON.stringify(body) : null;
      const options = {
        hostname: url.hostname,
        port: parseInt(url.port) || 80,
        path: url.pathname + url.search,
        method,
        headers: bodyStr
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(bodyStr),
            }
          : {},
        timeout: 10000,
      };
      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (d) => {
          data += d;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ raw: data });
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });

  const tq = targ ? "?target=" + encodeURIComponent(targ) : "";

  try {
    if (action.value === "scan") {
      const r = await callApi("/api/scan" + tq);
      const ins = (r.exists || []).length;
      const mis = (r.missing || []).length;
      vscode.window
        .showInformationMessage(
          `WAM: 扫描 — ${ins}已安装 / ${mis}缺失\n${(r.missing || [])
            .slice(0, 5)
            .map((x) => "❌ " + x.key)
            .join(", ")}`,
          mis > 0 ? "注入缺失项" : "已完整",
        )
        .then((sel) => {
          if (sel === "注入缺失项") _doInitWorkspace(context);
        });
    } else if (
      action.value === "inject" ||
      action.value === "inject_overwrite"
    ) {
      const r = await callApi("/api/inject", "POST", {
        target: targ || undefined,
        overwrite: action.value === "inject_overwrite",
      });
      vscode.window.showInformationMessage(
        `WAM: 注入完成 — ${r.summary}\n注入项: ${(r.injected || [])
          .slice(0, 8)
          .map((x) => x.key)
          .join(", ")}`,
      );
    } else if (action.value === "prompt") {
      const r = await callApi("/api/prompt" + tq);
      const prompt = r.prompt || "";
      await vscode.env.clipboard.writeText(prompt);
      vscode.window
        .showInformationMessage(
          `WAM: 源启动提示词已生成并复制到剪贴板！(${r.ide} / ${(r.installed.rules || []).length}规则 / ${(r.installed.skills || []).length}技能)`,
          "打开智慧部署器",
        )
        .then((sel) => {
          if (sel === "打开智慧部署器")
            vscode.env.openExternal(vscode.Uri.parse("http://localhost:9876/"));
        });
    } else if (action.value === "detect") {
      const r = await callApi("/api/detect" + tq);
      const mcps = Object.entries(r.mcps_installed || {})
        .map(([k, v]) => (v ? "✅" : "❌") + k)
        .join(" ");
      vscode.window.showInformationMessage(
        `WAM: 环境 — IDE:${r.ide} OS:${r.os} Python:${r.python_ok ? "✅" : "❌"} 安全中枢:${r.security_hub_running ? "✅" : "❌"}\nMCP: ${mcps}`,
      );
    }
  } catch (e) {
    // Server unavailable → fall back to embedded bundle injection
    if (
      action.value === "inject" ||
      action.value === "inject_overwrite" ||
      action.value === "scan"
    ) {
      await _doEmbeddedWisdom(context, targ, action.value);
    } else {
      const choice = await vscode.window.showWarningMessage(
        "WAM: 智慧部署服务未运行。已切换到内置模板模式。\n可直接注入47个智慧模板(规则+技能+工作流)。",
        "内置注入",
        "启动服务器",
        "取消",
      );
      if (choice === "内置注入") {
        await _doEmbeddedWisdom(context, targ, "inject");
      } else if (choice === "启动服务器") {
        const terminal = vscode.window.createTerminal("智慧部署器");
        terminal.sendText("python 安全管理/windsurf_wisdom.py serve");
        terminal.show();
      }
    }
  }
}

// ========== Embedded Wisdom Bundle (离线注入, 无需Python服务器) ==========

/** Load wisdom_bundle.json from extension directory */
function _loadWisdomBundle(context) {
  try {
    const bundlePath = path.join(
      path.dirname(__dirname),
      "data",
      "wisdom_bundle.json",
    );
    // Try extension's own src/ first (dev mode)
    if (fs.existsSync(bundlePath)) {
      return JSON.parse(fs.readFileSync(bundlePath, "utf8"));
    }
    // Try installed extension path
    const extPath = context.extensionPath || context.extensionUri?.fsPath;
    if (extPath) {
      const altPath = path.join(extPath, "data", "wisdom_bundle.json");
      if (fs.existsSync(altPath)) {
        return JSON.parse(fs.readFileSync(altPath, "utf8"));
      }
    }
  } catch (e) {
    _logError("WISDOM", "failed to load wisdom bundle", e.message);
  }
  return null;
}

/** Embedded wisdom operations: scan, inject, inject_overwrite */
async function _doEmbeddedWisdom(context, targetPath, action) {
  const bundle = _loadWisdomBundle(context);
  if (!bundle || !bundle.templates) {
    vscode.window.showErrorMessage("WAM: 智慧模板包未找到。请重新安装插件。");
    return;
  }

  const root =
    targetPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
  if (!root) {
    vscode.window.showWarningMessage("WAM: 未指定目标工作区。");
    return;
  }

  const templates = bundle.templates;
  const overwrite = action === "inject_overwrite";

  if (action === "scan") {
    // Scan: check which templates exist in target
    let exists = 0,
      missing = 0;
    const missingList = [];
    for (const [key, tmpl] of Object.entries(templates)) {
      const fpath = path.join(root, tmpl.path);
      if (fs.existsSync(fpath)) {
        exists++;
      } else {
        missing++;
        missingList.push(key);
      }
    }
    const sel = await vscode.window.showInformationMessage(
      `WAM: 扫描(内置) — ${exists}已安装 / ${missing}缺失 / ${Object.keys(templates).length}总计\n` +
        `缺失: ${missingList.slice(0, 8).join(", ")}${missingList.length > 8 ? "..." : ""}`,
      missing > 0 ? "注入缺失项" : "已完整",
    );
    if (sel === "注入缺失项") {
      await _doEmbeddedWisdom(context, root, "inject");
    }
    return;
  }

  // Inject: select categories
  const catPick = await vscode.window.showQuickPick(
    [
      {
        label: "🌟 全部注入",
        description: `${Object.keys(templates).length}个模板`,
        value: "all",
      },
      {
        label: "📐 仅规则",
        description: "kernel + protocol (Agent行为框架)",
        value: "rule",
      },
      {
        label: "🎯 仅技能",
        description: "32个通用技能 (错误诊断/代码质量/Git等)",
        value: "skill",
      },
      {
        label: "🔄 仅工作流",
        description: "13个工作流 (审查/循环/开发等)",
        value: "workflow",
      },
      {
        label: "🔧 选择性注入",
        description: "手动选择要注入的模板",
        value: "pick",
      },
    ],
    { placeHolder: `注入到: ${root}`, title: "选择注入范围" },
  );
  if (!catPick) return;

  let selectedKeys;
  if (catPick.value === "all") {
    selectedKeys = Object.keys(templates);
  } else if (catPick.value === "pick") {
    const items = Object.entries(templates).map(([key, tmpl]) => ({
      label: `${tmpl.category === "rule" ? "📐" : tmpl.category === "skill" ? "🎯" : "🔄"} ${key}`,
      description: tmpl.desc.slice(0, 60),
      picked: true,
      key,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: "选择要注入的模板",
      title: `${items.length}个可用模板`,
    });
    if (!picked || picked.length === 0) return;
    selectedKeys = picked.map((p) => p.key);
  } else {
    selectedKeys = Object.entries(templates)
      .filter(([_, t]) => t.category === catPick.value)
      .map(([k]) => k);
  }

  // Execute injection
  let injected = 0,
    skipped = 0,
    errors = 0;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "WAM: 注入智慧模板",
      cancellable: false,
    },
    async (progress) => {
      for (let i = 0; i < selectedKeys.length; i++) {
        const key = selectedKeys[i];
        const tmpl = templates[key];
        if (!tmpl) continue;
        progress.report({
          message: `${key} (${i + 1}/${selectedKeys.length})`,
          increment: 100 / selectedKeys.length,
        });

        const fpath = path.join(root, tmpl.path);
        if (fs.existsSync(fpath) && !overwrite) {
          skipped++;
          continue;
        }

        try {
          const dir = path.dirname(fpath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(fpath, tmpl.content, "utf8");
          // Write supporting files if any
          if (tmpl.supporting) {
            const parentDir = path.dirname(fpath);
            for (const [sfName, sfContent] of Object.entries(tmpl.supporting)) {
              fs.writeFileSync(path.join(parentDir, sfName), sfContent, "utf8");
            }
          }
          injected++;
        } catch (e) {
          errors++;
          _logError("WISDOM", `inject ${key} failed`, e.message);
        }
      }
    },
  );

  vscode.window.showInformationMessage(
    `WAM: 注入完成 — ${injected}成功 / ${skipped}跳过 / ${errors}失败\n` +
      `路径: ${root}/.windsurf/`,
  );
}

function deactivate() {
  _deregisterWindow();
  if (_poolTimer) { clearTimeout(_poolTimer); _poolTimer = null; }
  if (_windowTimer) { clearInterval(_windowTimer); _windowTimer = null; }
  if (am) am.dispose();
  if (auth) auth.dispose();
  if (statusBar) statusBar.dispose();
}

export { activate, deactivate };
