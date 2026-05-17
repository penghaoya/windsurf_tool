<template>
  <div
    class="ac"
    :class="{ cur: isCurrent, rl: isRateLimited, exp: account.isExpired, blk: isBlocked, dep: isDailyDepleted, badauth: isInvalidAuth, sel: isSelected, 'batch-on': batchMode }"
    :id="`row${index}`"
    @click.capture="onCardClick"
  >
    <!-- Row 1: Tags left + Actions right -->
    <div class="ac-head">
      <div v-if="batchMode" class="ac-chk" :class="{on: isSelected}">
        <svg v-if="isSelected" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <span class="dot" :class="statusClass"></span>
      <span class="ac-idx">#{{ index + 1 }}</span>
      <span v-if="account.usage?.plan" class="a-plan" :class="planClass">{{ account.usage.plan }}</span>
      <span v-if="daysTag" class="a-days" :style="daysStyle">{{ daysTag }}</span>
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
          v-if="isCurrent"
          class="r-btn fp"
          :class="{ spinning: fingerprinting, done: fingerprintState === 'ok' }"
          @click="onResetFingerprint"
          title="重置当前账号指纹"
        >
          <svg v-if="fingerprintState === 'ok'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
          <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 11v2"/>
            <path d="M8 11v1a4 4 0 0 0 8 0v-1"/>
            <path d="M7 7a5 5 0 0 1 10 0v3"/>
            <path d="M6 14a6 6 0 0 0 12 0"/>
            <path d="M4 11v2a8 8 0 0 0 16 0v-2"/>
          </svg>
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
          ok
        </button>
      </div>
    </div>

    <!-- Row 2: 邮箱 + 右侧 meta (切换次数 / 加入时长 / 重置倒计时) -->
    <div class="ac-email-row">
      <span class="ac-name" :title="account.email">{{ account.email }}</span>
      <span v-if="metaText" class="ac-meta" :title="metaTitle">{{ metaText }}</span>
    </div>

    <div v-if="switchBadge" class="switch-badge" :class="switchBadge.kind">
      <span>{{ switchBadge.text }}</span>
      <button
        v-if="switchBadge.canRetry"
        class="mini-link"
        type="button"
        @click="postMessage('login', { index })"
      >
        重试
      </button>
      <button
        v-if="switchBadge.canOpenLog"
        class="mini-link"
        type="button"
        @click="postMessage('showLogs')"
      >
        日志
      </button>
    </div>

    <!-- Quota Meters -->
    <div class="ac-meters">
      <QuotaMeter label="天" :pct="dailyPct" />
      <QuotaMeter label="周" :pct="weeklyPct" />
    </div>

    <!-- Daily Depleted Badge -->
    <div v-if="isDailyDepleted && !isRateLimited" class="ac-dep">
      <span>日额度耗尽</span>
    </div>

    <div v-if="isInvalidAuth" class="ac-auth">
      <span>登录凭据无效</span>
      <button class="ac-auth-clear" @click.stop="onClearAuthError" title="解除标记">解除</button>
    </div>

    <div v-if="switchFailureBadge" class="ac-auth ac-sf" :title="switchFailureBadge.tooltip">
      <span>⚠ 切换失败 ×{{ switchFailureBadge.count }}</span>
      <span v-if="switchFailureBadge.hint" class="ac-sf-hint">{{ switchFailureBadge.hint }}</span>
      <button class="ac-auth-clear" @click.stop="onClearAuthError" title="解除标记">解除</button>
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
import { ref, computed, watch, inject, onBeforeUnmount } from 'vue'
import { actionResults, postMessage, pwdResults, requestAction } from '../composables/useVscode.js'
import { dotClass, urgencyColor, formatPlanRemaining, fmtAgo } from '../utils/format.js'
import QuotaMeter from './QuotaMeter.vue'

const props = defineProps({
  account: { type: Object, required: true },
  index: { type: Number, required: true },
  isCurrent: { type: Boolean, default: false },
  threshold: { type: Number, default: 5 },
  switchStatus: { type: Object, default: null },
})

// Batch selection (injected from App.vue)
const batchMode = inject('batchMode', ref(false))
const batchSelected = inject('batchSelected', {})
const batchToggle = inject('batchToggle', () => {})
const isSelected = computed(() => batchMode.value && !!batchSelected[props.account.email])

