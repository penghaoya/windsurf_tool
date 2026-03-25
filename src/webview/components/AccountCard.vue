<template>
  <div
    class="ac"
    :class="{ cur: isCurrent, rl: isRateLimited, exp: account.isExpired, blk: isBlocked }"
    :id="`row${index}`"
  >
    <!-- Row 1: Tags left + Actions right -->
    <div class="ac-head">
      <span class="dot" :class="statusClass"></span>
      <span v-if="account.usage?.plan" class="a-plan">{{ account.usage.plan }}</span>
      <span v-if="daysTag" class="a-days" :style="{ color: daysColor }">{{ daysTag }}</span>
      <div class="ac-acts">
        <button
          class="r-btn login"
          :class="{ active: isCurrent }"
          @click="postMessage('login', { index })"
          :title="isCurrent ? '当前' : '切换'"
        >
          <svg v-if="isCurrent" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
          <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button
          class="r-btn rfsh"
          :class="{ spinning: refreshing }"
          @click="onRefresh"
          title="刷新额度"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0115.36-6.36L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 01-15.36 6.36L3 16"/></svg>
        </button>
        <button
          class="r-btn copy hover-btn"
          :id="`cp${index}`"
          @click="onCopy"
          title="复制密码"
        >
          <svg v-if="copyState === 'ok'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
          <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </button>
        <button
          v-if="isRateLimited || isBlocked"
          class="r-btn rl-clear hover-btn"
          @click="onClearRateLimit"
          title="解除限流/隔离"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M8 8l8 8"/>
            <path d="M16 8l-8 8"/>
            <path d="M6 3h12l3 5-9 13L3 8l3-5z"/>
          </svg>
        </button>
        <button
          v-if="!confirmRemove"
          class="r-btn del hover-btn"
          :id="`bx${index}`"
          @click="onRemove"
          title="移除"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <button
          v-if="confirmRemove"
          class="r-btn del-confirm"
          @click="onRemove"
        >
          确认删除
        </button>
      </div>
    </div>

    <!-- Row 2: #序号 + 完整邮箱 -->
    <div class="ac-email-row">
      <span class="ac-idx">#{{ index + 1 }}</span>
      <span class="ac-name" :title="account.email">{{ account.email }}</span>
    </div>

    <!-- Quota Meters -->
    <div class="ac-meters">
      <QuotaMeter
        label="天"
        :pct="dailyPct"
        :resetTime="account.usage?.daily?.resetTime || account.usage?.resetTime"
        :resetCountdown="null"
      />
      <QuotaMeter
        label="周"
        :pct="weeklyPct"
        :resetTime="account.usage?.weekly?.resetTime || account.usage?.weeklyReset"
        :resetCountdown="null"
      />
    </div>

    <!-- Rate Limited Badge -->
    <div v-if="isRateLimited" class="ac-rl">
      <span>⏳ 限流中</span>
      <span v-if="rateLimitLabel" class="ac-rl-time">{{ rateLimitLabel }}</span>
    </div>
    <!-- Scheduler Blocked Badges (quarantine / pool cooldown) -->
    <div v-if="quarantineLabel" class="ac-rl ac-qr">
      <span>🔒 隔离中</span>
      <span class="ac-rl-time">{{ quarantineLabel }}</span>
    </div>
    <div v-if="poolCoolLabel" class="ac-rl ac-pc">
      <span>❄ 池冷却</span>
      <span class="ac-rl-time">{{ poolCoolLabel }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { postMessage, pwdResults } from '../composables/useVscode.js'
import { dotClass, urgencyColor } from '../utils/format.js'
import QuotaMeter from './QuotaMeter.vue'

const props = defineProps({
  account: { type: Object, required: true },
  index: { type: Number, required: true },
  isCurrent: { type: Boolean, default: false },
  threshold: { type: Number, default: 5 },
})

const confirmRemove = ref(false)
const copyState = ref('idle') // 'idle' | 'ok'
const refreshing = ref(false)
const now = ref(Date.now())
let confirmTimer = null
let copyTimer = null
const rateLimitTimer = setInterval(() => {
  now.value = Date.now()
}, 1000)

const rateLimitUntil = computed(() =>
  props.account.rateLimitInfo?.until ?? props.account.rateLimit?.until ?? null
)

const remainingCooldown = computed(() => {
  if (!rateLimitUntil.value) return 0
  return Math.max(0, Math.ceil((rateLimitUntil.value - now.value) / 1000))
})

const isRateLimited = computed(() => remainingCooldown.value > 0)

const rateLimitLabel = computed(() => formatCooldown(remainingCooldown.value))

// Scheduler blocked states (quarantine / pool cooldown)
const quarantineUntil = computed(() => props.account.schedulerBlocked?.quarantined?.until ?? null)
const poolCoolUntil = computed(() => props.account.schedulerBlocked?.poolCooled?.until ?? null)

const quarantineRemaining = computed(() => {
  if (!quarantineUntil.value) return 0
  return Math.max(0, Math.ceil((quarantineUntil.value - now.value) / 1000))
})
const poolCoolRemaining = computed(() => {
  if (!poolCoolUntil.value) return 0
  return Math.max(0, Math.ceil((poolCoolUntil.value - now.value) / 1000))
})

const quarantineLabel = computed(() => formatCooldown(quarantineRemaining.value))
const poolCoolLabel = computed(() => formatCooldown(poolCoolRemaining.value))
const isBlocked = computed(() => quarantineRemaining.value > 0 || poolCoolRemaining.value > 0)

const effectiveRemaining = computed(() => props.account.effective ?? null)

const statusClass = computed(() =>
  dotClass(effectiveRemaining.value, props.threshold, props.account.isExpired)
)

const dailyPct = computed(() => props.account.usage?.daily?.remaining ?? null)
const weeklyPct = computed(() => props.account.usage?.weekly?.remaining ?? null)

const daysTag = computed(() => {
  if (props.account.isExpired) return '已过期'
  const d = props.account.planDays
  if (d !== null && d !== undefined) return `${d}天`
  return ''
})

const daysColor = computed(() => {
  if (props.account.isExpired) return 'var(--rd)'
  const urgency = props.account.urgency ?? -1
  return urgencyColor(urgency)
})

function onCopy() {
  postMessage('copyPwd', { index: props.index })
}

// Watch for pwd result from extension host
watch(() => pwdResults[props.index], (result) => {
  if (result?.pwd) {
    const copyText = (result.email || '') + '\u002d\u002d\u002d\u002d' + result.pwd
    navigator.clipboard.writeText(copyText).then(() => {
      copyState.value = 'ok'
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => { copyState.value = 'idle' }, 1500)
    }).catch(() => {
      copyState.value = 'idle'
    })
    // Clear the result
    delete pwdResults[props.index]
  }
})

