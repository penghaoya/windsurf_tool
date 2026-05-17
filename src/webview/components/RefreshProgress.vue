<template>
  <transition name="rp-fade">
    <div v-if="visible" class="rp" :class="{ done: isDone }">
      <div class="rp-bar">
        <div class="rp-fill" :style="{ width: pct + '%' }"></div>
      </div>
      <div class="rp-row">
        <span class="rp-icon">
          <svg v-if="!isDone" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="rp-spin">
            <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
          </svg>
          <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </span>
        <span class="rp-text">
          <strong>{{ isDone ? '刷新完成' : '刷新号池' }}</strong>
          <span class="rp-count">{{ progress.done }}/{{ progress.total }}</span>
          <span v-if="progress.ok > 0" class="rp-ok">✓{{ progress.ok }}</span>
          <span v-if="progress.fail > 0" class="rp-fail">✗{{ progress.fail }}</span>
          <span v-if="!isDone && activeEmailShort" class="rp-active">· {{ activeEmailShort }}</span>
        </span>
        <span class="rp-pct">{{ pct }}%</span>
      </div>
    </div>
  </transition>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  progress: { type: Object, default: null },
})

const isRunning = computed(() => props.progress?.phase === 'running')
const isDone = computed(() => props.progress?.phase === 'done')
// why: hide after 'done' has been seen for ~2.5s; reactive on updatedAt
const visible = computed(() => {
  if (!props.progress) return false
  if (isRunning.value) return true
  if (isDone.value) {
    const ts = props.progress.updatedAt || 0
    return Date.now() - ts < 2500
  }
  return false
})

const pct = computed(() => {
  const t = props.progress?.total || 0
  const d = props.progress?.done || 0
  if (!t) return 0
  return Math.min(100, Math.round((d / t) * 100))
})

const activeEmailShort = computed(() => {
  const e = props.progress?.activeEmail
  if (!e) return ''
  return e.split('@')[0]
})
</script>

<style scoped>
.rp{
  position:relative;
  background:var(--sf2);
  border:1px solid var(--bd);
  border-radius:var(--R);
  padding:5px 8px 4px;
  margin-bottom:4px;
  overflow:hidden;
  transition:border-color .2s ease,background-color .2s ease;
}
.rp.done{border-color:color-mix(in srgb, var(--gn) 50%, var(--bd))}
.rp-bar{
  position:absolute;left:0;right:0;bottom:0;
  height:2px;background:transparent;
}
.rp-fill{
  height:100%;background:var(--ac);
  transition:width .25s ease;
}
.rp.done .rp-fill{background:var(--gn)}
.rp-row{display:flex;align-items:center;gap:6px;font-size:11px;line-height:1.3}
.rp-icon{display:inline-flex;align-items:center;color:var(--ac);flex-shrink:0}
.rp.done .rp-icon{color:var(--gn)}
.rp-spin{animation:rp-spin 1s linear infinite}
@keyframes rp-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.rp-text{display:inline-flex;align-items:center;gap:6px;flex:1;min-width:0;color:var(--tx2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rp-text strong{color:var(--tx);font-weight:600}
.rp-count{color:var(--tx);font-weight:600;font-feature-settings:"tnum"}
.rp-ok{color:var(--gn);font-weight:600}
.rp-fail{color:var(--rd);font-weight:600}
.rp-active{color:var(--tx3);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;min-width:0}
.rp-pct{color:var(--ac);font-weight:600;font-size:10.5px;font-feature-settings:"tnum";flex-shrink:0}
.rp.done .rp-pct{color:var(--gn)}

.rp-fade-enter-active,.rp-fade-leave-active{transition:opacity .2s ease,transform .2s ease}
.rp-fade-enter-from,.rp-fade-leave-to{opacity:0;transform:translateY(-4px)}
</style>
