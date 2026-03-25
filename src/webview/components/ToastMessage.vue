<template>
  <Teleport to="body">
    <TransitionGroup name="toast" tag="div" class="toast-container">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        :class="t.isError ? 'terr' : 'tok'"
      >
        <svg v-if="!t.isError" class="toast-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
        <svg v-else class="toast-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        {{ t.msg }}
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<script setup>
defineProps({
  toasts: { type: Array, default: () => [] },
})
</script>

<style scoped>
.toast-container{position:fixed;top:10px;left:0;right:0;z-index:99;display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none}
.toast{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:var(--R);font-size:12px;font-weight:500;backdrop-filter:blur(12px);pointer-events:auto;text-align:center;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.2)}
.toast-icon{flex-shrink:0}
.tok{background:rgba(94,218,158,.92);color:#111}
.terr{background:rgba(240,96,96,.92);color:#fff}
.toast-enter-active{animation:toast-in .25s ease}
.toast-leave-active{transition:all .2s ease}
.toast-leave-to{opacity:0;transform:translateY(-4px)}
@keyframes toast-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
</style>
