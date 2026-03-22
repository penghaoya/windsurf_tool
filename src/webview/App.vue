<template>
  <div :class="{ loading: isLoading }">
    <PoolOverview
      :accounts="state.accounts"
      :currentIndex="state.currentIndex"
      :pool="state.pool"
      :activeQuota="state.activeQuota"
      :threshold="state.threshold"
    />
    <Toolbar />
    <AddAccount />
    <AccountList
      :accounts="state.accounts"
      :currentIndex="state.currentIndex"
      :threshold="state.threshold"
    />
  </div>
  <ToastMessage :toasts="toasts" />
</template>

<script setup>
import { onMounted } from 'vue'
import { state, toasts, isLoading, initMessageListener } from './composables/useVscode.js'
import PoolOverview from './components/PoolOverview.vue'
import Toolbar from './components/Toolbar.vue'
import AddAccount from './components/AddAccount.vue'
import AccountList from './components/AccountList.vue'
import ToastMessage from './components/ToastMessage.vue'

onMounted(() => {
  initMessageListener()
})
</script>

<style>
.loading { opacity: .35; pointer-events: none; transition: opacity .2s }
</style>
