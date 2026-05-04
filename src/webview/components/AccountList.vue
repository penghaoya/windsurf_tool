<template>
  <div class="sect">
    <div class="sbox" :class="{ open: expanded }">
      <div id="list">
        <div v-if="accountItems.length > 0" class="virtual-list" :style="{ height: `${virtualWindow.totalHeight}px` }">
          <div class="virtual-offset" :style="{ transform: `translateY(${virtualWindow.offsetTop}px)` }">
            <div
              v-for="{ account, index } in visibleAccounts"
              :key="account.email || index"
              class="virtual-row"
              :data-row-key="rowKey(account, index)"
              :ref="(el) => setRowRef(el, rowKey(account, index))"
            >
              <AccountCard
                :account="account"
                :index="index"
                :isCurrent="index === currentIndex"
                :threshold="threshold"
                :switchStatus="switchStatus"
              />
            </div>
          </div>
        </div>
        <div v-else-if="hasFilters && totalCount > 0" class="empty">
          <svg class="empty-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          没有匹配筛选条件的账号<br>
          <button class="empty-reset" @click="resetView">重置筛选</button>
        </div>
        <div v-else class="empty">
          <div class="empty-icon"></div>
          号池为空<br>
          <span style="color:var(--ac)">粘贴账号到上方输入框开始使用</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, shallowRef, triggerRef, watch } from 'vue'
import AccountCard from './AccountCard.vue'
import { resetView } from '../composables/useAccountView.js'

const emit = defineEmits(['scrollAdjust'])

const ITEM_HEIGHT = 118
const OVERSCAN = 12
const HEIGHT_EPSILON = 2
const SCROLL_SETTLE_MS = 120

const props = defineProps({
  accounts: { type: Array, default: () => [] },
  currentIndex: { type: Number, default: -1 },
  threshold: { type: Number, default: 5 },
  expanded: { type: Boolean, default: true },
  switchStatus: { type: Object, default: null },
  scrollTop: { type: Number, default: 0 },
  viewportHeight: { type: Number, default: 0 },
  totalCount: { type: Number, default: 0 },
  hasFilters: { type: Boolean, default: false },
})

const rowRefs = new Map()
// Use shallowRef + triggerRef to avoid O(N) Map cloning on every height flush.
const rowHeights = shallowRef(new Map())
let rowResizeObserver = null
let pendingHeightUpdates = null
let heightUpdateRaf = null
let scrolling = false
let scrollSettleTimer = null

const accountItems = computed(() =>
  props.accounts
    .map((account, i) => ({ account, index: Number.isInteger(account.index) ? account.index : i }))
)

function rowKey(account, index) {
  return account.email || `index:${index}`
}

function getRowHeight(item) {
  return rowHeights.value.get(rowKey(item.account, item.index)) || ITEM_HEIGHT
}

const heightOffsets = computed(() => {
  const offsets = [0]
  let total = 0
  for (const item of accountItems.value) {
    total += getRowHeight(item)
    offsets.push(total)
  }
  return offsets
})

function findStartIndex(offsets, scrollTop) {
  let lo = 0
  let hi = Math.max(0, offsets.length - 2)
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (offsets[mid + 1] <= scrollTop) lo = mid + 1
    else hi = mid - 1
  }
  return Math.max(0, Math.min(lo, offsets.length - 2))
}

const virtualWindow = computed(() => {
  const total = accountItems.value.length
  if (total === 0) return { start: 0, end: -1, offsetTop: 0, totalHeight: 0 }

  const offsets = heightOffsets.value
  const localScrollTop = Math.max(0, props.scrollTop)
  const viewportBottom = localScrollTop + (props.viewportHeight || ITEM_HEIGHT * 6)
  const start = Math.max(0, findStartIndex(offsets, localScrollTop) - OVERSCAN)
  let end = start
  while (end < total - 1 && offsets[end] < viewportBottom) end++
  end = Math.min(total - 1, end + OVERSCAN)

  return {
    start,
    end,
    offsetTop: offsets[start] || 0,
    totalHeight: offsets[offsets.length - 1] || 0,
  }
})

const visibleAccounts = computed(() =>
  accountItems.value.slice(virtualWindow.value.start, virtualWindow.value.end + 1)
)