function onCardClick(e) {
  if (!batchMode.value) return
  e.stopPropagation()
  e.preventDefault()
  batchToggle(props.account.email)
}

const now = ref(Date.now())
let clockTimer = null
function startClock() {
  if (clockTimer) return
  clockTimer = setInterval(() => { now.value = Date.now() }, 1000)
}
function stopClock() {
  if (!clockTimer) return
  clearInterval(clockTimer)
  clockTimer = null
}

const confirmRemove = ref(false)
const copyState = ref('idle') // 'idle' | 'ok'
const refreshing = ref(false)
const refreshRequestId = ref(null)
const fingerprinting = ref(false)
const fingerprintState = ref('idle') // 'idle' | 'ok'
const fingerprintRequestId = ref(null)
let confirmTimer = null
let copyTimer = null
let fingerprintTimer = null

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

const needsClock = computed(() => {
  const maxUntil = Math.max(rateLimitUntil.value || 0, quarantineUntil.value || 0, poolCoolUntil.value || 0)
  return maxUntil > now.value
})
watch(needsClock, (v) => v ? startClock() : stopClock(), { immediate: true })

const isDailyDepleted = computed(() => props.account.dailyDepleted === true)
const isInvalidAuth = computed(() => props.account.invalidAuth === true)

// why: surface accumulated switch failures so user can decide retry vs abandon
const switchFailureBadge = computed(() => {
  const err = props.account.authError
  if (!err || err.type !== 'switch_failed') return null
  const count = err.count || 1
  const msg = String(err.message || '').slice(0, 64)
  const hint = msg && msg !== 'none' ? msg : '注入失败'
  return {
    count,
    hint,
    tooltip: `${count} 次失败 · ${msg || 'unknown'}\n首次: ${new Date(err.firstAt || err.at).toLocaleString()}`,
  }
})

const effectiveRemaining = computed(() => props.account.effective ?? null)

const isPendingSwitchTarget = computed(() => props.switchStatus?.pendingIndex === props.index)
const isConfirmedSwitchTarget = computed(() => props.switchStatus?.confirmedIndex === props.index)

const switchBadge = computed(() => {
  const phase = props.switchStatus?.phase
  if ((phase === 'switching' || phase === 'verifying') && isPendingSwitchTarget.value) {
    return {
      kind: 'pending',
      text: phase === 'switching' ? '切换中' : '验证中',
      canRetry: false,
      canOpenLog: false,
    }
  }
  if (phase === 'confirmed' && isConfirmedSwitchTarget.value) {
    return { kind: 'ok', text: '已确认切换', canRetry: false, canOpenLog: false }
  }
  if (phase === 'uncertain' && isPendingSwitchTarget.value) {
    return { kind: 'warn', text: '可能未生效', canRetry: true, canOpenLog: true }
  }
  if (phase === 'failed' && isPendingSwitchTarget.value) {
    return { kind: 'bad', text: '切换失败', canRetry: true, canOpenLog: true }
  }
  return null
})

const statusClass = computed(() =>
  dotClass(effectiveRemaining.value, props.threshold, props.account.isExpired)
)

// v21.0: quota mode — one dimension missing → show 0% (matches effectiveRemaining logic)
const dailyPct = computed(() => {
  const d = props.account.usage?.daily?.remaining ?? null
  if (d !== null) return d
  const isQuota = props.account.usage?.mode === 'quota' || props.account.usage?.daily || props.account.usage?.weekly
  if (isQuota && props.account.usage?.weekly?.remaining != null) return 0
  return null
})
const weeklyPct = computed(() => {
  const w = props.account.usage?.weekly?.remaining ?? null
  if (w !== null) return w
  const isQuota = props.account.usage?.mode === 'quota' || props.account.usage?.daily || props.account.usage?.weekly
  if (isQuota && props.account.usage?.daily?.remaining != null) return 0
  return null
})

