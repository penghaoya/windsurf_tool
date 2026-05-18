<template>
  <!-- v23.5: 切换动画封装容器 — 提供过渡参考点 + 顶部 indeterminate progress bar -->
  <div class="ac-wrap">
    <!-- 切换中 indeterminate progress bar (1px,顶部) -->
    <div v-if="isSwitching" class="ac-progress" :title="switchTip"></div>

    <transition name="ac-swap" mode="out-in">
      <!-- 用 currentIndex 作为 key,触发卡片切换过渡 -->
      <div
        v-if="activeAccount"
        :key="currentIndex"
        class="ac-card"
        :class="{ low: isLow, critical: isCritical, 'just-switched': justSwitched }"
      >
        <!-- Identity row -->
        <div class="ac-head">
          <span class="ac-dot" :title="dotTitle"></span>
          <span class="ac-idx">#{{ currentIndex + 1 }}</span>
          <span class="ac-name" :title="activeAccount.email">{{ activeAccount.email }}</span>
          <span v-if="activeQuota?.plan" class="ac-plan" :class="planClass">{{ activeQuota.plan }}</span>
          <span v-if="expiryText" class="ac-expiry" :style="expiryStyle">{{ expiryText }}</span>
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

        <!-- v22.6: 出口 IP — 显示当前 Windsurf 流量真实出口 IP + 国家 -->
        <div class="ac-egress" :title="ipTitle" @click="onRefreshIp">
          <span class="eg-label">出口</span>
          <template v-if="egressIp">
            <span class="eg-flag">{{ countryFlag }}</span>
            <span class="eg-ip">{{ egressIp.ip }}</span>
            <span v-if="egressIp.country" class="eg-country">{{ egressIp.country }}</span>
          </template>
          <span v-else class="eg-pending">探测中…</span>
          <span class="eg-refresh" :class="{ spinning: refreshing }">↻</span>
        </div>

        <!-- Embedded scheduling control (replaces action buttons) -->
        <div class="ac-divider"></div>
        <ModeSwitcher
          :autoRotate="autoRotate"
          :threshold="threshold"
          :manualThreshold="manualThreshold"
          :alwaysFreshFingerprint="alwaysFreshFingerprint"
          embedded
        />
      </div>
      <div v-else class="ac-empty" key="empty">
        <span>无活跃账号 — 请从下方列表选择</span>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { meterColor, urgencyColor, formatPlanRemaining } from '../utils/format.js'
import ModeSwitcher from './ModeSwitcher.vue'
import { postMessage } from '../composables/useVscode.js'
import { ACTION } from '../../extension/shared/messageTypes.js'

const props = defineProps({
  accounts: { type: Array, default: () => [] },
  currentIndex: { type: Number, default: -1 },
  activeQuota: { type: Object, default: null },
  switchStatus: { type: Object, default: null },
  autoRotate: { type: Boolean, default: true },
  threshold: { type: Number, default: 15 },
  manualThreshold: { type: Number, default: 0 },
  alwaysFreshFingerprint: { type: Boolean, default: true },
  egressIp: { type: Object, default: null },
})

// v22.6: 出口 IP 显示 + 手动刷新
const refreshing = ref(false)

// 国旗 emoji (从 ISO countryCode 转换)
const countryFlag = computed(() => {
  const cc = props.egressIp?.countryCode
  if (!cc || cc.length !== 2) return ''
  return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65))
})

const ipTitle = computed(() => {
  if (!props.egressIp) return '点击刷新出口 IP'
  const parts = [`IP: ${props.egressIp.ip}`]
  if (props.egressIp.country) parts.push(`国家: ${props.egressIp.country}`)
  if (props.egressIp.asOrganization) parts.push(`ASN: ${props.egressIp.asOrganization}`)
  parts.push('点击刷新')
  return parts.join('\n')
})

function onRefreshIp() {
  if (refreshing.value) return
  refreshing.value = true
  postMessage(ACTION.REFRESH_EGRESS_IP)
  // 12s 兜底解除 spinner (后端 6s 超时 + buffer)
  setTimeout(() => { refreshing.value = false }, 12_000)
}

// 当 egressIp 更新时, 解除 spinner
watch(() => props.egressIp?.ts, () => { refreshing.value = false })

