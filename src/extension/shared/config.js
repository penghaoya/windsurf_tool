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

/** TeamsTier enum → PLAN_TIERS 精确映射 (来自 GetUserStatus)
 *  参考 proto: 1=Teams 2=Pro 3=EnterpriseSaaS 4=Hybrid 5=EnterpriseSelfHosted
 *              6=WaitlistPro 7=TeamsUltimate 8=ProUltimate 9=Trial
 *              10=EnterpriseSelfServe 11=EnterpriseSaaSPooled
 *              12=DevinEnterprise 16=DevinPro 17=DevinMax 18=Max
 *              19=DevinFree 20=DevinTrial */
export function tierFromTeamsTier(tierNum) {
  const n = Number(tierNum);
  if (!Number.isFinite(n)) return null;
  if (n === 18 || n === 17) return PLAN_TIERS.MAX;
  if (n === 3 || n === 4 || n === 5 || n === 10 || n === 11 || n === 12) return PLAN_TIERS.ENTERPRISE;
  if (n === 1 || n === 7 || n === 14 || n === 15) return PLAN_TIERS.TEAMS;
  if (n === 2 || n === 8 || n === 16) return PLAN_TIERS.PRO;
  if (n === 0 || n === 6 || n === 9 || n === 19 || n === 20) return PLAN_TIERS.FREE;
  return null;  // unknown tier — caller falls back to string heuristic
}

/** 从 plan 字符串 (GetPlanStatus) 或 usage 对象 (含 teamsTier) 推断层级
 *  优先使用精确的 teamsTier (来自 GetUserStatus), 退化到字符串匹配 */
