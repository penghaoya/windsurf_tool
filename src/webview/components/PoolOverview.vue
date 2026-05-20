<template>
  <div class="pool">
    <!-- Header — 加 range 提示 (最高/最低差异显著时显示) -->
    <div class="pool-header">
      <div class="pool-overall">
        <span class="pool-pct" :style="{ color: barColor }">{{ overallPct }}%</span>
        <span class="pool-pct-label">号池均剩</span>
        <span v-if="rangeStr" class="pool-range" :title="rangeTip">{{ rangeStr }}</span>
      </div>
      <span class="pool-count" :title="countTip">{{ pool.available }}/{{ pool.total }} 可用</span>
    </div>

    <!-- Day/Week Meters — 加样本数提示 (基于几个有效账号算的均值) -->
    <div class="pool-meters">
      <div class="meter">
        <div class="meter-head">
          <span class="meter-label">天</span>
          <span v-if="dayCountStr" class="meter-sample">{{ dayCountStr }}</span>
          <span class="meter-spacer"></span>
          <span v-if="dayResetStr" class="meter-reset">{{ dayResetStr }}</span>
        </div>
        <div class="meter-bar">
          <div class="meter-track">
            <div class="meter-fill" :style="{ width: `${avgDayPct ?? 0}%`, background: dayBarColor }"></div>
          </div>
          <span class="meter-val" :style="{ color: dayBarColor }">{{ avgDayPct !== null ? Math.round(avgDayPct) + '%' : '--' }}</span>
        </div>
      </div>
      <div class="meter">
        <div class="meter-head">
          <span class="meter-label">周</span>
          <span v-if="weekCountStr" class="meter-sample">{{ weekCountStr }}</span>
          <span class="meter-spacer"></span>
          <span v-if="weekResetStr" class="meter-reset">{{ weekResetStr }}</span>
        </div>
        <div class="meter-bar">
          <div class="meter-track">
            <div class="meter-fill" :style="{ width: `${avgWeekPct ?? 0}%`, background: weekBarColor }"></div>
          </div>
          <span class="meter-val" :style="{ color: weekBarColor }">{{ avgWeekPct !== null ? Math.round(avgWeekPct) + '%' : '--' }}</span>
        </div>
      </div>
    </div>

    <!-- Status Chips — 扩展 unknown/invalid/urgent, 让 available 与 total 之间的"缺口"有解释 -->
    <div v-if="hasAnyChip" class="pool-stats">
      <span v-if="pool.depleted > 0" class="chip bad" title="额度已耗尽 (effective ≤ 阈值)"><b>{{ pool.depleted }}</b>耗尽</span>
      <span v-if="pool.rateLimited > 0" class="chip warn" title="近期触发限流, 冷却中"><b>{{ pool.rateLimited }}</b>限流</span>
      <span v-if="pool.expired > 0" class="chip muted" title="订阅已过期"><b>{{ pool.expired }}</b>过期</span>
      <span v-if="pool.urgentCount > 0" class="chip warn" title="订阅即将到期 (≤7天)"><b>{{ pool.urgentCount }}</b>将到期</span>
      <span v-if="pool.invalid > 0" class="chip bad" title="鉴权失效 (token 过期 / 密码错误)"><b>{{ pool.invalid }}</b>鉴权</span>
      <span v-if="pool.unknown > 0" class="chip muted" title="尚未刷新过额度, 状态未知"><b>{{ pool.unknown }}</b>未刷新</span>
    </div>

    <!-- Pool insights — 仅在有真实信号时显示 (周限瓶颈 / 即将浪费), 避免 noise -->
    <div v-if="insightText" class="pool-insight" :title="insightTip">
      <span class="insight-dot"></span>
      <span>{{ insightText }}</span>
    </div>

    <!-- Latest decision (only when actionable, hide quiet 'ok' state) -->
    <div v-if="decisionText" class="pool-decision">
      <span class="decision-dot"></span>
      <span>{{ decisionText }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { meterColor, fmtReset, urgencyColor, formatPlanRemaining } from '../utils/format.js'

const props = defineProps({
  accounts: { type: Array, default: () => [] },
  currentIndex: { type: Number, default: -1 },
  pool: { type: Object, default: () => ({}) },
  activeQuota: { type: Object, default: null },
  threshold: { type: Number, default: 5 },
  lastDecision: { type: Object, default: null },
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
  fmtReset(props.pool.nextWeeklyReset || props.pool.weeklyReset) || props.activeQuota?.weeklyResetCountdown || null
)

// v23.5: 详细化信息 —— 全部基于已推送的 pool 字段, 不需要后端改动

// 号池分布范围 — 最高/最低差异显著时显示 (≥20% spread), 帮助用户判断"两极分化还是均匀"
const rangeStr = computed(() => {
  const best = props.pool.bestRemaining
  const worst = props.pool.worstRemaining
  if (best === undefined || worst === undefined || best === null || worst === null) return ''
  if (best <= 0 || (best - worst) < 20) return ''
  return `↑${Math.round(best)}% ↓${Math.round(worst)}%`
})
const rangeTip = computed(() => {
  const best = props.pool.bestRemaining
  const worst = props.pool.worstRemaining
  return `最高 ${Math.round(best ?? 0)}% · 最低 ${Math.round(worst ?? 0)}%\n差距越大, 越值得调度`
})

// 缺口 tooltip — 把 available 与 total 之间消失的账号都列出来
const countTip = computed(() => {
  const p = props.pool
  const lines = [`可用 ${p.available ?? 0} / 共 ${p.total ?? 0}`]
  if (p.depleted > 0) lines.push(`· 耗尽 ${p.depleted}`)
  if (p.rateLimited > 0) lines.push(`· 限流 ${p.rateLimited}`)
  if (p.expired > 0) lines.push(`· 过期 ${p.expired}`)
  if (p.urgentCount > 0) lines.push(`· 将到期 ${p.urgentCount}`)
  if (p.invalid > 0) lines.push(`· 鉴权失效 ${p.invalid}`)
  if (p.unknown > 0) lines.push(`· 未刷新 ${p.unknown}`)
  return lines.join('\n')
})

// Meter 样本数 — 提示均值是基于几个账号算出来的, 避免被极少样本误导
const dayCountStr = computed(() => {
  const n = props.pool.dailyCount
  return n > 0 ? `${n}个` : ''
})
const weekCountStr = computed(() => {
  const n = props.pool.weeklyCount
  return n > 0 ? `${n}个` : ''
})

// Chips 总开关 — 任意一类异常存在即显示
const hasAnyChip = computed(() => {
  const p = props.pool
  return (p.depleted > 0) || (p.rateLimited > 0) || (p.expired > 0)
      || (p.urgentCount > 0) || (p.invalid > 0) || (p.unknown > 0)
})

// 号池洞察 — 仅在真实风险信号时显示, 避免日常 noise
// 优先级: 周限瓶颈 (≥50% 账号被 weekly 卡住) > 即将浪费 (大量额度临近周重置)
const insightText = computed(() => {
  const p = props.pool
  if (p.preResetWasteCount > 0 && p.preResetWasteTotal > 0) {
    return `${p.preResetWasteCount} 个账号周重置临近, 约 ${p.preResetWasteTotal}% 额度即将浪费`
  }
  if (p.weeklyBottleneckRatio >= 50 && p.effectiveCount >= 3) {
    return `周限制约 ${p.weeklyBottleneckCount} 个账号 (${p.weeklyBottleneckRatio}%), 优先用 weekly% 高的`
  }
  return ''
})
const insightTip = computed(() => {
  const p = props.pool
  if (p.preResetWasteCount > 0) return '周重置后这些额度会清零, 建议优先用它们'
  if (p.weeklyBottleneckRatio >= 50) return '账号 daily% 高但 weekly% 低 → 实际可用容量被周限制约'
  return ''
})

// Active account quota display
// v21.0: quota mode — one dimension missing → show 0%
const activeDailyPct = computed(() => {
  const u = activeAccount.value?.usage
  const d = u?.daily?.remaining ?? null
  if (d !== null) return d
  const isQuota = u?.mode === 'quota' || u?.daily || u?.weekly
  if (isQuota && u?.weekly?.remaining != null) return 0
  return null
})
const activeWeeklyPct = computed(() => {
  const u = activeAccount.value?.usage
  const w = u?.weekly?.remaining ?? null
  if (w !== null) return w
  const isQuota = u?.mode === 'quota' || u?.daily || u?.weekly
  if (isQuota && u?.daily?.remaining != null) return 0
  return null
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
  if (q.planDays > 0) {
    const text = q.planEnd ? formatPlanRemaining(q.planEnd) : `${q.planDays}天`
    return `<span style="color:${color}">${text}剩余</span>`
  }
  return '<span style="color:var(--rd)">已过期</span>'
})

const decisionText = computed(() => {
  const d = props.lastDecision
  if (!d) return ''
  const reason = d.reason || 'ok'
  // Suppress quiet 'ok' / 'none' decisions — only surface real signals
  if (d.action === 'none' && (reason === 'ok' || !reason)) return ''
  if (d.action === 'none') return `最近决策：不切换，${reason}`
  if (d.action === 'switch_account') return `最近决策：准备切换，${reason}`
  if (d.action === 'switch_confirmed') return `最近决策：已切到 #${(d.targetIndex ?? -1) + 1}`
  if (d.action === 'switch_failed') {
    const skips = Array.isArray(d.skips) && d.skips.length ? ` · ${d.skips.join('，')}` : ''
    return `最近决策：切换失败，${reason}${skips}`
  }
  if (d.action === 'skip_switch') return `最近决策：跳过切换，${reason}`
  if (d.action === 'runtime_reconcile') return `最近决策：运行时对账到 #${(d.targetIndex ?? -1) + 1}`
  if (d.action === 'runtime_mismatch') return `最近决策：运行时账号不在号池`
  if (d.action === 'switch_candidates') return `最近决策：候选 ${d.candidateCount ?? 0} 个`
  return `最近决策：${reason}`
})
</script>

<style scoped>
.pool{background:var(--sf);border:1px solid var(--bd);border-radius:var(--R);padding:6px 8px;margin-bottom:3px}
.pool-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;gap:6px}
.pool-overall{display:flex;align-items:baseline;gap:3px;min-width:0;flex:1}
.pool-pct{font-size:18px;font-weight:800;letter-spacing:-0.5px;line-height:1}
.pool-pct-label{font-size:11px;color:var(--tx3);font-weight:500}
/* v23.5: 范围提示 — 最高/最低差异显著时的两极分化警示 */
.pool-range{
  font-size:10px;color:var(--tx3);font-weight:500;
  padding:1px 5px;border-radius:8px;
  background:color-mix(in srgb, var(--tx) 6%, transparent);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  letter-spacing:-.2px;
  margin-left:4px;
  cursor:help;
}
.pool-count{font-size:11px;color:var(--tx3);font-weight:500;cursor:help;flex-shrink:0}
.pool-meters{display:flex;flex-direction:column;gap:2px;margin-bottom:2px}
.meter-head{display:flex;align-items:baseline;gap:5px;margin-bottom:0}
.meter-label{font-size:11px;color:var(--tx);font-weight:600;flex-shrink:0}
/* v23.5: 样本数提示 — 帮助用户理解均值的可信度 */
.meter-sample{font-size:9.5px;color:var(--tx3);font-weight:500;flex-shrink:0}
.meter-spacer{flex:1}
.meter-reset{font-size:10px;color:var(--tx3);font-weight:400;flex-shrink:0}
.meter-bar{display:flex;align-items:center;gap:5px}
.meter-track{flex:1;height:6px;border-radius:3px;background:var(--bg);overflow:hidden}
.meter-fill{height:100%;border-radius:3px;transition:width .4s ease}
.meter-val{font-size:11px;font-weight:700;min-width:34px;text-align:right}
.pool-stats{display:flex;gap:3px;flex-wrap:wrap;margin-top:1px}
.chip{display:inline-flex;align-items:center;gap:2px;padding:0 5px;border-radius:7px;font-size:10px;font-weight:500;background:var(--bg2);color:var(--tx2);border:1px solid var(--bd);line-height:1.5}
.chip b{font-weight:600;color:var(--tx)}
.chip.warn{color:var(--yw);border-color:color-mix(in srgb, var(--yw) 20%, transparent);background:var(--yw-bg)}
.chip.bad{color:var(--rd);border-color:color-mix(in srgb, var(--rd) 20%, transparent);background:var(--rd-bg)}
.chip.muted{color:var(--tx3)}
.pool-decision{margin-top:3px;display:flex;align-items:center;gap:5px;font-size:10px;color:var(--tx3);line-height:1.4;word-break:break-word}
.decision-dot{width:4px;height:4px;border-radius:50%;background:var(--ac);flex-shrink:0}
/* v23.5: 号池洞察 — 周限瓶颈 / 即将浪费等风险信号 */
.pool-insight{
  margin-top:3px;display:flex;align-items:center;gap:5px;
  font-size:10px;color:var(--yw);font-weight:500;line-height:1.4;
  word-break:break-word;cursor:help;
}
.insight-dot{width:4px;height:4px;border-radius:50%;background:var(--yw);flex-shrink:0}
</style>
