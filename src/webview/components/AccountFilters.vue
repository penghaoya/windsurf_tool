<template>
  <div class="af">
    <!-- Row 1: inline search box + sort dropdown -->
    <div class="af-row">
      <div class="af-search" :class="{ on: !!viewState.searchText }">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="af-si">
          <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          v-model="viewState.searchText"
          type="search"
          placeholder="搜索邮箱"
          @keydown.esc="viewState.searchText = ''"
        />
        <button
          v-if="viewState.searchText"
          class="af-x"
          @click="viewState.searchText = ''"
          title="清空"
          tabindex="-1"
        >✕</button>
      </div>

      <div class="af-select" :class="{ on: viewState.sortBy !== 'default' }">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="af-si">
          <path d="M3 6h18M6 12h12M10 18h4"/>
        </svg>
        <select v-model="viewState.sortBy" class="af-sel">
          <option v-for="opt in SORT_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </div>
    </div>

    <!-- Row 2: status chips -->
    <div class="af-row af-chips">
      <button
        v-for="opt in STATUS_OPTIONS"
        :key="opt.value"
        class="af-chip"
        :class="{ on: viewState.statusFilter === opt.value }"
        :title="opt.tooltip || opt.label"
        @click="viewState.statusFilter = opt.value"
      >
        <span class="af-chip-label">{{ opt.label }}</span>
        <span v-if="opt.sub" class="af-chip-sub">({{ opt.sub }})</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import {
  viewState,
  SORT_OPTIONS, STATUS_OPTIONS,
} from '../composables/useAccountView.js'

defineProps({
  hasFilters: { type: Boolean, default: false },
})
</script>

<style scoped>
.af{margin:2px 0 4px;display:flex;flex-direction:column;gap:3px}
.af-row{display:flex;align-items:center;gap:4px;min-height:22px}

/* Inline search — chip-style container with embedded input */
.af-search{
  flex:1;min-width:0;display:inline-flex;align-items:center;gap:5px;
  height:22px;padding:0 6px;
  background:color-mix(in srgb,var(--tx) 8%,transparent);
  border-radius:4px;color:var(--tx3);
  transition:background-color .1s,color .1s;
}
.af-search:hover,.af-search:focus-within{color:var(--tx);background:color-mix(in srgb,var(--tx) 12%,transparent)}
.af-search.on{color:var(--ac);background:var(--ac-bg)}
.af-search .af-si{flex-shrink:0;opacity:.85}
.af-search input{
  flex:1;min-width:0;font:inherit;font-size:10.5px;font-weight:500;
  background:transparent;border:0;outline:none;color:var(--tx);
  padding:0;height:22px;letter-spacing:.1px;
}
.af-search input::placeholder{color:var(--tx3)}
/* Hide native search clear (we provide our own ✕) */
.af-search input::-webkit-search-cancel-button{display:none}
.af-x{
  width:14px;height:14px;border:0;background:transparent;color:var(--tx3);
  cursor:pointer;font-size:10px;line-height:1;flex-shrink:0;border-radius:7px;
  display:flex;align-items:center;justify-content:center;
}
.af-x:hover{color:var(--rd);background:var(--rd-bg)}

/* Sort: select-as-chip, same aesthetic as search */
.af-select{
  display:inline-flex;align-items:center;gap:3px;
  height:22px;padding:0 4px 0 6px;
  background:color-mix(in srgb,var(--tx) 8%,transparent);
  border-radius:4px;color:var(--tx2);flex-shrink:0;
  transition:background-color .1s,color .1s;
}
.af-select:hover{color:var(--tx);background:color-mix(in srgb,var(--tx) 12%,transparent)}
.af-select.on{color:var(--ac);background:var(--ac-bg)}
.af-select .af-si{opacity:.85;flex-shrink:0}
.af-sel{
  appearance:none;-webkit-appearance:none;-moz-appearance:none;
  font:inherit;font-size:10.5px;font-weight:500;
  background:transparent;border:0;color:inherit;
  padding:0 14px 0 2px;height:22px;cursor:pointer;outline:none;
  max-width:90px;letter-spacing:.1px;
  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 7px) 10px,calc(100% - 4px) 10px;
  background-size:3px 3px,3px 3px;background-repeat:no-repeat;
}
.af-sel option{background:var(--sf);color:var(--tx)}

/* Status chips */
.af-chips{flex-wrap:wrap;gap:3px}
.af-chip{
  font-size:10.5px;font-weight:500;line-height:1.4;padding:2px 10px;
  background:transparent;border:0;color:var(--tx3);
  border-radius:10px;cursor:pointer;white-space:nowrap;
  transition:background-color .1s,color .1s;
  display:inline-flex;align-items:baseline;gap:3px;
}
.af-chip:hover{color:var(--tx2);background:var(--bg2)}
.af-chip.on{color:var(--ac);background:var(--ac-bg);font-weight:600}
.af-chip-label{display:inline-block}
.af-chip-sub{font-size:9.5px;font-weight:400;opacity:.62;letter-spacing:.1px}
.af-chip.on .af-chip-sub{opacity:.78}
</style>
