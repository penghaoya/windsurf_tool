<template>
  <div class="af">
    <!-- Row 1: Status chips + Sort dropdown + Search toggle -->
    <div class="af-row">
      <div class="af-chips">
        <button
          v-for="opt in STATUS_OPTIONS"
          :key="opt.value"
          class="af-chip"
          :class="{ on: viewState.statusFilter === opt.value }"
          @click="viewState.statusFilter = opt.value"
        >{{ opt.label }}</button>
      </div>
      <span class="af-sep"></span>
      <button
        class="af-icon"
        :class="{ on: searchOpen || viewState.searchText }"
        @click="toggleSearch"
        title="搜索邮箱"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      </button>
      <div class="af-sort">
        <select v-model="viewState.sortBy" class="af-sort-sel" :class="{ on: viewState.sortBy !== 'default' }">
          <option v-for="opt in SORT_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </div>
      <button
        v-if="hasFilters"
        class="af-icon af-reset"
        @click="resetView"
        title="重置筛选"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>

    <!-- Row 2: Tier chips (only tiers present in pool) -->
    <div v-if="visibleTiers.length > 1" class="af-row af-tier">
      <button
        v-for="opt in visibleTiers"
        :key="opt.value"
        class="af-chip sm"
        :class="{ on: viewState.tierFilter === opt.value }"
        @click="viewState.tierFilter = opt.value"
      >
        {{ opt.label }}
        <span v-if="opt.value !== 'all'" class="af-badge">{{ tierCounts[opt.value] || 0 }}</span>
      </button>
    </div>

    <!-- Row 3: Search input (collapsible) -->
    <transition name="af-slide">
      <div v-if="searchOpen" class="af-search">
        <input
          ref="searchInput"
          v-model="viewState.searchText"
          type="search"
          placeholder="搜索邮箱前缀…"
          @keydown.esc="closeSearch"
        />
        <button v-if="viewState.searchText" class="af-clear" @click="viewState.searchText = ''" title="清空">✕</button>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed, nextTick } from 'vue'
import {
  viewState, resetView,
  SORT_OPTIONS, STATUS_OPTIONS, TIER_OPTIONS,
} from '../composables/useAccountView.js'

const props = defineProps({
  tierCounts: { type: Object, default: () => ({}) },
  hasFilters: { type: Boolean, default: false },
})

const searchOpen = ref(!!viewState.searchText)
const searchInput = ref(null)

async function toggleSearch() {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value) {
    await nextTick()
    searchInput.value?.focus()
  } else {
    viewState.searchText = ''
  }
}
function closeSearch() {
  searchOpen.value = false
  viewState.searchText = ''
}

// Only show tier chips for tiers that actually exist in pool (+ 'all')
const visibleTiers = computed(() => {
  const counts = props.tierCounts || {}
  return TIER_OPTIONS.filter(
    (opt) => opt.value === 'all' || (counts[opt.value] || 0) > 0,
  )
})
</script>

<style scoped>
.af{display:flex;flex-direction:column;gap:3px;margin:2px 0 4px}
.af-row{display:flex;align-items:center;gap:4px;min-height:22px}
.af-chips{display:flex;gap:3px;flex-wrap:wrap;min-width:0}
.af-chip{
  font-size:10.5px;font-weight:500;line-height:1.4;padding:2px 8px;
  background:transparent;border:1px solid transparent;color:var(--tx3);
  border-radius:10px;cursor:pointer;white-space:nowrap;
  transition:background-color .1s,color .1s,border-color .1s;
}
.af-chip:hover{color:var(--tx2);background:var(--bg2)}
.af-chip.on{color:var(--ac);background:var(--ac-bg);font-weight:600}
.af-chip.sm{padding:1px 7px;font-size:10px}
.af-badge{
  display:inline-block;margin-left:4px;padding:0 4px;
  font-size:9px;font-weight:700;border-radius:6px;
  background:color-mix(in srgb,currentColor 18%,transparent);
  line-height:1.4;vertical-align:baseline;
}
.af-sep{flex:1}
.af-icon{
  width:22px;height:22px;display:flex;align-items:center;justify-content:center;
  border:none;background:transparent;color:var(--tx3);cursor:pointer;border-radius:var(--R3);
  transition:background-color .1s,color .1s;flex-shrink:0;
}
.af-icon:hover{background:var(--bg2);color:var(--tx)}
.af-icon.on{color:var(--ac);background:var(--ac-bg)}
.af-reset{color:var(--tx3)}
.af-reset:hover{color:var(--rd);background:var(--rd-bg)}
.af-sort-sel{
  font-size:10.5px;font-weight:500;height:22px;padding:0 4px;
  background:var(--bg2);border:1px solid transparent;color:var(--tx2);
  border-radius:var(--R3);cursor:pointer;outline:none;
  transition:border-color .1s,color .1s;flex-shrink:0;max-width:110px;
}
.af-sort-sel:hover{color:var(--tx);border-color:var(--bd)}
.af-sort-sel.on{color:var(--ac);border-color:color-mix(in srgb,var(--ac) 40%,transparent)}
.af-search{display:flex;align-items:center;gap:4px;padding:2px 0}
.af-search input{
  flex:1;font-size:11px;height:22px;padding:0 8px;
  background:var(--bg2);border:1px solid var(--bd);color:var(--tx);
  border-radius:var(--R3);outline:none;
  transition:border-color .1s;
}
.af-search input:focus{border-color:var(--ac)}
.af-search input::placeholder{color:var(--tx3)}
.af-clear{
  width:20px;height:20px;border:none;background:transparent;color:var(--tx3);
  cursor:pointer;border-radius:var(--R3);font-size:11px;
}
.af-clear:hover{color:var(--rd);background:var(--rd-bg)}
.af-tier{padding-left:1px}
.af-slide-enter-active,.af-slide-leave-active{transition:opacity .15s,max-height .2s ease;overflow:hidden}
.af-slide-enter-from,.af-slide-leave-to{opacity:0;max-height:0}
.af-slide-enter-to,.af-slide-leave-from{opacity:1;max-height:32px}
</style>
