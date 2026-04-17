<template>
  <div class="sect">
    <div class="sbox" :class="{ open: expanded }">
      <div id="list">
        <div v-if="accounts.length > 0" class="list-tools">
          <div class="search-row">
            <input
              v-model.trim="query"
              class="search-input"
              type="search"
              placeholder="搜索邮箱或套餐"
            >
            <button
              v-if="query"
              class="icon-btn"
              type="button"
              title="清空搜索"
              @click="query = ''"
            >
              ×
            </button>
          </div>
          <div class="control-row">
            <select v-model="filterMode" class="select" title="筛选账号">
              <option value="all">全部</option>
              <option value="available">可用</option>
              <option value="rateLimited">限流</option>
              <option value="expired">过期</option>
              <option value="dailyDepleted">日额度耗尽</option>
            </select>
            <select v-model="sortMode" class="select" title="排序方式">
              <option value="default">调度顺序</option>
              <option value="quotaHigh">额度高</option>
              <option value="expirySoon">到期近</option>
            </select>
          </div>
          <div class="result-line">{{ filteredAccounts.length }}/{{ accounts.length }} 匹配</div>
        </div>
        <template v-if="filteredAccounts.length > 0">
          <AccountCard
            v-for="{ account, index } in filteredAccounts"
            :key="account.email || index"
            :account="account"
            :index="index"
            :isCurrent="index === currentIndex"
            :threshold="threshold"
            :switchStatus="switchStatus"
          />
        </template>
        <div v-else class="empty">
          <div class="empty-icon">📭</div>
          {{ accounts.length > 0 ? '未找到匹配账号' : '号池为空' }}<br>
          <span v-if="accounts.length === 0" style="color:var(--ac)">粘贴账号到上方输入框开始使用</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import AccountCard from './AccountCard.vue'

const props = defineProps({
  accounts: { type: Array, default: () => [] },
  currentIndex: { type: Number, default: -1 },
  threshold: { type: Number, default: 5 },
  expanded: { type: Boolean, default: true },
  switchStatus: { type: Object, default: null },
})

const query = ref('')
const filterMode = ref('all')
const sortMode = ref('default')

const normalizedQuery = computed(() => query.value.trim().toLowerCase())

const isCooling = (until) => Number.isFinite(until) && until > Date.now()

const isRateLimited = (account) =>
  isCooling(account.rateLimitInfo?.until) || isCooling(account.rateLimit?.until)

const isBlocked = (account) =>
  isCooling(account.schedulerBlocked?.quarantined?.until) ||
  isCooling(account.schedulerBlocked?.poolCooled?.until)

const isAvailable = (account) =>
  !account.isExpired &&
  !account.dailyDepleted &&
  !isRateLimited(account) &&
  !isBlocked(account)

const planText = (account) => account.usage?.plan || account.usage?.billingStrategy || ''

const matchesQuery = (account) => {
  const q = normalizedQuery.value
  if (!q) return true
  return (account.email || '').toLowerCase().includes(q) ||
    planText(account).toLowerCase().includes(q)
}

const matchesFilter = (account) => {
  switch (filterMode.value) {
    case 'available': return isAvailable(account)
    case 'rateLimited': return isRateLimited(account) || isBlocked(account)
    case 'expired': return account.isExpired
    case 'dailyDepleted': return account.dailyDepleted
    default: return true
  }
}

const compareAccounts = (a, b) => {
  if (sortMode.value === 'quotaHigh') {
    const aq = Number.isFinite(a.account.effective) ? a.account.effective : -1
    const bq = Number.isFinite(b.account.effective) ? b.account.effective : -1
    if (bq !== aq) return bq - aq
  }
  if (sortMode.value === 'expirySoon') {
    const ad = Number.isFinite(a.account.planDays) ? a.account.planDays : Number.MAX_SAFE_INTEGER
    const bd = Number.isFinite(b.account.planDays) ? b.account.planDays : Number.MAX_SAFE_INTEGER
    if (ad !== bd) return ad - bd
  }
  return a.index - b.index
}

const filteredAccounts = computed(() =>
  props.accounts
    .map((account, i) => ({ account, index: Number.isInteger(account.index) ? account.index : i }))
    .filter(({ account }) => matchesQuery(account) && matchesFilter(account))
    .sort(compareAccounts)
)
</script>

<style scoped>
.sect{margin-top:0}
.sbox{max-height:0;overflow:hidden;transition:max-height .3s ease,opacity .25s ease;opacity:0;padding:0}
.sbox.open{max-height:9999px;opacity:1;padding:2px 0}
.list-tools{display:flex;flex-direction:column;gap:5px;margin:3px 0 6px}
.search-row{display:flex;align-items:center;gap:4px}
.search-input{flex:1;min-width:0;height:26px;background:var(--input-bg);color:var(--tx);border:1px solid var(--input-bd);border-radius:var(--R3);padding:0 8px;font:inherit;font-size:12px;outline:none}
.search-input:focus{border-color:var(--ac)}
.icon-btn{width:26px;height:26px;border:1px solid var(--bd);background:var(--btn-bg);color:var(--tx2);border-radius:var(--R3);cursor:pointer;font-size:16px;line-height:1}
.icon-btn:hover{background:var(--btn-hover);color:var(--tx)}
.control-row{display:grid;grid-template-columns:1fr 1fr;gap:5px}
.select{height:26px;min-width:0;background:var(--input-bg);color:var(--tx);border:1px solid var(--input-bd);border-radius:var(--R3);padding:0 6px;font:inherit;font-size:12px;outline:none}
.select:focus{border-color:var(--ac)}
.result-line{font-size:11px;color:var(--tx3);padding:0 1px}
.empty{text-align:center;padding:32px 16px;color:var(--tx3);font-size:13px;line-height:2}
.empty-icon{font-size:32px;margin-bottom:8px;opacity:.4}
</style>
