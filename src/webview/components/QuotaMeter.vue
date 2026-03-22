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
  clampedPct.value !== null ? clampedPct.value.toFixed(1) + '%' : '--'
)
const resetStr = computed(() =>
  fmtReset(props.resetTime) || props.resetCountdown || null
)
</script>

<style scoped>
.am{display:flex;align-items:center;gap:4px}
.am-l{font-size:9px;color:var(--tx2);font-weight:600;width:12px;flex-shrink:0}
.am-track{flex:1;height:5px;border-radius:2.5px;background:var(--bg);overflow:hidden}
.am-fill{height:100%;border-radius:2.5px;transition:width .4s ease}
.am-v{font-size:9px;font-weight:700;min-width:30px;text-align:right}
.am-r{font-size:8px;color:var(--tx3);min-width:50px;text-align:right;flex-shrink:0}
</style>
