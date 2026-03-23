<template>
  <Teleport to="body">
    <TransitionGroup name="toast" tag="div" class="toast-container">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        :class="t.isError ? 'terr' : 'tok'"
      >
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
.toast-container{position:fixed;top:10px;left:0;right:0;z-index:99;display:flex;flex-direction:column;align-items:center;gap:4px;pointer-events:none}
.toast{display:inline-flex;padding:6px 18px;border-radius:var(--R);font-size:11px;font-weight:500;backdrop-filter:blur(8px);pointer-events:auto;text-align:center;white-space:nowrap}
.tok{background:rgba(94,218,158,.9);color:#111}
.terr{background:rgba(240,96,96,.9);color:#fff}
.toast-enter-active{animation:toast-in .25s ease}
.toast-leave-active{transition:all .2s ease}
.toast-leave-to{opacity:0;transform:translateY(-4px)}
@keyframes toast-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
</style>