export function getPlanTier(planOrUsage) {
  if (!planOrUsage) return PLAN_TIERS.FREE;
  // Object with precise teamsTier (from GetUserStatus)
  if (typeof planOrUsage === 'object') {
    const precise = tierFromTeamsTier(planOrUsage.teamsTier);
    if (precise) return precise;
    // Fall back to plan string on this object
    planOrUsage = planOrUsage.plan;
    if (!planOrUsage) return PLAN_TIERS.FREE;
  }
  const p = String(planOrUsage).toLowerCase().trim();
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

/** 检测账号是否处于 Trial (限时 Pro) — 需用 plan 字符串 (tierName 不区分 Trial/Free)
 *  与 isTierFree 区别: Trial 也是 FREE 桶, 但 Trial 应参与轮转, 而真 Free 不应 */
export function isTrialPlan(account) {
  const p = String(account?.usage?.plan || '').toLowerCase();
  return p.includes('trial');
}

// ═══ 号池轮询 ═══
export const POLL_NORMAL = 45000;
export const POLL_BOOST = 8000;
export const POLL_BURST = 3000;
export const BOOST_DURATION = 300000;
export const DEFAULT_PREEMPTIVE_THRESHOLD = 15;

// ═══ 空闲降频 (v19.1) ═══
export const IDLE_STRETCH_AFTER = 3;          // 连续N次无变化后开始拉长
export const IDLE_POLL_MAX = 90000;           // 空闲最大间隔 90s (normal 45s 的 2x)
export const IDLE_POLL_STEP = 15000;          // 每多一次无变化 +15s

// ═══ 斜率预测 ═══
export const SLOPE_WINDOW = 5;
export const SLOPE_HORIZON = 300000;
export const SLOPE_MIN_POINTS = 3;           // v21.0: 至少3个数据点才预测 (防单次drop误判)
export const SLOPE_MIN_SPAN = 120000;         // v21.0: 至少2min时间跨度才预测

// ═══ 并发Tab感知 ═══
export const CONCURRENT_TAB_SAFE = 5;         // v21.0: 2→5, 避免少量tab误触BURST
export const MSG_RATE_WINDOW = 60000;
export const MSG_RATE_LIMIT = 12;
export const BURST_DETECT_THRESHOLD = 0.7;
export const TAB_CHECK_INTERVAL = 10000;

// ═══ 防封控 (v18.0) ═══
export const MIN_SWITCH_INTERVAL = 30000;     // 两次自动切换最小间隔 30s
export const MAX_SWITCHES_PER_HOUR = 30;      // 每小时最大自动切换次数
export const POST_SWITCH_SUPPRESS_MS = 30000; // v21.0: 切号后抑制预防性评估 (防low切号风暴)
export const TAB_PRESSURE_STARTUP_GRACE = 60000; // v21.0: 启动后60s内不触发tab_pressure
export const ANTI_BOUNCE_MS = 300000;            // v22.1: 防回切 — 5min内不回切刚离开的号

// ═══ 全池监控 ═══
export const FULL_SCAN_INTERVAL_NORMAL = 300000;
export const FULL_SCAN_INTERVAL_BOOST = 120000;
export const FULL_SCAN_INTERVAL_BURST = 60000;
export const PREHEAT_FRESHNESS_TTL = 300000;  // 预热新鲜度: 5min内有数据跳过网络请求
export const PREHEAT_TIMEOUT = 5000;           // 预热网络超时 5s
export const REACTIVE_SWITCH_CD = 10000;
export const REACTIVE_DROP_MIN = 5;
export const FULL_SCAN_CONCURRENCY = 3;       // 全池扫描并发数 (v19.1: 从1提升到3)
export const FULL_SCAN_STALE_MULTIPLIER = 3;  // 连续无变化账号跳过倍率 (FRESH_SKIP×3=30min)
export const UFEF_COOLDOWN = 600000;
export const WEEKLY_RESET_DETECT_RATIO = 0.8; // v21.0: ≥80%账号同方向大幅变动 → 周重置事件
export const WEEKLY_RESET_COOLDOWN = 600000;  // v21.0: 周重置检测后延迟10min再扫描
export const FULL_SCAN_CONSECUTIVE_FAIL_LIMIT = 5; // v21.0: 连续N个401失败 → 暂停该批

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

// ═══ L5容量探测间隔 ═══
export const CAPACITY_CHECK_THINKING = 3000;

// ═══ UID → Proto Name 模型映射 (v25.0, from windsurf-pool-7.7.0) ═══
// CheckUserMessageRateLimit 需要 proto model name 才能返回精确 per-model 数据。
// 数据来源: WindsurfAPI/src/models.js + GetUserStatus cascadeAllowedModelsConfig。
export const UID_PROTO_MAP = {
  // ── Claude ──
  'claude-4-sonnet': 'MODEL_CLAUDE_4_SONNET',
  'claude-4-sonnet-thinking': 'MODEL_CLAUDE_4_SONNET_THINKING',
  'claude-4-opus': 'MODEL_CLAUDE_4_OPUS',
  'claude-4-opus-thinking': 'MODEL_CLAUDE_4_OPUS_THINKING',
  'claude-4-1-opus': 'MODEL_CLAUDE_4_1_OPUS',
  'claude-4-1-opus-thinking': 'MODEL_CLAUDE_4_1_OPUS_THINKING',
  'claude-4-5-haiku': 'MODEL_PRIVATE_11',
  'claude-4-5-sonnet': 'MODEL_PRIVATE_2',
  'claude-4-5-sonnet-thinking': 'MODEL_PRIVATE_3',
  'claude-4-5-opus': 'MODEL_CLAUDE_4_5_OPUS',
  'claude-4-5-opus-thinking': 'MODEL_CLAUDE_4_5_OPUS_THINKING',
  'claude-sonnet-4-6': 'MODEL_PRIVATE_2',
  'claude-sonnet-4-6-thinking': 'MODEL_PRIVATE_3',
  'claude-opus-4-6': 'MODEL_CLAUDE_4_5_OPUS',
  'claude-opus-4-6-thinking': 'MODEL_CLAUDE_4_5_OPUS_THINKING',
  'claude-sonnet-4-6-1m': 'claude-sonnet-4-6-1m',
  'claude-sonnet-4-6-thinking-1m': 'claude-sonnet-4-6-thinking-1m',
  'claude-opus-4-6-1m': 'claude-opus-4-6-1m',
  'claude-opus-4-6-thinking-1m': 'claude-opus-4-6-thinking-1m',
  // ── GPT ──
  'gpt-4o': 'MODEL_CHAT_GPT_4O_2024_08_06',
  'gpt-4-1': 'MODEL_CHAT_GPT_4_1_2025_04_14',
  'gpt-4-1-mini': 'MODEL_CHAT_GPT_4_1_MINI_2025_04_14',
  'gpt-5': 'MODEL_PRIVATE_6',
  'gpt-5-medium': 'MODEL_PRIVATE_7',
  'gpt-5-high': 'MODEL_PRIVATE_8',
  'gpt-5-codex': 'MODEL_CHAT_GPT_5_CODEX',
  'gpt-5-nano': 'MODEL_GPT_5_NANO',
  'gpt-5-2': 'MODEL_GPT_5_2_MEDIUM',
  'gpt-5-2-none': 'MODEL_GPT_5_2_NONE',
  'gpt-5-2-low': 'MODEL_GPT_5_2_LOW',
  'gpt-5-2-high': 'MODEL_GPT_5_2_HIGH',
  'gpt-5-2-xhigh': 'MODEL_GPT_5_2_XHIGH',
  'gpt-5-1': 'MODEL_PRIVATE_12',
  'gpt-5.4': 'gpt-5-4-low',
  'gpt-5-4': 'gpt-5-4-low',
  'gpt-5-4-none': 'gpt-5-4-none',
  'gpt-5-4-low': 'gpt-5-4-low',
  'gpt-5-4-medium': 'gpt-5-4-medium',
  'gpt-5-4-high': 'gpt-5-4-high',
  'gpt-5-4-xhigh': 'gpt-5-4-xhigh',
  'gpt-5.4-mini': 'gpt-5-4-mini-low',
  'gpt-5-4-mini-low': 'gpt-5-4-mini-low',
  'gpt-5-4-mini-medium': 'gpt-5-4-mini-medium',
  'gpt-5-4-mini-high': 'gpt-5-4-mini-high',
  'gpt-5-4-mini-xhigh': 'gpt-5-4-mini-xhigh',
  'gpt-5.5': 'gpt-5-5-low',
  'gpt-5-5': 'gpt-5-5-low',
  'gpt-5-5-none': 'gpt-5-5-none',
  'gpt-5-5-low': 'gpt-5-5-low',
  'gpt-5-5-medium': 'gpt-5-5-medium',
  'gpt-5-5-high': 'gpt-5-5-high',
  'gpt-5-5-xhigh': 'gpt-5-5-xhigh',
  'gpt-5-5-review': 'gpt-5-5-review',
  // ── O-series ──
  'o3': 'MODEL_CHAT_O3',
  'o3-high': 'MODEL_CHAT_O3_HIGH',
  // ── Gemini ──
  'gemini-2-5-pro': 'MODEL_GOOGLE_GEMINI_2_5_PRO',
  'gemini-2-5-flash': 'MODEL_GOOGLE_GEMINI_2_5_FLASH',
  'gemini-2-5-flash-thinking': 'MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING',
  'gemini-3-0-flash': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM',
  'gemini-3-0-flash-low': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW',
  'gemini-3-0-flash-high': 'MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH',
  'gemini-3-pro': 'gemini-3-pro',
  'gemini-3.0-flash': 'gemini-3-0-flash',
  'gemini-3-1-pro-low': 'gemini-3-1-pro-low',
  'gemini-3-1-pro-high': 'gemini-3-1-pro-high',
  'gemini-3.1-pro': 'gemini-3-1-pro-low',
  'gemini-3-1-pro': 'gemini-3-1-pro-low',
  // ── Grok ──
  'grok-3': 'MODEL_XAI_GROK_3',
  'grok-3-mini-thinking': 'MODEL_XAI_GROK_3_MINI_REASONING',
  // ── SWE ──
  'swe-1-5': 'MODEL_SWE_1_5_SLOW',
  'swe-1-5-fast': 'MODEL_SWE_1_5',
  'swe-1-6': 'MODEL_SWE_1_6',
  'swe-1-6-fast': 'MODEL_SWE_1_6_FAST',
  // ── GLM ──
  'glm-4-7': 'MODEL_GLM_4_7',
  'glm-5.1': 'glm-5-1',
  'glm-5-1': 'glm-5-1',
  // ── Kimi ──
  'kimi-k2': 'MODEL_KIMI_K2',
  'kimi-k2.5': 'kimi-k2-5',
  'kimi-k2-5': 'kimi-k2-5',
  'kimi-k2.6': 'kimi-k2-6',
  'kimi-k2-6': 'kimi-k2-6',
  // ── MiniMax ──
  'minimax-m2-5': 'MODEL_MINIMAX_M2_1',
};

/** Resolve model UID to proto name for CheckUserMessageRateLimit */
export function resolveModelProtoName(uid) {
  if (!uid) return '';
  return UID_PROTO_MAP[uid] || uid;
}

// ═══ L5容量探测 ═══
export const L5_ENABLED = true;  // JSON Connect-RPC CheckUserMessageRateLimit (v20.0: 从 binary proto 迁移到 JSON, 参考 WindsurfAPI)
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

/** 响应式切换按层级差异化阈值 — 支持 tier 字符串或旧 boolean
 *  v20.2: 数值整体上调 — 原阈值过低导致单账号仅消耗 3-7% 就被切走，
 *         整池额度利用率不足 1/账号数。新阈值让单账号深度消耗后再切。
 *  Free 不参与调度 (allowFree=false)，但 Trial 走 FREE 桶仍需此阈值保护。 */
export function getReactiveDropMin(tierOrBool, selectionMode) {
  const tier = typeof tierOrBool === 'boolean'
    ? (tierOrBool ? PLAN_TIERS.FREE : PLAN_TIERS.PRO)
    : (tierOrBool || PLAN_TIERS.FREE);
  if (isTierFree(tier)) return 5;  // Trial: 数据跳跃稍大,5% 平衡保护与利用率
  if (selectionMode === 'credits') return 15; // Enterprise Credits: 充裕,可深度消耗
  if (tier === PLAN_TIERS.MAX) return 15; // Max: 额度最充裕
  return 10; // Pro/Teams: 默认 10% (从 5% 上调)
}

/** 层级差异化预防性切换阈值 (% 额度) — Free 更早切, Max 更晚切 */
export function getTierPreemptiveThreshold(tier, userOverride) {
  if (userOverride !== undefined && userOverride !== null) return userOverride;
  if (tier === PLAN_TIERS.MAX) return 8;
  if (isTierFree(tier)) return 20;
  return DEFAULT_PREEMPTIVE_THRESHOLD; // Pro/Teams/Enterprise: 15%
}
