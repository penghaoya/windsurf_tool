/**
 * 号池引擎配置常量
 * 所有魔法数字、正则表达式、模型配置集中管理
 */

// ═══ 限流检测正则 ═══
export const TIER_RL_RE = /rate\s*limit\s*exceeded[\s\S]*?no\s*credits\s*were\s*used/i;
export const UPGRADE_PRO_RE = /upgrade\s*to\s*a?\s*pro/i;
export const ABOUT_HOUR_RE = /try\s*again\s*in\s*about\s*an?\s*hour/i;
export const MODEL_UNREACHABLE_RE = /model\s*provider\s*unreachable/i;
export const PROVIDER_ERROR_RE = /provider.*(?:error|unavailable|unreachable)|(?:error|unavailable|unreachable).*provider/i;
export const GLOBAL_TRIAL_RL_RE = /(?:all\s*)?(?:API\s*)?providers?\s*(?:are\s*)?over\s*(?:their\s*)?(?:global\s*)?rate\s*limit\s*for\s*trial/i;

// ═══ Gate 4: 层级限流 ═══
export const HOUR_WINDOW = 3600000;
export const TIER_MSG_CAP_ESTIMATE = 25;
export const TIER_CAP_WARN_RATIO = 0.7;
export const GLOBAL_TRIAL_POOL_COOLDOWN_SEC = 1200;

// ═══ 多窗口协调 ═══
export const WINDOW_STATE_FILE = "wam-window-state.json";
export const WINDOW_HEARTBEAT_MS = 30000;
export const WINDOW_DEAD_MS = 90000;
export const CACHE_TTL = 5000;

// ═══ 号池轮询 ═══
export const POLL_NORMAL = 45000;
export const POLL_BOOST = 8000;
export const POLL_BURST = 3000;
export const BOOST_DURATION = 300000;
export const DEFAULT_PREEMPTIVE_THRESHOLD = 15;

// ═══ 斜率预测 ═══
export const SLOPE_WINDOW = 5;
export const SLOPE_HORIZON = 300000;

// ═══ 并发Tab感知 ═══
export const CONCURRENT_TAB_SAFE = 2;
export const MSG_RATE_WINDOW = 60000;
export const MSG_RATE_LIMIT = 12;
export const BURST_DETECT_THRESHOLD = 0.7;
export const TAB_CHECK_INTERVAL = 10000;

// ═══ 全池监控 ═══
export const FULL_SCAN_INTERVAL_NORMAL = 300000;
export const FULL_SCAN_INTERVAL_BOOST = 120000;
export const FULL_SCAN_INTERVAL_BURST = 60000;
export const REACTIVE_SWITCH_CD = 10000;
export const REACTIVE_DROP_MIN = 5;
export const UFEF_COOLDOWN = 600000;

// ═══ 速度检测 ═══
export const VELOCITY_WINDOW = 120000;
export const VELOCITY_THRESHOLD = 10;

// ═══ Opus模型配置 ═══
export const OPUS_VARIANTS = [
  'claude-opus-4-6-thinking-1m',
  'claude-opus-4-6-thinking',
  'claude-opus-4-6-1m',
  'claude-opus-4-6',
  'claude-opus-4-6-thinking-fast',
  'claude-opus-4-6-fast',
];
export const SONNET_FALLBACK = 'claude-sonnet-4-6-thinking-1m';

// ═══ Opus消息预算 ═══
export const OPUS_THINKING_1M_BUDGET = 1;
export const OPUS_THINKING_BUDGET = 2;
export const OPUS_REGULAR_BUDGET = 3;
export const OPUS_BUDGET_WINDOW = 1200000;
export const OPUS_PREEMPT_RATIO = 1.0;
export const OPUS_COOLDOWN_DEFAULT = 1500;
export const CAPACITY_CHECK_THINKING = 3000;

// ═══ L5容量探测 ═══
export const CAPACITY_CHECK_INTERVAL = 45000;
export const CAPACITY_CHECK_FAST = 15000;
export const CAPACITY_PREEMPT_REMAINING = 2;
export const L5_NODATA_SLOWDOWN_AFTER = 5;
export const L5_NODATA_MAX_INTERVAL = 120000;
export const APIKEY_CACHE_TTL = 120000;

// ═══ 杂项 ═══
export const MAX_EVENT_LOG = 200;
export const TRIAL_POOL_COOLDOWN_RETRY_CD = 60000;

// ═══ 限流检测上下文键 ═══
export const RATE_LIMIT_CONTEXTS = [
  "chatQuotaExceeded",
  "rateLimitExceeded",
  "windsurf.quotaExceeded",
  "windsurf.rateLimited",
  "cascade.rateLimited",
  "windsurf.messageRateLimited",
  "windsurf.modelRateLimited",
  "windsurf.permissionDenied",
  "windsurf.modelProviderUnreachable",
  "cascade.modelProviderUnreachable",
  "windsurf.connectionError",
  "cascade.error",
];

// ═══ 纯模型辅助函数 (仅依赖常量) ═══

export function isOpusModel(uid) {
  return uid && OPUS_VARIANTS.some((v) => uid.includes(v.replace("claude-", "")));
}

export function isThinkingModel(uid) {
  return uid && /thinking/i.test(uid);
}

export function isThinking1MModel(uid) {
  return uid && /thinking/i.test(uid) && /1m/i.test(uid) && !/fast/i.test(uid);
}

export function getModelBudget(uid) {
  if (!uid) return OPUS_REGULAR_BUDGET;
  if (isThinking1MModel(uid)) return OPUS_THINKING_1M_BUDGET;
  if (isThinkingModel(uid)) return OPUS_THINKING_BUDGET;
  return OPUS_REGULAR_BUDGET;
}

export function getModelVariants(uid) {
  if (isOpusModel(uid)) return [...OPUS_VARIANTS];
  return [uid];
}

export function getModelFamily(uid) {
  if (!uid) return 'unknown';
  if (isOpusModel(uid)) return 'opus';
  if (/sonnet/i.test(uid)) return 'sonnet';
  if (/haiku/i.test(uid)) return 'haiku';
  return 'other';
}

/** 响应式切换按账号类型差异化阈值 */
export function getReactiveDropMin(isTrialLike, selectionMode) {
  if (isTrialLike) return 3; // Trial: 额度跳跃更大,用更低阈值快速响应
  if (selectionMode === 'credits') return 8; // Credits: 消耗更均匀,用更高阈值避免噪音
  return REACTIVE_DROP_MIN; // Pro/Quota: 默认5%
}
