<template>
  <div v-if="activeAccount" class="ac-card" :class="{ low: isLow, critical: isCritical }">
    <!-- Identity row -->
    <div class="ac-head">
      <span class="ac-dot" :title="dotTitle"></span>
      <span class="ac-idx">#{{ currentIndex + 1 }}</span>
      <span class="ac-name" :title="activeAccount.email">{{ activeAccount.email }}</span>
      <span v-if="activeQuota?.plan" class="ac-plan">{{ activeQuota.plan }}</span>
      <span v-if="expiryHtml" class="ac-expiry" v-html="expiryHtml"></span>
    </div>

    <!-- Compact quota row -->
    <div class="ac-quota">
      <span class="q-item" :style="{ color: dailyColor }">
        <span class="q-label">天</span>
        <span class="q-val">{{ dailyPct !== null ? dailyPct + '%' : '—' }}</span>
      </span>
      <span class="q-sep">·</span>
      <span class="q-item" :style="{ color: weeklyColor }">
        <span class="q-label">周</span>
        <span class="q-val">{{ weeklyPct !== null ? weeklyPct + '%' : '—' }}</span>
      </span>
      <span v-if="resetInfo" class="q-sep">·</span>
      <span v-if="resetInfo" class="q-reset">{{ resetInfo }}</span>
    </div>

    <!-- Embedded scheduling control (replaces action buttons) -->
    <div class="ac-divider"></div>
    <ModeSwitcher
      :autoRotate="autoRotate"
      :threshold="threshold"
      :manualThreshold="manualThreshold"
      embedded
    />
  </div>
  <div v-else class="ac-empty">
    <span>无活跃账号 — 请从下方列表选择</span>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { meterColor, urgencyColor, urgencyLabel, formatPlanRemaining } from '../utils/format.js'
import ModeSwitcher from './ModeSwitcher.vue'

const props = defineProps({
  accounts: { type: Array, default: () => [] },
  currentIndex: { type: Number, default: -1 },
  activeQuota: { type: Object, default: null },
  switchStatus: { type: Object, default: null },
  autoRotate: { type: Boolean, default: true },
  threshold: { type: Number, default: 15 },
  manualThreshold: { type: Number, default: 0 },
})

const activeAccount = computed(() =>
  props.currentIndex >= 0 ? props.accounts[props.currentIndex] : null
)

const dailyPct = computed(() => activeAccount.value?.usage?.daily?.remaining ?? null)
const weeklyPct = computed(() => activeAccount.value?.usage?.weekly?.remaining ?? null)
const dailyColor = computed(() => dailyPct.value !== null ? meterColor(dailyPct.value) : 'var(--tx3)')
const weeklyColor = computed(() => weeklyPct.value !== null ? meterColor(weeklyPct.value) : 'var(--tx3)')

// Active dot color reflects health
const minPct = computed(() => {
  const d = dailyPct.value, w = weeklyPct.value
  if (d === null && w === null) return null
  if (d === null) return w
  if (w === null) return d
  return Math.min(d, w)
})
const isLow = computed(() => minPct.value !== null && minPct.value <= 20)
const isCritical = computed(() => minPct.value !== null && minPct.value <= 5)
const dotTitle = computed(() => {
  if (isCritical.value) return '额度极低'
  if (isLow.value) return '额度偏低'
  return '正常'
})

// Expiry HTML
const expiryHtml = computed(() => {
  const q = props.activeQuota
  if (!q || q.planDays === null || q.planDays === undefined) return ''
  const urgency = q.urgency ?? -1
  const color = urgencyColor(urgency)
  const label = urgencyLabel(urgency)
  if (q.planDays > 0) {
    const text = q.planEnd ? formatPlanRemaining(q.planEnd) : `${q.planDays}天`
    return `<span style="color:${color}">${text}${label}</span>`
  }
  return '<span style="color:var(--rd)">已过期</span>'
})

// Reset info: pick the most imminent
const resetInfo = computed(() => {
  const q = props.activeQuota
  if (!q) return ''
  const parts = []
  if (q.resetCountdown) parts.push(`天 ${q.resetCountdown}`)
  if (q.weeklyResetCountdown) parts.push(`周 ${q.weeklyResetCountdown}`)
  return parts.length ? `重置 ${parts.join(' / ')}` : ''
})

</script>

<style scoped>
.ac-card{
  background:var(--sf);border:1px solid var(--bd);border-radius:var(--R);
  padding:8px 9px;margin-bottom:4px;
  display:flex;flex-direction:column;gap:6px;
  transition:border-color .2s ease;
}
.ac-card.low{border-color:color-mix(in srgb, var(--yw) 30%, var(--bd))}
.ac-card.critical{border-color:color-mix(in srgb, var(--rd) 40%, var(--bd))}

.ac-head{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:12px;line-height:1.2}
.ac-dot{
  width:7px;height:7px;border-radius:50%;
  background:var(--gn);box-shadow:0 0 6px color-mix(in srgb, var(--gn) 60%, transparent);
  flex-shrink:0;
}
.ac-card.low .ac-dot{background:var(--yw);box-shadow:0 0 6px color-mix(in srgb, var(--yw) 60%, transparent)}
.ac-card.critical .ac-dot{background:var(--rd);box-shadow:0 0 8px color-mix(in srgb, var(--rd) 70%, transparent);animation:pulse 1.5s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
.ac-idx{font-size:10px;color:var(--tx3);font-weight:600;flex-shrink:0}
.ac-name{
  flex:1;min-width:0;
  font-size:12px;font-weight:600;color:var(--tx);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.ac-plan{
  font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;
  border:1px solid var(--ac);color:var(--ac);background:var(--ac-bg);
  letter-spacing:.3px;
}
.ac-expiry{font-size:10px;font-weight:500}

.ac-quota{
  display:flex;align-items:center;gap:5px;flex-wrap:wrap;
  font-size:11px;line-height:1;
  padding:2px 0;
}
.q-item{display:inline-flex;align-items:baseline;gap:3px;font-weight:600}
.q-label{font-size:10px;color:var(--tx3);font-weight:500}
.q-val{font-size:12px;font-weight:700;letter-spacing:-.3px}
.q-sep{color:var(--tx3);font-size:10px}
.q-reset{font-size:10px;color:var(--tx3);font-weight:500}

.ac-divider{
  height:1px;background:var(--bd);
  margin:1px -9px 1px;
  opacity:.6;
}

.ac-empty{
  padding:8px 9px;margin-bottom:4px;
  background:var(--sf);border:1px dashed var(--bd);border-radius:var(--R);
  font-size:11px;color:var(--tx3);text-align:center;
}
</style>