// Tier-based plan-tag color class (Trial takes priority — free-trial with pro should still show as trial)
const planClass = computed(() => {
  const p = String(props.account.usage?.plan || '').toLowerCase()
  if (!p) return 't-free'
  if (p.includes('trial')) return 't-trial'
  if (p.includes('enterprise')) return 't-enterprise'
  if (p.includes('max')) return 't-max'
  if (p.includes('team')) return 't-teams'
  if (p.includes('pro')) return 't-pro'
  return 't-free'
})

const daysTag = computed(() => {
  if (props.account.isExpired) return '已过期'
  const end = props.account.planEnd
  if (end) return formatPlanRemaining(end)
  const d = props.account.planDays
  if (d !== null && d !== undefined) return `${d}天`
  return ''
})

// v20.4: per-account meta only (loginCount differs per account; reset times are global → PoolOverview)
const metaText = computed(() => {
  const loginCount = props.account.loginCount || 0
  if (loginCount > 0) return `切${loginCount}次`
  // Fresh account never used → show how long it has been in the pool
  if (props.account.addedAt) return `添加${fmtAgo(props.account.addedAt)}`
  return ''
})
const metaTitle = computed(() => {
  const bits = []
  if (props.account.addedAt) bits.push(`添加于 ${fmtAgo(props.account.addedAt)}`)
  if (props.account.loginCount) bits.push(`已切换 ${props.account.loginCount} 次`)
  return bits.join(' · ')
})

const daysStyle = computed(() => {
  const color = props.account.isExpired ? 'var(--rd)' : urgencyColor(props.account.urgency ?? -1)
  return {
    color,
    background: `color-mix(in srgb, ${color} 14%, transparent)`,
  }
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
  refreshRequestId.value = requestAction('refreshOne', { index: props.index })
}

watch(() => refreshRequestId.value ? actionResults[refreshRequestId.value] : null, (result) => {
  if (!result || !refreshRequestId.value) return
  delete actionResults[refreshRequestId.value]
  refreshRequestId.value = null
  refreshing.value = false
})

function onResetFingerprint() {
  if (fingerprinting.value) return
  fingerprinting.value = true
  fingerprintState.value = 'idle'
  fingerprintRequestId.value = requestAction('resetAccountFingerprint', { index: props.index })
}

watch(() => fingerprintRequestId.value ? actionResults[fingerprintRequestId.value] : null, (result) => {
  if (!result || !fingerprintRequestId.value) return
  delete actionResults[fingerprintRequestId.value]
  fingerprintRequestId.value = null
  fingerprinting.value = false
  if (result.ok) {
    fingerprintState.value = 'ok'
    clearTimeout(fingerprintTimer)
    fingerprintTimer = setTimeout(() => { fingerprintState.value = 'idle' }, 1600)
  }
})

function onClearRateLimit() {
  postMessage('clearRateLimit', { index: props.index })
}

function onClearAuthError() {
  postMessage('clearAuthError', { index: props.index })
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
  clearTimeout(confirmTimer)
  clearTimeout(copyTimer)
  clearTimeout(fingerprintTimer)
  stopClock()
})
</script>

