<template>
  <div v-if="!embedded" class="mode-hint" :class="hintClass">
    <span class="hint-dot"></span>
    <span class="hint-text">{{ hintText }}</span>
  </div>
  <div class="mode-bar" :class="{ embedded }">
    <!-- Row 1: 自动/手动 + 安全网/预防 -->
    <div class="mode-row">
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

    <!-- Row 2 (embedded): hint 左侧 + 新指纹 右侧 -->
    <div v-if="embedded" class="mode-row mode-row-2">
      <div class="mode-hint inline" :class="hintClass">
        <span class="hint-dot"></span>
        <span class="hint-text">{{ hintText }}</span>
      </div>
      <span class="mode-spacer"></span>
      <button
        type="button"
        class="fp-toggle"
        :class="{ active: alwaysFreshFingerprint }"
        role="switch"
        :aria-checked="alwaysFreshFingerprint"
        :title="alwaysFreshFingerprint ? '每次切号强制重新生成指纹 (推荐)' : '使用账号绑定的指纹 (Per-Account 缓存)'"
        @click="toggleFreshFp"
      >
        <svg v-if="alwaysFreshFingerprint" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
        <svg v-else width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>
        新指纹
      </button>
    </div>

    <!-- non-embedded: 新指纹 inline 在 row 1 后 (legacy 单行布局) -->
    <button
      v-if="!embedded"
      type="button"
      class="fp-toggle fp-inline"
      :class="{ active: alwaysFreshFingerprint }"
      role="switch"
      :aria-checked="alwaysFreshFingerprint"
      :title="alwaysFreshFingerprint ? '每次切号强制重新生成指纹 (推荐)' : '使用账号绑定的指纹 (Per-Account 缓存)'"
      @click="toggleFreshFp"
    >
      <svg v-if="alwaysFreshFingerprint" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
      <svg v-else width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>
      新指纹
    </button>
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
  alwaysFreshFingerprint: { type: Boolean, default: true },
  embedded: { type: Boolean, default: false },
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

function toggleFreshFp() {
  postMessage(ACTION.SET_ALWAYS_FRESH_FP, { value: !props.alwaysFreshFingerprint })
}
</script>

<style scoped>
/* v23.x: two-row layout — row 1 = [seg | field], row 2 (embedded) = [hint | fp-toggle] */
.mode-bar{
  display:flex;flex-direction:column;gap:4px;
  margin-bottom:3px;
}
.mode-row{display:flex;align-items:center;gap:4px;min-width:0}
.mode-spacer{flex:1}
/* Embedded inside ActiveAccountCard — strip outer margin/padding */
.mode-bar.embedded{margin-bottom:0;padding:0}
/* non-embedded: keep legacy single-line — fp-toggle inline after row 1 */
.mode-bar:not(.embedded){flex-direction:row;align-items:center}
.mode-bar:not(.embedded) .mode-row{flex:1}
.fp-inline{margin-left:4px}

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

.fp-toggle{
  display:inline-flex;align-items:center;gap:4px;
  height:24px;padding:0 8px;
  border:1px solid var(--bd);border-radius:var(--R3);
  background:var(--btn-bg);color:var(--tx2);
  font-size:10px;font-weight:500;line-height:1;letter-spacing:.2px;
  cursor:pointer;white-space:nowrap;
  transition:background .15s ease,color .15s ease,border-color .15s ease;
}
.fp-toggle:hover{background:var(--btn-hover);color:var(--tx)}
.fp-toggle.active{background:var(--ac-bg);color:var(--ac);border-color:var(--ac);font-weight:600}
.fp-toggle svg{flex-shrink:0;opacity:.7}
.fp-toggle.active svg{opacity:1}

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
.mode-hint.embedded{padding:0;margin:0}
.mode-hint.embedded.below{margin-top:4px}
/* v23.x: inline hint — shares row 2 with fp-toggle */
.mode-hint.inline{
  height:auto;margin:0;padding:0 2px;
  flex:1;min-width:0;
  font-size:10.5px;
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