const activeAccount = computed(() =>
  props.currentIndex >= 0 ? props.accounts[props.currentIndex] : null
)

// v23.5: 切换动画状态 — 由 props.switchStatus.phase 驱动
// phase 全集 (来源: scheduler.js _setSwitchStatus):
//   'idle'      → 无切换
//   'pending'   → 切换发起,等 IDE 确认  ┐
//   'switching' → LS 重启 / token 注入中 ├ 进度条 ON
//   'verifying' → 二次验证账号生效        ┘
//   'confirmed' → 切换成功(终态,展示"已确认"badge,但进度条 OFF)
//   'uncertain' → 切换可能未生效(终态,警告)
//   'failed'    → 切换失败(终态)
// 用白名单避免新增 phase 时进度条卡住不消失。
const SWITCHING_PHASES = new Set(['pending', 'switching', 'verifying'])
const isSwitching = computed(() => SWITCHING_PHASES.has(props.switchStatus?.phase))
const switchTip = computed(() => {
  const ss = props.switchStatus
  if (!ss) return '切换中…'
  const pi = ss.pendingIndex
  const tail = (typeof pi === 'number' && pi >= 0) ? ` → #${pi + 1}` : ''
  return `${ss.message || '切换中…'}${tail}`
})

// v23.5: 新激活卡片首次出现时一个 highlight pulse (~1.5s) 后自动消除
// 监听 currentIndex 变化 (切换完成的信号), 触发短暂高亮
const justSwitched = ref(false)
let justSwitchedTimer = null
watch(() => props.currentIndex, (next, prev) => {
  // 首次挂载 (prev === undefined) 不触发, 避免页面打开时闪烁
  if (prev === undefined || prev === next || next < 0) return
  justSwitched.value = true
  if (justSwitchedTimer) clearTimeout(justSwitchedTimer)
  justSwitchedTimer = setTimeout(() => { justSwitched.value = false }, 1500)
})

// v21.0: quota mode — one dimension missing → show 0% (matches effectiveRemaining logic)
const dailyPct = computed(() => {
  const d = activeAccount.value?.usage?.daily?.remaining ?? null
  if (d !== null) return d
  const u = activeAccount.value?.usage
  const isQuota = u?.mode === 'quota' || u?.daily || u?.weekly
  if (isQuota && u?.weekly?.remaining != null) return 0
  return null
})
const weeklyPct = computed(() => {
  const w = activeAccount.value?.usage?.weekly?.remaining ?? null
  if (w !== null) return w
  const u = activeAccount.value?.usage
  const isQuota = u?.mode === 'quota' || u?.daily || u?.weekly
  if (isQuota && u?.daily?.remaining != null) return 0
  return null
})
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

// Tier-based plan-tag color class (Trial takes priority)
const planClass = computed(() => {
  const p = String(props.activeQuota?.plan || '').toLowerCase()
  if (!p) return 't-free'
  if (p.includes('trial')) return 't-trial'
  if (p.includes('enterprise')) return 't-enterprise'
  if (p.includes('max')) return 't-max'
  if (p.includes('team')) return 't-teams'
  if (p.includes('pro')) return 't-pro'
  return 't-free'
})