<style scoped>
.ac{background:var(--sf);border:1px solid var(--bd);border-radius:var(--R);padding:5px 8px;transition:border-color .12s ease,background-color .12s ease;contain:layout style paint}
.ac:hover{border-color:var(--bd2);background:var(--sf2)}
.ac.cur{border-color:var(--gn);background:color-mix(in srgb, var(--gn) 6%, var(--sf));box-shadow:0 0 8px color-mix(in srgb, var(--gn) 8%, transparent)}
.ac.dep{opacity:.35}
.ac.rl{opacity:.45}
.ac.blk:not(.rl){opacity:.55}
.ac.badauth{opacity:.38}
.ac.exp{opacity:.3}
.ac-head{display:flex;align-items:center;gap:4px;margin-bottom:1px;min-height:22px}
.dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.dot.ok{background:var(--gn)}.dot.warn{background:var(--yw)}.dot.bad{background:var(--rd)}.dot.dm{background:var(--tx3)}
.ac-email-row{display:flex;align-items:baseline;gap:6px;margin-bottom:2px}
.ac-idx{font-size:10.5px;font-weight:700;color:var(--tx2);flex-shrink:0;letter-spacing:.2px}
.ac-name{font-weight:600;color:var(--tx);font-size:12px;word-break:break-all;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.ac-meta{font-size:10px;color:var(--tx3);flex-shrink:0;font-feature-settings:"tnum";letter-spacing:.1px;cursor:help}
.a-plan,.a-days{font-size:10.5px;font-weight:500;line-height:1.4;padding:1px 6px;border-radius:4px;letter-spacing:.1px;flex-shrink:0;white-space:nowrap}
/* Tier-tinted plan tags — same shape, distinct hue per tier */
.a-plan.t-free{color:var(--tx2);background:color-mix(in srgb,var(--tx) 8%,transparent)}
.a-plan.t-trial{color:var(--yw);background:color-mix(in srgb,var(--yw) 14%,transparent)}
.a-plan.t-pro{color:var(--ac);background:var(--ac-bg)}
.a-plan.t-max{color:#a78bfa;background:color-mix(in srgb,#a78bfa 16%,transparent)}
.a-plan.t-teams{color:#22c55e;background:color-mix(in srgb,#22c55e 14%,transparent)}
.a-plan.t-enterprise{color:#f59e0b;background:color-mix(in srgb,#f59e0b 16%,transparent)}
/* .a-days bg/color via inline style (computed by daysStyle from urgency) */
.ac-acts{display:flex;gap:2px;flex-shrink:0;margin-left:auto}
.r-btn{width:22px;height:22px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--tx3);cursor:pointer;border-radius:var(--R3);transition:background-color .1s ease,color .1s ease}
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
.r-btn.fp{color:var(--tx3)}
.r-btn.fp:hover{background:color-mix(in srgb, var(--gn) 12%, transparent);color:var(--gn)}
.r-btn.fp.spinning svg{animation:spin .8s linear infinite}
.r-btn.fp.done{color:var(--gn)}
/* P1: hover-reveal for low-freq buttons */
.hover-btn{opacity:0;pointer-events:none;transition:opacity .15s ease}
.ac:hover .hover-btn{opacity:1;pointer-events:auto}
/* P2: inline delete confirm */
.del-confirm{border:none;background:transparent;color:var(--rd);cursor:pointer;border-radius:var(--R3);font-size:10px;font-weight:500;padding:2px 5px;height:22px;white-space:nowrap;text-decoration:underline;text-underline-offset:2px;animation:confirm-in .15s ease}
.del-confirm:hover{background:var(--rd-bg)}
@keyframes confirm-in{from{opacity:0;transform:translateX(4px)}to{opacity:1;transform:translateX(0)}}
.ac-meters{display:flex;gap:6px}
.switch-badge{display:flex;align-items:center;gap:6px;margin:3px 0 4px;font-size:11px;line-height:1.6}
.switch-badge.pending{color:var(--ac)}
.switch-badge.ok{color:var(--gn)}
.switch-badge.warn{color:var(--yw)}
.switch-badge.bad{color:var(--rd)}
.mini-link{border:none;background:transparent;color:inherit;cursor:pointer;font:inherit;text-decoration:underline;text-underline-offset:2px;padding:0 1px}
.mini-link:hover{color:var(--tx)}
.ac-rl{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--yw);margin-top:3px}
.ac-rl-time{color:var(--tx2)}
.ac-qr{color:var(--rd)}
.ac-pc{color:var(--ac)}
.ac-dep{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--tx3);margin-top:3px}
.ac-auth{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--rd);margin-top:3px}
.ac-auth.ac-sf{color:var(--yw)}
.ac-sf-hint{color:var(--tx3);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px}
.ac-auth-clear{margin-left:auto;border:1px solid var(--bd2);background:transparent;color:inherit;font:inherit;font-size:10px;padding:1px 6px;border-radius:3px;cursor:pointer;line-height:1.4}
.ac-auth-clear:hover{background:color-mix(in srgb, currentColor 12%, transparent);border-color:currentColor}
.ac.sel{border-color:var(--ac);background:color-mix(in srgb, var(--ac) 8%, var(--sf))}
.ac.batch-on{cursor:pointer}
.ac.batch-on .ac-acts{opacity:.3;pointer-events:none}
.ac-chk{width:14px;height:14px;border-radius:3px;border:1.5px solid var(--bd2);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .12s}
.ac-chk.on{background:var(--ac);border-color:var(--ac);color:#fff}
</style>
