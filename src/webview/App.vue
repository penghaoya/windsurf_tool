<template>
  <div class="app-root" :class="{ loading: isLoading }">
    <div class="app-fixed">
      <PoolOverview
        :accounts="state.accounts"
        :currentIndex="state.currentIndex"
        :pool="state.pool"
        :activeQuota="state.activeQuota"
        :threshold="state.threshold"
      />
      <Toolbar />
      <AddAccount />
      <div class="list-toggle" @click="listExpanded = !listExpanded">
        <span class="list-toggle-arr" :style="{ transform: listExpanded ? 'rotate(90deg)' : '' }">▶</span>
        <span>{{ state.accounts.length }} 个账号</span>
      </div>
    </div>
    <div class="app-scroll">
      <AccountList
        :accounts="state.accounts"
        :currentIndex="state.currentIndex"
        :threshold="state.threshold"
        :expanded="listExpanded"
      />
    </div>
  </div>
  <ToastMessage :toasts="toasts" />
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { state, toasts, isLoading, initMessageListener } from './composables/useVscode.js'
import PoolOverview from './components/PoolOverview.vue'
import Toolbar from './components/Toolbar.vue'
import AddAccount from './components/AddAccount.vue'
import AccountList from './components/AccountList.vue'
import ToastMessage from './components/ToastMessage.vue'

const listExpanded = ref(true)

onMounted(() => {
  initMessageListener()
})
</script>

<style>
.app-root{display:flex;flex-direction:column;height:100vh;overflow:hidden}
.app-fixed{flex-shrink:0;padding:10px 10px 0}
.app-scroll{flex:1;overflow-y:auto;min-height:0;padding:0 10px 10px}
.list-toggle{cursor:pointer;font-size:11px;color:var(--tx2);padding:6px 2px;display:flex;align-items:center;gap:6px;user-select:none;font-weight:500;transition:color .15s}
.list-toggle:hover{color:var(--tx)}
.list-toggle-arr{transition:transform .2s ease;font-size:8px;color:var(--tx3)}
.loading { opacity: .35; pointer-events: none; transition: opacity .2s }
</style>
