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
  { value: 'depleted',  label: '额度耗尽' },
  { value: 'expired',   label: '到期' },
]

const DEFAULT_VIEW = {
  sortBy: 'default',
  statusFilter: 'all',
  searchText: '',
}

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_VIEW }
    const data = JSON.parse(raw)
    // searchText stays ephemeral (don't persist across sessions)
    return { ...DEFAULT_VIEW, ...data, searchText: '' }
  } catch { return { ...DEFAULT_VIEW } }
}

// Singleton reactive state (shared across components)
export const viewState = reactive(loadPersisted())

watch(
  () => ({ sortBy: viewState.sortBy, statusFilter: viewState.statusFilter }),
  (v) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)) } catch {}
  },
  { deep: true },
)

export function resetView() {
  Object.assign(viewState, DEFAULT_VIEW)
}

// 'depleted' bucket merges ALL unusable states (depleted/RL/badauth/quarantine)
// so every account belongs to exactly one of: available / depleted / expired.
function matchesStatus(account, status) {
  if (status === 'all') return true
  const isExp = !!account.isExpired
  const isUnusable = !!account.dailyDepleted ||
    !!account.rateLimit || !!account.schedulerBlocked ||
    !!account.invalidAuth
  if (status === 'expired') return isExp
  if (status === 'depleted') return !isExp && isUnusable
  if (status === 'available') return !isExp && !isUnusable
  return true
}

function matchesSearch(account, search) {
  const q = (search || '').toLowerCase().trim()
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
    const { sortBy, statusFilter, searchText } = viewState
    const filtered = list.filter((a) =>
      matchesStatus(a, statusFilter) &&
      matchesSearch(a, searchText),
    )
    return filtered.slice().sort(compareBy(sortBy))
  })

  const hasFilters = computed(() =>
    viewState.statusFilter !== 'all' ||
    !!viewState.searchText,
  )

  return { filteredAccounts, hasFilters }
}
