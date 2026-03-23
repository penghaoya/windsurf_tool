<template>
  <div
    class="ac"
    :class="{ cur: isCurrent, rl: isRateLimited, exp: account.isExpired }"
    :id="`row${index}`"
  >
    <!-- Header -->
    <div class="ac-head">
      <span class="dot" :class="statusClass"></span>
      <span class="ac-name" :title="account.email">{{ account.email }}</span>
      <span v-if="account.usage?.plan" class="a-plan">{{ account.usage.plan }}</span>
      <span v-if="daysTag" class="a-days" :style="{ color: daysColor }">{{ daysTag }}</span>
      <div class="ac-acts">
        <button
          class="r-btn login"
          :class="{ active: isCurrent }"
          @click="postMessage('login', { index })"
          :title="isCurrent ? '当前' : '切换'"
        >
          <svg v-if="isCurrent" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
          <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button
          class="r-btn copy"
          :id="`cp${index}`"
          @click="onCopy"
          title="复制密码"
        >
          <svg v-if="copyState === 'ok'" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
          <svg v-else width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </button>
        <button
          class="r-btn rfsh"
          :class="{ spinning: refreshing }"
          @click="onRefresh"
          title="刷新额度"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0115.36-6.36L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 01-15.36 6.36L3 16"/></svg>
        </button>
        <button
          class="r-btn del"
          :id="`bx${index}`"
          @click="onRemove"
          title="移除"
        >
          <span v-if="confirmRemove" style="font-size:9px;font-weight:600">?</span>
          <svg v-else width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
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
    <div v-if="isRateLimited" class="ac-rl">⏳ 限流中</div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
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
let confirmTimer = null
let copyTimer = null

const isRateLimited = computed(() => {
  const rl = props.account.rateLimit
  return rl && rl.until > Date.now()
})

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
</script>

<style scoped>
.ac{background:var(--sf);border:1px solid var(--bd);border-radius:var(--R);padding:8px 10px;margin-bottom:4px;transition:all .15s ease}
.ac:hover{border-color:var(--bd2);background:var(--sf2)}
.ac.cur{border-color:rgba(94,218,158,.25);background:rgba(94,218,158,.04)}
.ac.rl{opacity:.45}
.ac.exp{opacity:.3}
.ac-head{display:flex;align-items:center;gap:5px;margin-bottom:5px}
.dot{width:5px;height:5px;border-radius:50%;flex-shrink:0}
.dot.ok{background:var(--gn)}.dot.warn{background:var(--yw)}.dot.bad{background:var(--rd)}.dot.dm{background:var(--tx3)}
.ac-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--tx);font-size:11px}
.a-plan{font-size:8px;font-weight:600;padding:0 4px;border-radius:3px;border:1px solid var(--ac);color:var(--ac);letter-spacing:.2px;flex-shrink:0}
.a-days{font-size:9px;font-weight:500;flex-shrink:0}
.ac-acts{display:flex;gap:1px;flex-shrink:0;margin-left:auto}
.r-btn{width:20px;height:20px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--tx3);cursor:pointer;border-radius:var(--R3);transition:all .12s ease}
.r-btn:hover{background:var(--bg2);color:var(--tx)}
.r-btn:active{transform:scale(.9)}
.r-btn.login{color:var(--ac)}
.r-btn.login:hover{background:var(--ac-bg);color:var(--ac)}
.r-btn.login.active{color:var(--gn)}
.r-btn.login.active:hover{background:var(--gn-bg)}
.r-btn.rfsh{color:var(--tx3)}
.r-btn.rfsh:hover{background:var(--ac-bg);color:var(--ac)}
.r-btn.rfsh.spinning svg{animation:spin .8s linear infinite}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.r-btn.del:hover{background:var(--rd-bg);color:var(--rd)}
.r-btn.copy{color:var(--tx3)}
.r-btn.copy:hover{background:var(--ac-bg);color:var(--ac)}
.ac-meters{display:flex;flex-direction:column;gap:3px}
.ac-rl{font-size:9px;color:var(--yw);margin-top:3px}
</style>
