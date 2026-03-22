<template>
  <div class="pool">
    <!-- Header -->
    <div class="pool-header">
      <div class="pool-overall">
        <span class="pool-pct" :style="{ color: barColor }">{{ overallPct }}%</span>
        <span class="pool-pct-label">号池均剩</span>
      </div>
      <span class="pool-count">{{ pool.available }}/{{ pool.total }} 可用</span>
    </div>

    <!-- Day/Week Meters -->
    <div class="pool-meters">
      <div class="meter">
        <div class="meter-head">
          <span class="meter-label">天</span>
          <span v-if="dayResetStr" class="meter-reset">{{ dayResetStr }}</span>
        </div>
        <div class="meter-bar">
          <div class="meter-track">
            <div class="meter-fill" :style="{ width: `${avgDayPct ?? 0}%`, background: dayBarColor }"></div>
          </div>
          <span class="meter-val" :style="{ color: dayBarColor }">{{ avgDayPct !== null ? avgDayPct.toFixed(1) + '%' : '--' }}</span>
        </div>
      </div>
      <div class="meter">
        <div class="meter-head">
          <span class="meter-label">周</span>
          <span v-if="weekResetStr" class="meter-reset">{{ weekResetStr }}</span>
        </div>
        <div class="meter-bar">
          <div class="meter-track">
            <div class="meter-fill" :style="{ width: `${avgWeekPct ?? 0}%`, background: weekBarColor }"></div>
          </div>
          <span class="meter-val" :style="{ color: weekBarColor }">{{ avgWeekPct !== null ? avgWeekPct.toFixed(1) + '%' : '--' }}</span>
        </div>
      </div>
    </div>

    <!-- Status Chips -->
    <div v-if="pool.depleted > 0 || pool.rateLimited > 0 || pool.expired > 0" class="pool-stats">
      <span v-if="pool.depleted > 0" class="chip bad"><b>{{ pool.depleted }}</b>耗尽</span>
      <span v-if="pool.rateLimited > 0" class="chip warn"><b>{{ pool.rateLimited }}</b>限流</span>
      <span v-if="pool.expired > 0" class="chip muted"><b>{{ pool.expired }}</b>过期</span>
    </div>

    <!-- Active Account -->
    <div v-if="currentIndex >= 0 && activeAccount" class="pool-active">
      <span class="act-dot"></span>
      <div class="act-info">
        <div class="act-row">
          <span class="act-name">#{{ currentIndex + 1 }} {{ activeAccount.email }}</span>
          <span v-if="activeQuota?.plan" class="act-plan">{{ activeQuota.plan }}</span>
          <span v-if="expiryHtml" class="act-expiry" v-html="expiryHtml"></span>
        </div>
        <div v-if="activeQuotaTag || activeResetInfo" class="act-meta">
          <span v-if="activeQuotaTag" style="color:var(--ac)">{{ activeQuotaTag }}</span>
          <span v-if="activeResetInfo">{{ activeResetInfo }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { meterColor, fmtReset, urgencyColor, urgencyLabel } from '../utils/format.js'

const props = defineProps({
  accounts: { type: Array, default: () => [] },
  currentIndex: { type: Number, default: -1 },
  pool: { type: Object, default: () => ({}) },
  activeQuota: { type: Object, default: null },
  threshold: { type: Number, default: 5 },
})

const activeAccount = computed(() =>
  props.currentIndex >= 0 ? props.accounts[props.currentIndex] : null
)

// Pool averages
const avgDayPct = computed(() => {
  const v = props.pool.avgDaily
  return v !== null && v !== undefined ? Math.min(100, Math.round(v * 10) / 10) : null
})
const avgWeekPct = computed(() => {
  const v = props.pool.avgWeekly
  return v !== null && v !== undefined ? Math.min(100, Math.round(v * 10) / 10) : null
})

// Overall pct = min(day, week)
const overallPct = computed(() => {
  if (avgDayPct.value !== null && avgWeekPct.value !== null) return Math.min(avgDayPct.value, avgWeekPct.value)
  if (avgDayPct.value !== null) return avgDayPct.value
  if (avgWeekPct.value !== null) return avgWeekPct.value
  return props.pool.avgCredits !== null ? Math.min(100, Math.round(props.pool.avgCredits)) : (props.pool.health || 0)
})

// Colors
const barColor = computed(() => meterColor(overallPct.value))
const dayBarColor = computed(() => avgDayPct.value !== null ? meterColor(avgDayPct.value) : 'var(--tx3)')
const weekBarColor = computed(() => avgWeekPct.value !== null ? meterColor(avgWeekPct.value) : 'var(--tx3)')

// Reset countdowns
const dayResetStr = computed(() =>
  fmtReset(props.pool.nextReset) || props.activeQuota?.resetCountdown || null
)
const weekResetStr = computed(() =>
  fmtReset(props.pool.weeklyReset) || props.activeQuota?.weeklyResetCountdown || null
)

// Active account quota display
const activeDailyPct = computed(() => {
  const u = activeAccount.value?.usage
  return u?.daily?.remaining ?? null
})
const activeWeeklyPct = computed(() => {
  const u = activeAccount.value?.usage
  return u?.weekly?.remaining ?? null
})
const activeQuotaTag = computed(() => {
  if (activeDailyPct.value === null) return ''
  let s = `天${activeDailyPct.value}%`
  if (activeWeeklyPct.value !== null) s += `·周${activeWeeklyPct.value}%`
  return s
})

// Reset info
const activeResetInfo = computed(() => {
  const q = props.activeQuota
  if (!q) return ''
  const parts = []
  if (q.resetCountdown) parts.push(`天重置:${q.resetCountdown}`)
  if (q.weeklyResetCountdown) parts.push(`周重置:${q.weeklyResetCountdown}`)
  return parts.join(' · ')
})

// Expiry info (HTML)
const expiryHtml = computed(() => {
  const q = props.activeQuota
  if (!q || q.planDays === null || q.planDays === undefined) return ''
  const urgency = q.urgency ?? -1
  const color = urgencyColor(urgency)
  const label = urgencyLabel(urgency)
  if (q.planDays > 0) return `<span style="color:${color}">${q.planDays}天剩余${label}</span>`
  return '<span style="color:var(--rd)">已过期</span>'
})
</script>

<style scoped>
.pool{background:var(--sf);border:1px solid var(--bd);border-radius:var(--R);padding:10px 12px;margin-bottom:6px}
.pool-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.pool-overall{display:flex;align-items:baseline;gap:5px}
.pool-pct{font-size:22px;font-weight:800;letter-spacing:-0.5px;line-height:1}
.pool-pct-label{font-size:10px;color:var(--tx3);font-weight:500}
.pool-count{font-size:9px;color:var(--tx3);font-weight:500}
.pool-meters{display:flex;flex-direction:column;gap:6px;margin-bottom:6px}
.meter-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:2px}
.meter-label{font-size:11px;color:var(--tx);font-weight:600}
.meter-reset{font-size:9px;color:var(--tx3);font-weight:400}
.meter-bar{display:flex;align-items:center;gap:6px}
.meter-track{flex:1;height:6px;border-radius:3px;background:var(--bg);overflow:hidden}
.meter-fill{height:100%;border-radius:3px;transition:width .4s ease}
.meter-val{font-size:11px;font-weight:700;min-width:36px;text-align:right}
.pool-stats{display:flex;gap:4px;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:500;background:var(--bg2);color:var(--tx2);border:1px solid var(--bd)}
.chip b{font-weight:600;color:var(--tx)}
.chip.warn{color:var(--yw);border-color:rgba(232,197,106,.2);background:var(--yw-bg)}
.chip.bad{color:var(--rd);border-color:rgba(240,96,96,.2);background:var(--rd-bg)}
.chip.muted{color:var(--tx3)}
.pool-active{margin-top:6px;padding:6px 8px;background:var(--bg2);border-radius:var(--R3);border:1px solid var(--bd);display:flex;align-items:center;gap:6px}
.pool-active .act-dot{width:5px;height:5px;border-radius:50%;background:var(--gn);flex-shrink:0;box-shadow:0 0 4px var(--gn)}
.pool-active .act-info{flex:1;min-width:0}
.pool-active .act-row{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:10px}
.pool-active .act-name{font-weight:600;color:var(--tx);word-break:break-all;font-size:10px}
.pool-active .act-plan{font-size:8px;font-weight:600;padding:0 3px;border-radius:3px;border:1px solid var(--ac);color:var(--ac)}
.pool-active .act-expiry{font-size:9px}
.pool-active .act-meta{font-size:8px;color:var(--tx3);margin-top:1px;display:flex;gap:5px;flex-wrap:wrap}
</style>
