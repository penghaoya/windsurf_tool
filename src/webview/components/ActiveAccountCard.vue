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

    <!-- Primary action row -->
    <div class="ac-actions">
      <button class="ac-btn primary" @click="onSwitch" :disabled="busy" :title="switchTitle">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>
        切到最优
      </button>
      <button class="ac-btn" @click="onRefresh" :disabled="busy" title="刷新当前账号额度">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0115.36-6.36L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 01-15.36 6.36L3 16"/></svg>
        刷新
      </button>
      <span class="ac-spacer"></span>
      <button class="ac-btn ghost" @click="onPanic" :disabled="busy" title="紧急切换 (限流应急)">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        应急
      </button>
    </div>
  </div>
  <div v-else class="ac-empty">
    <span>无活跃账号</span>
    <button class="ac-btn primary tiny" @click="onSwitch">选择账号</button>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { meterColor, urgencyColor, urgencyLabel } from '../utils/format.js'
import { postMessage } from '../composables/useVscode.js'
import { ACTION } from '../../extension/shared/messageTypes.js'

const props = defineProps({
  accounts: { type: Array, default: () => [] },
  currentIndex: { type: Number, default: -1 },
  activeQuota: { type: Object, default: null },
  switchStatus: { type: Object, default: null },
})

const activeAccount = computed(() =>
  props.currentIndex >= 0 ? props.accounts[props.currentIndex] : null
)

const busy = computed(() => {
  const phase = props.switchStatus?.phase
  return phase === 'switching' || phase === 'verifying' || phase === 'uncertain'
})

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
  if (q.planDays > 0) return `<span style="color:${color}">${q.planDays}天${label}</span>`
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

const switchTitle = computed(() =>
  busy.value ? '切换中…' : '智能切换到额度最优的可用账号'
)

function onSwitch() {
  postMessage(ACTION.SMART_ROTATE)
}
function onRefresh() {
  if (props.currentIndex >= 0) {
    postMessage(ACTION.REFRESH_ONE, { index: props.currentIndex })
  }
}
function onPanic() {
  postMessage(ACTION.PANIC_SWITCH)
}
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

.ac-actions{display:flex;align-items:center;gap:4px;margin-top:2px}
.ac-spacer{flex:1}
.ac-btn{
  display:inline-flex;align-items:center;gap:4px;
  height:26px;padding:0 11px;
  background:var(--btn-bg);border:1px solid var(--bd);color:var(--btn-fg);
  border-radius:var(--R3);font-size:11px;font-weight:600;
  cursor:pointer;transition:all .15s ease;line-height:1;white-space:nowrap;
}
.ac-btn:hover:not(:disabled){background:var(--btn-hover);border-color:var(--bd2);color:var(--tx)}
.ac-btn:active:not(:disabled){transform:scale(.97)}
.ac-btn:disabled{opacity:.5;cursor:not-allowed}
.ac-btn svg{flex-shrink:0;opacity:.85}
.ac-btn.primary{
  background:var(--ac-bg);border-color:var(--ac);color:var(--ac);
}
.ac-btn.primary:hover:not(:disabled){
  background:color-mix(in srgb, var(--ac) 18%, var(--ac-bg));
  border-color:var(--ac);color:var(--ac);
}
.ac-btn.primary svg{opacity:1}
.ac-btn.ghost{background:transparent;color:var(--tx3);border-color:var(--bd)}
.ac-btn.ghost:hover:not(:disabled){color:var(--rd);border-color:color-mix(in srgb, var(--rd) 35%, var(--bd))}
.ac-btn.tiny{height:22px;padding:0 8px;font-size:10px}

.ac-empty{
  display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:8px 9px;margin-bottom:4px;
  background:var(--sf);border:1px dashed var(--bd);border-radius:var(--R);
  font-size:11px;color:var(--tx3);
}
</style>
