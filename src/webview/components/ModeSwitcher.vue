<template>
  <div class="mode-hint" :class="hintClass">
    <span class="hint-dot"></span>
    <span class="hint-text">{{ hintText }}</span>
  </div>
  <div class="mode-bar">
    <div class="mode-seg" role="tablist">
      <button
        class="seg-btn"
        :class="{ active: autoRotate }"
        role="tab"
        :aria-selected="autoRotate"
        @click="setMode(true)"
        title="启用全部自动调度 (预防/响应/限流/Opus 预算等)"
      >
        <svg v-if="autoRotate" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
        <svg v-else width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>
        自动
      </button>
      <button
        class="seg-btn"
        :class="{ active: !autoRotate }"
        role="tab"
        :aria-selected="!autoRotate"
        @click="setMode(false)"
        title="仅在激活账号剩余≤阈值时才自动切换，其余时间手动"
      >
        <svg v-if="!autoRotate" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
        <svg v-else width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>
        手动
      </button>
    </div>

    <span class="mode-spacer"></span>

    <div class="mode-field" :title="autoRotate ? '自动模式: 达到该剩余额度时提前切换' : '手动模式: 激活账号≤此值时自动切换一次 (0=纯手动)'">
      <span class="f-label">{{ autoRotate ? '预防' : '安全网' }}</span>
      <div class="f-input-wrap">
        <input
          type="number"
          min="0"
          max="100"
          step="1"
          class="f-input"
          :value="autoRotate ? threshold : manualThreshold"
          @change="onThresholdChange"
          @keydown.enter="onThresholdChange"
        />
        <span class="f-suffix">%</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { postMessage } from '../composables/useVscode.js'
import { ACTION } from '../../extension/shared/messageTypes.js'

const props = defineProps({
  autoRotate: { type: Boolean, default: true },
  threshold: { type: Number, default: 15 },
  manualThreshold: { type: Number, default: 0 },
})

const hintText = computed(() => {
  if (props.autoRotate) {
    return `自动调度 — 剩余 ≤ ${props.threshold}% 时预防性切换`
  }
  if (props.manualThreshold > 0) {
    return `激活账号 ≤ ${props.manualThreshold}% 时自动切换`
  }
  return '纯手动 — 不会自动切换'
})

const hintClass = computed(() => {
  if (props.autoRotate) return 'hint-auto'
  return props.manualThreshold > 0 ? 'hint-manual-armed' : 'hint-manual-idle'
})

function setMode(auto) {
  if (props.autoRotate === auto) return
  postMessage(ACTION.SET_AUTO_ROTATE, { value: auto })
}

function onThresholdChange(e) {
  let v = parseInt(e.target.value, 10)
  if (!Number.isFinite(v)) v = 0
  v = Math.max(0, Math.min(100, v))
  e.target.value = v
  const action = props.autoRotate ? ACTION.SET_PREEMPTIVE_THRESHOLD : ACTION.SET_MANUAL_THRESHOLD
  postMessage(action, { value: v })
}
</script>

<style scoped>
/* Flat row to harmonize with Toolbar — no outer card. Controls carry their own borders */
.mode-bar{
  display:flex;align-items:center;gap:3px;
  margin-bottom:4px;
}
.mode-spacer{flex:1}

.mode-seg{
  display:inline-flex;gap:0;
  border:1px solid var(--bd);border-radius:var(--R3);
  background:var(--btn-bg);
  overflow:hidden;
  height:24px;
}
.seg-btn{
  display:inline-flex;align-items:center;gap:4px;
  padding:0 9px;font-size:11px;font-weight:500;
  background:transparent;color:var(--tx2);border:0;
  cursor:pointer;transition:background .15s ease,color .15s ease;
  line-height:1;height:100%;
}
.seg-btn + .seg-btn{border-left:1px solid var(--bd)}
.seg-btn:hover{background:var(--btn-hover);color:var(--tx)}
.seg-btn.active{background:var(--ac-bg);color:var(--ac);font-weight:600}
.seg-btn svg{flex-shrink:0;opacity:.7}
.seg-btn.active svg{opacity:1}

.mode-field{
  display:inline-flex;align-items:center;gap:5px;
  height:24px;padding:0 8px;
  border:1px solid var(--bd);border-radius:var(--R3);
  background:var(--btn-bg);
  transition:border-color .15s ease;
}
.mode-field:focus-within{border-color:var(--ac)}
.f-label{
  font-size:10px;color:var(--tx3);font-weight:500;white-space:nowrap;
  letter-spacing:.2px;
}
.f-input-wrap{display:inline-flex;align-items:baseline;gap:1px}
.f-input{
  width:28px;padding:0;
  background:transparent;border:0;outline:none;
  color:var(--tx);font-size:11px;font-weight:600;text-align:right;
  -moz-appearance:textfield;
}
.f-input::-webkit-outer-spin-button,
.f-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.f-suffix{font-size:10px;color:var(--tx3);font-weight:500}

/* Always-rendered hint line above controls — fixed height prevents layout shift */
.mode-hint{
  display:flex;align-items:center;gap:5px;
  height:14px;margin:0 0 3px;padding:0 4px;
  font-size:10px;line-height:1.4;
  color:var(--tx3);
  transition:color .2s ease;
}
.hint-dot{
  width:4px;height:4px;border-radius:50%;
  flex-shrink:0;
  transition:background-color .2s ease;
}
.mode-hint.hint-auto .hint-dot{background:var(--gn)}
.mode-hint.hint-manual-armed .hint-dot{background:var(--yw)}
.mode-hint.hint-manual-idle .hint-dot{background:var(--tx3)}
.hint-text{
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  transition:opacity .15s ease;
}
</style>
