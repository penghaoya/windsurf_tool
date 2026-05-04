/**
 * 账号列表视图状态 — 排序 + 筛选 + 搜索 + localStorage 持久化
 *
 * 数据流: props.accounts → filter (status/tier/search) → sort → filteredAccounts
 * 筛选/排序偏好自动持久化到 localStorage (key: STORAGE_KEY).
 */
import { reactive, computed, watch } from 'vue'

const STORAGE_KEY = 'wam.accountView.v1'

export const SORT_OPTIONS = [
  { value: 'default',       label: '添加顺序' },
  { value: 'quota_desc',    label: '额度 高→低' },
  { value: 'quota_asc',     label: '额度 低→高' },
  { value: 'expiry_asc',    label: '到期紧迫' },
  { value: 'login_desc',    label: '切换最多' },
  { value: 'login_asc',     label: '切换最少' },
  { value: 'added_desc',    label: '最近添加' },
  { value: 'email_asc',     label: '邮箱 A-Z' },
]

export const STATUS_OPTIONS = [
  { value: 'all',       label: '全部' },
  { value: 'available', label: '可用' },
  { value: 'rl',        label: '限流' },
  { value: 'badauth',   label: '坏号' },
  { value: 'expired',   label: '过期' },
]

// Tier value must match PLAN_TIERS in shared/config.js
export const TIER_OPTIONS = [
  { value: 'all',        label: '全部' },
  { value: 'free',       label: 'Free/Trial' },
  { value: 'pro',        label: 'Pro' },
  { value: 'max',        label: 'Max' },
  { value: 'teams',      label: 'Teams' },
  { value: 'enterprise', label: 'Enterprise' },
]

const DEFAULT_VIEW = {
  sortBy: 'default',
  statusFilter: 'all',
  tierFilter: 'all',
  searchText: '',
}

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_VIEW }
    const data = JSON.parse(raw)
    // Don't persist searchText across sessions (ephemeral UX)
    return { ...DEFAULT_VIEW, ...data, searchText: '' }
  } catch { return { ...DEFAULT_VIEW } }
}

// Singleton reactive state (shared across components)
export const viewState = reactive(loadPersisted())

watch(
  () => ({ sortBy: viewState.sortBy, statusFilter: viewState.statusFilter, tierFilter: viewState.tierFilter }),
  (v) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)) } catch {}
  },
  { deep: true },
)

export function resetView() {
  Object.assign(viewState, DEFAULT_VIEW)
}

// Heuristic tier derivation: prefer precise teamsTier (via usage.tierName),
// fall back to plan string matching. Keep in sync with shared/config.js getPlanTier.
function deriveTier(account) {
  const u = account?.usage
  if (!u) return 'free'
  if (u.tierName === 'free') return 'free'
  const p = String(u.plan || '').toLowerCase()
  if (p.includes('enterprise')) return 'enterprise'
  if (p.includes('max')) return 'max'
  if (p.includes('team')) return 'teams'
  if (p.includes('pro')) return 'pro'
  // tierName === 'pro' but plan doesn't match → default to pro
  if (u.tierName === 'pro') return 'pro'
  return 'free'
}

function matchesStatus(account, status) {
  if (status === 'all') return true
  const isRL = !!account.rateLimit || !!account.schedulerBlocked
  const isBad = !!account.invalidAuth
  const isExp = !!account.isExpired
  if (status === 'rl') return isRL
  if (status === 'badauth') return isBad
  if (status === 'expired') return isExp
  if (status === 'available') return !isRL && !isBad && !isExp && !account.dailyDepleted
  return true
}

function matchesTier(account, tier) {
  if (tier === 'all') return true
  return deriveTier(account) === tier
}

function matchesSearch(account, search) {
  if (!search) return true
  const q = search.toLowerCase().trim()
  if (!q) return true
  return String(account.email || '').toLowerCase().includes(q)
}

function compareBy(sortBy) {
  const tieIdx = (a, b) => (a.index ?? 0) - (b.index ?? 0)
  switch (sortBy) {
    case 'quota_desc':
      return (a, b) => ((b.effective ?? -1) - (a.effective ?? -1)) || tieIdx(a, b)
    case 'quota_asc':
      return (a, b) => ((a.effective ?? 101) - (b.effective ?? 101)) || tieIdx(a, b)
    case 'expiry_asc':
      // Lower urgency = more urgent; null/unknown sort last
      return (a, b) => {
        const au = a.urgency ?? 99, bu = b.urgency ?? 99
        if (au !== bu) return au - bu
        const ae = a.planEnd ?? Infinity, be = b.planEnd ?? Infinity
        return ae - be || tieIdx(a, b)
      }
    case 'login_desc':
      return (a, b) => ((b.loginCount || 0) - (a.loginCount || 0)) || tieIdx(a, b)
    case 'login_asc':
      return (a, b) => ((a.loginCount || 0) - (b.loginCount || 0)) || tieIdx(a, b)
    case 'added_desc':
      return (a, b) => ((b.addedAt || 0) - (a.addedAt || 0)) || tieIdx(a, b)
    case 'email_asc':
      return (a, b) => String(a.email || '').localeCompare(String(b.email || '')) || tieIdx(a, b)
    case 'default':
    default:
      return tieIdx
  }
}

/** Main entry: returns filtered+sorted computed for a reactive accounts ref */
export function useAccountView(accountsRef) {
  const filteredAccounts = computed(() => {
    const list = accountsRef.value || []
    const { sortBy, statusFilter, tierFilter, searchText } = viewState
    const filtered = list.filter((a) =>
      matchesStatus(a, statusFilter) &&
      matchesTier(a, tierFilter) &&
      matchesSearch(a, searchText),
    )
    return filtered.slice().sort(compareBy(sortBy))
  })

  // Tier counts: how many accounts fall into each tier (for adaptive chips)
  const tierCounts = computed(() => {
    const counts = { free: 0, pro: 0, max: 0, teams: 0, enterprise: 0 }
    for (const a of accountsRef.value || []) {
      const t = deriveTier(a)
      if (counts[t] !== undefined) counts[t]++
    }
    return counts
  })

  const hasFilters = computed(() =>
    viewState.statusFilter !== 'all' ||
    viewState.tierFilter !== 'all' ||
    !!viewState.searchText,
  )

  return { filteredAccounts, tierCounts, hasFilters }
}
