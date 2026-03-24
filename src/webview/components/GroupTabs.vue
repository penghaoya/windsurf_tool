<template>
  <div class="grp-bar" v-if="groups.length > 0">
    <button
      class="grp-tab"
      :class="{ active: modelValue === '' }"
      @click="$emit('update:modelValue', '')"
    >全部</button>
    <button
      v-for="g in groups"
      :key="g"
      class="grp-tab"
      :class="{ active: modelValue === g }"
      @click="$emit('update:modelValue', g)"
    >
      <span class="grp-dot" :style="{ background: tagColor(g) }"></span>
      {{ g }}
      <span class="grp-cnt">{{ countByGroup(g) }}</span>
    </button>
    <button
      class="grp-tab ungrouped"
      :class="{ active: modelValue === '__none__' }"
      @click="$emit('update:modelValue', '__none__')"
      v-if="hasUngrouped"
    >未分组</button>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  groups: { type: Array, default: () => [] },
  accounts: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' },
})

defineEmits(['update:modelValue'])

const hasUngrouped = computed(() =>
  props.accounts.some(a => !a.group)
)

function countByGroup(g) {
  return props.accounts.filter(a => a.group === g).length
}

const COLORS = [
  '#5edaa0', '#60a5fa', '#f59e0b', '#ef4444', '#a78bfa',
  '#f472b6', '#34d399', '#fb923c', '#38bdf8', '#c084fc',
]

function tagColor(g) {
  let hash = 0
  for (let i = 0; i < g.length; i++) hash = ((hash << 5) - hash) + g.charCodeAt(i)
  return COLORS[Math.abs(hash) % COLORS.length]
}
</script>

<style scoped>
.grp-bar{display:flex;gap:4px;flex-wrap:wrap;padding:4px 0;margin-bottom:2px}
.grp-tab{display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border:1px solid var(--bd);border-radius:10px;background:var(--sf);color:var(--tx2);font-size:10px;font-weight:500;cursor:pointer;transition:all .15s;white-space:nowrap;line-height:1.6}
.grp-tab:hover{border-color:var(--bd2);color:var(--tx);background:var(--sf2)}
.grp-tab.active{border-color:var(--ac);color:var(--ac);background:var(--ac-bg)}
.grp-tab.ungrouped{font-style:italic;color:var(--tx3)}
.grp-tab.ungrouped.active{color:var(--ac);font-style:normal}
.grp-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.grp-cnt{font-size:9px;color:var(--tx3);margin-left:1px}
.grp-tab.active .grp-cnt{color:var(--ac)}
</style>
