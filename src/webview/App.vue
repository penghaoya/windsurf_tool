<template>
  <div class="app-root" :class="{ loading: isLoading }">
    <div class="app-fixed">
      <PoolOverview
        :accounts="state.accounts"
        :currentIndex="state.currentIndex"
        :pool="state.pool"
        :activeQuota="state.activeQuota"
        :threshold="state.threshold"
        :lastDecision="state.lastDecision"
      />
      <ActiveAccountCard
        :accounts="state.accounts"
        :currentIndex="state.currentIndex"
        :activeQuota="state.activeQuota"
        :switchStatus="state.switchStatus"
        :autoRotate="state.autoRotate"
        :threshold="state.threshold"
        :manualThreshold="state.manualThreshold"
      />
      <QuickActions :addOpen="addOpen" @toggleAdd="addOpen = !addOpen" />
      <transition name="slide">
        <AddAccount v-if="addOpen" />
      </transition>
      <div class="list-toggle" @click="listExpanded = !listExpanded">
        <span class="list-toggle-arr" :style="{ transform: listExpanded ? 'rotate(90deg)' : '' }">▶</span>
        <span v-if="filteredAccounts.length !== state.accounts.length">
          {{ filteredAccounts.length }}/{{ state.accounts.length }} 个账号
        </span>
        <span v-else>{{ state.accounts.length }} 个账号</span>
      </div>
      <AccountFilters
        v-if="listExpanded && state.accounts.length > 0"
        :hasFilters="hasFilters"
      />
    </div>
    <div
      ref="scrollEl"
      class="app-scroll"
      @mouseenter="scrollHover=true"
      @mouseleave="scrollHover=false"
      :class="{scrolling:scrollHover, 'is-scrolling':isScrolling}"
    >
      <AccountList
        ref="accountListRef"
        :accounts="filteredAccounts"
        :currentIndex="state.currentIndex"
        :threshold="state.threshold"
        :expanded="listExpanded"
        :switchStatus="state.switchStatus"
        :scrollTop="scrollTop"
        :viewportHeight="viewportHeight"
        :totalCount="state.accounts.length"
        :hasFilters="hasFilters"
        @scrollAdjust="onScrollAdjust"
      />
    </div>
  </div>
  <ToastMessage :toasts="toasts" />
</template>

<script setup>
import { ref, toRef, onBeforeUnmount, onMounted } from 'vue'
import { state, toasts, isLoading, initMessageListener } from './composables/useVscode.js'
import PoolOverview from './components/PoolOverview.vue'
import ActiveAccountCard from './components/ActiveAccountCard.vue'
import QuickActions from './components/QuickActions.vue'
import AddAccount from './components/AddAccount.vue'
import AccountList from './components/AccountList.vue'
import AccountFilters from './components/AccountFilters.vue'
import ToastMessage from './components/ToastMessage.vue'
import { useAccountView } from './composables/useAccountView.js'

const { filteredAccounts, hasFilters } = useAccountView(toRef(state, 'accounts'))

const listExpanded = ref(true)
const addOpen = ref(false)

const scrollHover = ref(false)
const isScrolling = ref(false)
const scrollEl = ref(null)
const accountListRef = ref(null)
const scrollTop = ref(0)
const viewportHeight = ref(0)
let resizeObserver = null
let scrollSettleTimer = null
const SCROLL_SETTLE_MS = 120

function updateViewport() {
  viewportHeight.value = scrollEl.value?.clientHeight || 0
}

function onScrollAdjust(delta) {
  if (!scrollEl.value || !delta) return
  scrollEl.value.scrollTop += delta
  scrollTop.value = scrollEl.value.scrollTop
}

let scrollRaf = null
function onScroll() {
  // Suppress hover effects during scroll — prevents repaint storms
  if (!isScrolling.value) isScrolling.value = true
  // Notify AccountList that scroll is active — suppress height measurements
  accountListRef.value?.onScrollStateChange(true)
  if (scrollSettleTimer) clearTimeout(scrollSettleTimer)
  scrollSettleTimer = setTimeout(() => {
    isScrolling.value = false
    accountListRef.value?.onScrollStateChange(false)
  }, SCROLL_SETTLE_MS)
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollTop.value = scrollEl.value?.scrollTop || 0
    scrollRaf = null
  })
}

onMounted(() => {
  initMessageListener()
  updateViewport()
  resizeObserver = new ResizeObserver(updateViewport)
  if (scrollEl.value) {
    resizeObserver.observe(scrollEl.value)
    // Use passive listener for better scroll performance (tells browser we won't preventDefault)
    scrollEl.value.addEventListener('scroll', onScroll, { passive: true })
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (scrollSettleTimer) clearTimeout(scrollSettleTimer)
  scrollEl.value?.removeEventListener('scroll', onScroll)
})
</script>

<style>
.app-root{display:flex;flex-direction:column;height:100vh;overflow:hidden}
.app-fixed{flex-shrink:0;padding:6px 8px 0}
.app-scroll{flex:1;overflow-y:auto;min-height:0;padding:0 8px 6px;overscroll-behavior-y:contain;-webkit-overflow-scrolling:touch}
.app-scroll::-webkit-scrollbar-thumb{background:transparent}
.app-scroll.scrolling::-webkit-scrollbar-thumb{background:var(--bd2)}
/* Kill hover effects during scroll — prevents repaint storms from hover transitions.
   pointer-events:none on children (not container) so scroll events still work. */
.app-scroll.is-scrolling *{pointer-events:none !important}
.list-toggle{cursor:pointer;font-size:11px;color:var(--tx2);padding:4px 2px;display:flex;align-items:center;gap:5px;user-select:none;font-weight:500;transition:color .15s}
.list-toggle:hover{color:var(--tx)}
.list-toggle-arr{transition:transform .2s ease;font-size:8px;color:var(--tx3)}
.loading { opacity: .35; pointer-events: none; transition: opacity .2s }
.slide-enter-active,.slide-leave-active{transition:opacity .2s ease,transform .2s ease,max-height .25s ease;overflow:hidden}
.slide-enter-from,.slide-leave-to{opacity:0;transform:translateY(-4px);max-height:0}
.slide-enter-to,.slide-leave-from{opacity:1;transform:translateY(0);max-height:140px}
</style>
