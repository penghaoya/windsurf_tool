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

// ═══ 计划层级 (2026-03 Windsurf 定价改革) ═══
// Free=免费无extra usage, Pro=$20/月, Max=$200/月, Teams=$40/座/月, Enterprise=credits
export const PLAN_TIERS = { FREE: 'free', PRO: 'pro', MAX: 'max', TEAMS: 'teams', ENTERPRISE: 'enterprise' };

/** 从 plan 字符串 (GetPlanStatus 返回) 推断层级 */
export function getPlanTier(planStr) {
  if (!planStr) return PLAN_TIERS.FREE;
  const p = String(planStr).toLowerCase().trim();
  if (p.includes('enterprise')) return PLAN_TIERS.ENTERPRISE;
  if (p.includes('max')) return PLAN_TIERS.MAX;
  if (p.includes('team')) return PLAN_TIERS.TEAMS;
  if (p.includes('pro')) return PLAN_TIERS.PRO;
  return PLAN_TIERS.FREE; // free / trial / unknown → 最保守
}

/** 层级是否为 Free/Trial 类 (无 extra usage, 最受限) */
export function isTierFree(tier) { return !tier || tier === PLAN_TIERS.FREE; }

/** 层级是否为付费类 (Pro/Max/Teams/Enterprise) */
export function isTierPaid(tier) { return tier && tier !== PLAN_TIERS.FREE; }

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

// ═══ 防封控 (v18.0) ═══
export const MIN_SWITCH_INTERVAL = 30000;     // 两次自动切换最小间隔 30s
export const MAX_SWITCHES_PER_HOUR = 30;      // 每小时最大自动切换次数

// ═══ 全池监控 ═══
export const FULL_SCAN_INTERVAL_NORMAL = 300000;
export const FULL_SCAN_INTERVAL_BOOST = 120000;
export const FULL_SCAN_INTERVAL_BURST = 60000;
export const PREHEAT_FRESHNESS_TTL = 300000;  // 预热新鲜度: 5min内有数据跳过网络请求
export const PREHEAT_TIMEOUT = 5000;           // 预热网络超时 5s
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
export const SWE_FREE_FALLBACK = 'swe-1.5';  // 免费模型,不消耗 quota

// ═══ 模型 Credit 成本估算 (基于社区观测) ═══
// Trial: 100 credits/2周 ≈ 7/天, Pro: 500/月 ≈ 16.7/天
export const MODEL_CREDIT_COST = {
  opus_thinking_1m: 10,
  opus_thinking: 5,
  opus_regular: 3,
  sonnet: 1,
  default: 1,
};

// ═══ Opus消息预算 ═══
export const OPUS_THINKING_1M_BUDGET = 1;
export const OPUS_THINKING_BUDGET = 2;
export const OPUS_REGULAR_BUDGET = 3;
// 各层级 Opus 预算倍率 (相对 Free/Trial 基准)
export const OPUS_BUDGET_MULTIPLIER_PRO = 3;   // Pro: ×3
export const OPUS_BUDGET_MULTIPLIER_MAX = 10;  // Max($200/月): ×10
export const OPUS_BUDGET_WINDOW = 1200000;
export const OPUS_PREEMPT_RATIO = 1.0;
export const OPUS_COOLDOWN_DEFAULT = 1500;
export const CAPACITY_CHECK_THINKING = 3000;

// ═══ L5容量探测 ═══
export const L5_ENABLED = false;  // gRPC CheckUserMessageRateLimit (Proto schema 已变更, 服务端返回400, 暂禁用)
export const CAPACITY_CHECK_INTERVAL = 45000;
export const CAPACITY_CHECK_FAST = 15000;
export const CAPACITY_PREEMPT_REMAINING = 2;
export const L5_NODATA_SLOWDOWN_AFTER = 5;
export const L5_NODATA_MAX_INTERVAL = 120000;
export const APIKEY_CACHE_TTL = 120000;

// ═══ 候选过滤 ═══
export const MIN_DAILY_QUOTA_FOR_SWITCH = 5;

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

/** 层级感知的 Opus 预算 — Max > Pro > Free
 *  tier 参数: PLAN_TIERS 值, 或兼容旧的 boolean (true=Free) */
export function getModelBudgetForTier(uid, tierOrBool = PLAN_TIERS.FREE) {
  const base = getModelBudget(uid);
  const tier = typeof tierOrBool === 'boolean'
    ? (tierOrBool ? PLAN_TIERS.FREE : PLAN_TIERS.PRO)
    : (tierOrBool || PLAN_TIERS.FREE);
  if (tier === PLAN_TIERS.MAX) return base * OPUS_BUDGET_MULTIPLIER_MAX;
  if (tier === PLAN_TIERS.PRO || tier === PLAN_TIERS.TEAMS) return base * OPUS_BUDGET_MULTIPLIER_PRO;
  if (tier === PLAN_TIERS.ENTERPRISE) return base * OPUS_BUDGET_MULTIPLIER_PRO;
  return base; // Free/Trial: 基础预算
}

/** 获取模型每次消息的预估 credit 成本 */
export function getModelCreditCost(uid) {
  if (!uid) return MODEL_CREDIT_COST.default;
  if (isThinking1MModel(uid)) return MODEL_CREDIT_COST.opus_thinking_1m;
  if (isOpusModel(uid) && isThinkingModel(uid)) return MODEL_CREDIT_COST.opus_thinking;
  if (isOpusModel(uid)) return MODEL_CREDIT_COST.opus_regular;
  return MODEL_CREDIT_COST.default;
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

/** 响应式切换按层级差异化阈值 — 支持 tier 字符串或旧 boolean */
export function getReactiveDropMin(tierOrBool, selectionMode) {
  const tier = typeof tierOrBool === 'boolean'
    ? (tierOrBool ? PLAN_TIERS.FREE : PLAN_TIERS.PRO)
    : (tierOrBool || PLAN_TIERS.FREE);
  if (isTierFree(tier)) return 3;  // Free: 额度跳跃更大,用更低阈值快速响应
  if (selectionMode === 'credits') return 8; // Enterprise Credits: 消耗更均匀
  if (tier === PLAN_TIERS.MAX) return 8; // Max: 额度充裕,提高阈值减少噪音
  return REACTIVE_DROP_MIN; // Pro/Teams: 默认5%
}

/** 层级差异化预防性切换阈值 (% 额度) — Free 更早切, Max 更晚切 */
export function getTierPreemptiveThreshold(tier, userOverride) {
  if (userOverride !== undefined && userOverride !== null) return userOverride;
  if (tier === PLAN_TIERS.MAX) return 8;
  if (isTierFree(tier)) return 20;
  return DEFAULT_PREEMPTIVE_THRESHOLD; // Pro/Teams/Enterprise: 15%
}
