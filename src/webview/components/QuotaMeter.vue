<template>
  <div class="am">
    <span class="am-l">{{ label }}</span>
    <div class="am-track">
      <div class="am-fill" :style="{ width: fillWidth, background: color }"></div>
    </div>
    <span class="am-v" :style="{ color }">{{ displayVal }}</span>
    <span v-if="resetStr" class="am-r">{{ resetStr }}</span>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { meterColor, fmtReset } from '../utils/format.js'

const props = defineProps({
  label: { type: String, required: true },
  pct: { type: Number, default: null },
  resetTime: { type: Number, default: null },
  resetCountdown: { type: String, default: null },
})

const clampedPct = computed(() =>
  props.pct !== null && props.pct !== undefined ? Math.min(100, props.pct) : null
)
const color = computed(() => meterColor(clampedPct.value))
const fillWidth = computed(() => `${clampedPct.value ?? 0}%`)
const displayVal = computed(() =>
  clampedPct.value !== null ? Math.round(clampedPct.value) + '%' : '--'
)
const resetStr = computed(() =>
  fmtReset(props.resetTime) || props.resetCountdown || null
)
</script>

<style scoped>
.am{display:flex;align-items:center;gap:4px;flex:1;min-width:0}
.am-l{font-size:11px;color:var(--tx2);font-weight:600;width:13px;flex-shrink:0}
.am-track{flex:1;height:5px;border-radius:2.5px;background:var(--bg);overflow:hidden}
.am-fill{height:100%;border-radius:2.5px}
.am-v{font-size:11px;font-weight:700;min-width:28px;text-align:right}
.am-r{font-size:10px;color:var(--tx3);min-width:50px;text-align:right;flex-shrink:0}
</style>