// Expiry text + tinted-pill style (与 AccountCard 一致: 柔和胶囊, 颜色表达紧急度, 不加“将到期”文字)
const expiryText = computed(() => {
  const q = props.activeQuota
  if (!q || q.planDays === null || q.planDays === undefined) return ''
  if (q.planDays <= 0) return '已过期'
  return q.planEnd ? formatPlanRemaining(q.planEnd) : `${q.planDays}天`
})
const expiryStyle = computed(() => {
  const q = props.activeQuota
  if (!q) return null
  const color = (q.planDays !== null && q.planDays <= 0) ? 'var(--rd)' : urgencyColor(q.urgency ?? -1)
  return { color, background: `color-mix(in srgb, ${color} 14%, transparent)` }
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
/* v23.5: 切换动画容器 — 提供顶部 progress bar 锚点 */
.ac-wrap{position:relative}

/* 顶部 1px indeterminate progress bar (切换中) — Material-Design 风格滑动 */
.ac-progress{
  position:absolute;top:0;left:0;right:0;height:2px;
  border-radius:2px 2px 0 0;
  background:color-mix(in srgb, var(--ac) 18%, transparent);
  overflow:hidden;z-index:2;pointer-events:none;
}
.ac-progress::after{
  content:'';position:absolute;top:0;height:100%;
  width:40%;background:var(--ac);border-radius:2px;
  animation:ac-progress-slide 1.1s cubic-bezier(.4,0,.2,1) infinite;
}
@keyframes ac-progress-slide{
  0%{left:-40%}
  100%{left:100%}
}

/* 卡片切换过渡 — out-in fade + slight slide */
.ac-swap-enter-active{
  transition:opacity .26s ease, transform .26s cubic-bezier(.34,1.56,.64,1);
}
.ac-swap-leave-active{
  transition:opacity .15s ease, transform .15s ease;
}
.ac-swap-enter-from{opacity:0;transform:translateY(4px) scale(.985)}
.ac-swap-leave-to{opacity:0;transform:translateY(-3px) scale(1.005)}

/* 新激活卡片 highlight pulse (~1.5s) — 强调"已切换到这个账号" */
.ac-card.just-switched{
  animation:ac-highlight 1.5s ease-out;
}
@keyframes ac-highlight{
  0%{
    border-color:var(--ac);
    box-shadow:0 0 0 0 color-mix(in srgb, var(--ac) 50%, transparent),
               0 0 14px 2px color-mix(in srgb, var(--ac) 22%, transparent);
  }
  60%{
    border-color:color-mix(in srgb, var(--ac) 55%, var(--bd));
    box-shadow:0 0 0 3px color-mix(in srgb, var(--ac) 0%, transparent),
               0 0 6px 1px color-mix(in srgb, var(--ac) 10%, transparent);
  }
  100%{
    border-color:var(--bd);
    box-shadow:0 0 0 0 transparent;
  }
}

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
/* 柔和胶囊 — 与 AccountCard 的 .a-plan/.a-days 风格一致 */
.ac-plan,.ac-expiry{
  font-size:10.5px;font-weight:500;line-height:1.4;
  padding:1px 6px;border-radius:4px;letter-spacing:.1px;
  flex-shrink:0;white-space:nowrap;
}
/* Tier-tinted plan tags — same shape, distinct hue per tier */
.ac-plan.t-free{color:var(--tx2);background:color-mix(in srgb,var(--tx) 8%,transparent)}
.ac-plan.t-trial{color:var(--yw);background:color-mix(in srgb,var(--yw) 14%,transparent)}
.ac-plan.t-pro{color:var(--ac);background:var(--ac-bg)}
.ac-plan.t-max{color:#a78bfa;background:color-mix(in srgb,#a78bfa 16%,transparent)}
.ac-plan.t-teams{color:#22c55e;background:color-mix(in srgb,#22c55e 14%,transparent)}
.ac-plan.t-enterprise{color:#f59e0b;background:color-mix(in srgb,#f59e0b 16%,transparent)}
/* .ac-expiry: color/background via :style="expiryStyle" */

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

/* v22.6: 出口 IP 显示行 */
.ac-egress{
  display:flex;align-items:center;gap:5px;flex-wrap:wrap;
  font-size:10.5px;line-height:1;
  padding:3px 6px;margin:1px 0;
  background:color-mix(in srgb, var(--tx) 4%, transparent);
  border-radius:4px;
  cursor:pointer;
  transition:background .15s ease;
  user-select:none;
}
.ac-egress:hover{background:color-mix(in srgb, var(--tx) 8%, transparent)}
.eg-label{font-size:10px;color:var(--tx3);font-weight:500;flex-shrink:0}
.eg-flag{font-size:11px;line-height:1;flex-shrink:0}
.eg-ip{
  font-size:11px;color:var(--tx);font-weight:600;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  letter-spacing:-.2px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.eg-country{font-size:10px;color:var(--tx2);font-weight:500}
.eg-pending{font-size:10px;color:var(--tx3);font-style:italic}
.eg-refresh{
  margin-left:auto;font-size:11px;color:var(--tx3);
  flex-shrink:0;line-height:1;
  transition:color .15s ease;
}
.ac-egress:hover .eg-refresh{color:var(--ac)}
.eg-refresh.spinning{animation:spin 1s linear infinite;color:var(--ac)}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}

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