function onRefresh() {
  if (refreshing.value) return
  refreshing.value = true
  postMessage('refreshOne', { index: props.index })
  setTimeout(() => { refreshing.value = false }, 3000)
}

function onClearRateLimit() {
  postMessage('clearRateLimit', { index: props.index })
}

function onRemove() {
  if (confirmRemove.value) {
    clearTimeout(confirmTimer)
    confirmRemove.value = false
    postMessage('remove', { index: props.index })
  } else {
    confirmRemove.value = true
    confirmTimer = setTimeout(() => { confirmRemove.value = false }, 2000)
  }
}

function formatCooldown(totalSeconds) {
  if (!totalSeconds || totalSeconds <= 0) return ''
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

onBeforeUnmount(() => {
  clearInterval(rateLimitTimer)
  clearTimeout(confirmTimer)
  clearTimeout(copyTimer)
})
</script>

<style scoped>
.ac{background:var(--sf);border:1px solid var(--bd);border-radius:var(--R);padding:8px 10px;margin-bottom:5px;transition:all .15s ease}
.ac:hover{border-color:var(--bd2);background:var(--sf2)}
.ac.cur{border-color:var(--gn);background:color-mix(in srgb, var(--gn) 6%, var(--sf));box-shadow:0 0 8px color-mix(in srgb, var(--gn) 8%, transparent)}
.ac.rl{opacity:.45}
.ac.blk:not(.rl){opacity:.55}
.ac.exp{opacity:.3}
.ac-head{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.dot.ok{background:var(--gn)}.dot.warn{background:var(--yw)}.dot.bad{background:var(--rd)}.dot.dm{background:var(--tx3)}
.ac-email-row{display:flex;align-items:baseline;gap:5px;margin-bottom:5px}
.ac-idx{font-size:11px;font-weight:700;color:var(--tx2);flex-shrink:0}
.ac-name{font-weight:600;color:var(--tx);font-size:12px;word-break:break-all;line-height:1.3}
.a-plan{font-size:10px;font-weight:600;padding:1px 5px;border-radius:3px;border:1px solid var(--ac);color:var(--ac);letter-spacing:.2px;flex-shrink:0}
.a-days{font-size:11px;font-weight:500;flex-shrink:0}
.ac-acts{display:flex;gap:2px;flex-shrink:0;margin-left:auto}
.r-btn{width:24px;height:24px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--tx3);cursor:pointer;border-radius:var(--R3);transition:all .12s ease}
.r-btn:hover{background:var(--bg2);color:var(--tx)}
.r-btn:active{transform:scale(.9)}
.r-btn.login{color:var(--ac)}
.r-btn.login:hover{background:var(--ac-bg);color:var(--ac)}
.r-btn.login.active{color:var(--gn)}
.r-btn.login.active:hover{background:var(--gn-bg)}
.r-btn.rfsh{color:var(--tx3)}
.r-btn.rfsh:hover{background:var(--ac-bg);color:var(--ac)}
.r-btn.rfsh.spinning svg{animation:spin .8s linear infinite}
.r-btn.rl-clear{color:var(--yw)}
.r-btn.rl-clear:hover{background:color-mix(in srgb, var(--yw) 12%, transparent);color:var(--yw)}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.r-btn.del:hover{background:var(--rd-bg);color:var(--rd)}
.r-btn.copy{color:var(--tx3)}
.r-btn.copy:hover{background:var(--ac-bg);color:var(--ac)}
/* P1: hover-reveal for low-freq buttons */
.hover-btn{opacity:0;pointer-events:none;transition:opacity .15s ease}
.ac:hover .hover-btn{opacity:1;pointer-events:auto}
/* P2: inline delete confirm */
.del-confirm{border:none;background:var(--rd-bg);color:var(--rd);cursor:pointer;border-radius:var(--R3);font-size:11px;font-weight:600;padding:2px 8px;height:24px;white-space:nowrap;animation:confirm-in .15s ease}
.del-confirm:hover{background:var(--rd);color:#fff}
@keyframes confirm-in{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}}
.ac-meters{display:flex;flex-direction:column;gap:4px}
.ac-rl{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--yw);margin-top:4px}
.ac-rl-time{color:var(--tx2)}
.ac-qr{color:var(--rd)}
.ac-pc{color:var(--ac)}
</style>