function scheduleHeightUpdate(key, height) {
  if (!key || !height) return
  const nextHeight = Math.ceil(height)
  // Suppress sub-pixel jitter to avoid mount/measure storm on scroll.
  const prev = rowHeights.value.get(key)
  if (prev !== undefined && Math.abs(prev - nextHeight) <= HEIGHT_EPSILON) return
  if (!pendingHeightUpdates) pendingHeightUpdates = new Map()
  pendingHeightUpdates.set(key, nextHeight)
  // Defer flush while actively scrolling — prevents feedback loop:
  // scroll → mount row → ResizeObserver → triggerRef → recompute offsets → re-render → mount row ...
  if (scrolling) return
  if (!heightUpdateRaf) {
    heightUpdateRaf = requestAnimationFrame(flushHeightUpdates)
  }
}

function flushHeightUpdates() {
  heightUpdateRaf = null
  if (!pendingHeightUpdates) return
  const batch = pendingHeightUpdates
  pendingHeightUpdates = null

  // Anchor on first visible row so we can compensate scroll after height changes
  const anchorIdx = virtualWindow.value.start
  const preAnchorOffset = heightOffsets.value[anchorIdx] || 0

  const map = rowHeights.value
  let changed = false
  for (const [k, h] of batch) {
    const prev = map.get(k)
    if (prev === undefined || Math.abs(prev - h) > HEIGHT_EPSILON) {
      map.set(k, h)
      changed = true
    }
  }
  if (changed) {
    triggerRef(rowHeights)
    // Computed refs re-evaluate synchronously on next access — check if
    // heights above the anchor shifted and compensate scroll to prevent jump
    const postAnchorOffset = heightOffsets.value[anchorIdx] || 0
    const delta = postAnchorOffset - preAnchorOffset
    if (delta !== 0) emit('scrollAdjust', delta)
  }
}

function setRowRef(el, key) {
  if (!key || !rowResizeObserver) return
  const previous = rowRefs.get(key)
  if (previous && previous !== el) rowResizeObserver.unobserve(previous)
  if (!el) {
    if (previous) rowResizeObserver.unobserve(previous)
    rowRefs.delete(key)
    return
  }
  rowRefs.set(key, el)
  rowResizeObserver.observe(el)
  scheduleHeightUpdate(key, el.offsetHeight)
}

// Expose scroll state so parent can notify us
function onScrollStateChange(isScrolling) {
  scrolling = isScrolling
  if (scrollSettleTimer) clearTimeout(scrollSettleTimer)
  if (isScrolling) return
  // Scroll settled — flush any deferred height updates
  scrollSettleTimer = setTimeout(() => {
    if (pendingHeightUpdates && !heightUpdateRaf) {
      heightUpdateRaf = requestAnimationFrame(flushHeightUpdates)
    }
  }, 16)
}

defineExpose({ onScrollStateChange })

onMounted(() => {
  rowResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      scheduleHeightUpdate(entry.target.dataset.rowKey, entry.target.offsetHeight)
    }
  })
})

watch(accountItems, () => {
  const allowed = new Set(accountItems.value.map((item) => rowKey(item.account, item.index)))
  const map = rowHeights.value
  let changed = false
  for (const key of map.keys()) {
    if (!allowed.has(key)) { map.delete(key); changed = true }
  }
  if (changed) triggerRef(rowHeights)
})

onBeforeUnmount(() => {
  rowResizeObserver?.disconnect()
  if (heightUpdateRaf) cancelAnimationFrame(heightUpdateRaf)
  if (scrollSettleTimer) clearTimeout(scrollSettleTimer)
})
</script>

<style scoped>
.sect{margin-top:0}
.sbox{max-height:0;overflow:hidden;transition:max-height .3s ease,opacity .25s ease;opacity:0;padding:0}
.sbox.open{max-height:9999px;opacity:1;padding:2px 0}
.virtual-list{position:relative;width:100%}
.virtual-offset{position:absolute;left:0;right:0;top:0;will-change:transform}
.virtual-row{width:100%;padding-bottom:3px;contain:layout style paint}
.empty{text-align:center;padding:32px 16px;color:var(--tx3);font-size:13px;line-height:2}
.empty svg.empty-icon{display:block;margin:0 auto 8px;opacity:.5}
.empty-reset{margin-top:6px;font-size:11px;padding:3px 12px;background:var(--ac-bg);border:none;color:var(--ac);border-radius:var(--R3);cursor:pointer;transition:background-color .12s}
.empty-reset:hover{background:color-mix(in srgb,var(--ac) 18%,transparent)}
</style>
