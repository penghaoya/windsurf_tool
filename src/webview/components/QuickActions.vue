<template>
  <div class="qa-bar">
    <button
      class="qa-btn primary"
      :class="{ active: addOpen }"
      @click="$emit('toggleAdd')"
      :title="addOpen ? '收起添加面板' : '展开添加面板'"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      添加账号
    </button>
    <span class="qa-spacer"></span>
    <div class="qa-group">
      <button class="qa-btn icon" @click="postMessage('refreshAllAndRotate')" title="刷新号池">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0115.36-6.36L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 01-15.36 6.36L3 16"/></svg>
      </button>
      <button class="qa-btn icon" @click="postMessage('exportAccounts')" title="导出账号">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      </button>
      <button class="qa-btn icon" @click="postMessage('importAccounts')" title="导入账号">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
      <button class="qa-btn icon" @click="postMessage('showLogs')" title="查看日志">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>
      </button>
    </div>
  </div>
</template>

<script setup>
import { postMessage } from '../composables/useVscode.js'

defineProps({ addOpen: { type: Boolean, default: false } })
defineEmits(['toggleAdd'])
</script>

<style scoped>
.qa-bar{display:flex;gap:4px;align-items:center;margin-bottom:3px}
.qa-spacer{flex:1}
/* Icons visually grouped as a single segmented unit (like Mode seg) */
.qa-group{
  display:inline-flex;gap:0;
  border:1px solid var(--bd);border-radius:var(--R3);
  background:var(--btn-bg);overflow:hidden;height:24px;
}
.qa-group .qa-btn.icon{border:0;border-radius:0;background:transparent}
.qa-group .qa-btn.icon + .qa-btn.icon{border-left:1px solid var(--bd)}

.qa-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:4px;
  height:24px;padding:0 10px;
  background:var(--btn-bg);border:1px solid var(--bd);color:var(--btn-fg);
  border-radius:var(--R3);font-size:11px;font-weight:500;
  cursor:pointer;transition:all .15s ease;line-height:1;white-space:nowrap;
}
.qa-btn:hover{background:var(--btn-hover);border-color:var(--bd2);color:var(--tx)}
.qa-btn:active{transform:scale(.97)}
.qa-btn svg{flex-shrink:0;opacity:.85}
.qa-btn.icon{padding:0;width:26px}
.qa-btn.primary{background:var(--ac-bg);border-color:transparent;color:var(--ac)}
.qa-btn.primary:hover{background:color-mix(in srgb,var(--ac) 18%,transparent);border-color:transparent;color:var(--ac)}
.qa-btn.primary svg{opacity:1}
.qa-btn.primary.active{background:color-mix(in srgb,var(--ac) 22%,transparent);border-color:transparent;color:var(--ac)}
.qa-btn.primary.active svg{transform:rotate(45deg);transition:transform .2s ease}
</style>
