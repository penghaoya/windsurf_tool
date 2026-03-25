<template>
  <div class="toolbar">
    <button class="tb primary" @click="postMessage('refreshAllAndRotate')" title="刷新号池">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0115.36-6.36L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 01-15.36 6.36L3 16"/></svg>
      刷新
    </button>
    <span class="spacer"></span>
    <button class="tb tb-icon" @click="postMessage('exportAccounts')" title="导出">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
    </button>
    <button class="tb tb-icon" @click="postMessage('importAccounts')" title="导入">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
  </div>
</template>

<script setup>
import { postMessage } from '../composables/useVscode.js'
</script>

<style scoped>
.toolbar{display:flex;gap:4px;margin-bottom:6px;align-items:center}
.toolbar .spacer{flex:1}
.tb{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:5px 10px;border:1px solid var(--bd);background:var(--btn-bg);color:var(--btn-fg);border-radius:var(--R3);cursor:pointer;font-size:11px;font-weight:500;transition:all .15s ease;white-space:nowrap}
.tb:hover{background:var(--btn-hover);border-color:var(--bd2);color:var(--tx)}
.tb:active{transform:scale(.97)}
.tb.primary{background:transparent;border-color:var(--ac);color:var(--ac)}
.tb.primary:hover{background:var(--ac-bg);border-color:var(--ac);color:var(--ac)}
.tb svg{flex-shrink:0}
.tb-icon{padding:5px 6px}
</style>
