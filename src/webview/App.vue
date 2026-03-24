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
      <GroupTabs
        :groups="state.groups"
        :accounts="state.accounts"
        v-model="selectedGroup"
      />
    </div>
    <div class="app-scroll">
      <AccountList
        :accounts="state.accounts"
        :currentIndex="state.currentIndex"
        :threshold="state.threshold"
        :selectedGroup="selectedGroup"
        :groups="state.groups"
      />
    </div>
  </div>
  <ToastMessage :toasts="toasts" />
</template>

<script setup>
import { onMounted } from 'vue'
import { state, toasts, isLoading, selectedGroup, initMessageListener } from './composables/useVscode.js'
import PoolOverview from './components/PoolOverview.vue'
import Toolbar from './components/Toolbar.vue'
import AddAccount from './components/AddAccount.vue'
import GroupTabs from './components/GroupTabs.vue'
import AccountList from './components/AccountList.vue'
import ToastMessage from './components/ToastMessage.vue'

onMounted(() => {
  initMessageListener()
})
</script>

<style>
.app-root{display:flex;flex-direction:column;height:100vh;overflow:hidden}
.app-fixed{flex-shrink:0;padding:8px 8px 0}
.app-scroll{flex:1;overflow-y:auto;min-height:0;padding:0 8px 8px}
.loading { opacity: .35; pointer-events: none; transition: opacity .2s }
</style>
