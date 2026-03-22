<template>
  <div class="add-section">
    <div class="addbar">
      <textarea
        ref="inputRef"
        id="bi"
        rows="1"
        placeholder="粘贴账号 (email:password)"
        v-model="inputText"
        @input="onInput"
        @focus="onFocus"
        @blur="onBlur"
      ></textarea>
      <button class="add-btn" @click="doBatch" title="添加">+</button>
    </div>
    <div v-if="previewHtml" id="preview" v-html="previewHtml"></div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { postMessage, previewAccounts } from '../composables/useVscode.js'

const inputText = ref('')
const inputRef = ref(null)
const isFocused = ref(false)

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const previewHtml = computed(() => {
  if (!inputText.value.trim()) return ''
  const accs = previewAccounts.value
  if (accs && accs.length > 0) {
    const items = accs.map(a =>
      `<span class="pe">${esc(a.email.split('@')[0])}</span>:<span class="pp">${esc(a.password.substring(0, 4))}..</span>`
    ).join(' ')
    return `<span class="pf">${accs.length}个</span> ${items}`
  }
  if (inputText.value.trim()) {
    return '<span style="color:var(--rd);font-size:9px">未识别</span>'
  }
  return ''
})

function onInput() {
  const t = inputText.value.trim()
  if (t) {
    postMessage('preview', { text: t })
  }
}

function onFocus() {
  isFocused.value = true
  if (inputRef.value) inputRef.value.style.height = '68px'
}

function onBlur() {
  isFocused.value = false
  if (inputRef.value && !inputText.value.trim()) inputRef.value.style.height = '32px'
}

function doBatch() {
  const t = inputText.value.trim()
  if (t) {
    postMessage('batchAdd', { text: t })
    inputText.value = ''
    if (inputRef.value) inputRef.value.style.height = '32px'
  }
}
</script>

<style scoped>
.add-section{margin-bottom:8px}
.addbar{display:flex;gap:4px;align-items:flex-end}
.addbar textarea{flex:1;padding:7px 10px;background:var(--bg2);border:1px solid var(--bd);border-radius:var(--R);color:var(--tx);font-size:11px;font-family:inherit;resize:none;height:32px;min-height:32px;transition:all .2s ease;line-height:1.4}
.addbar textarea::placeholder{color:var(--tx3)}
.addbar textarea:focus{outline:0;border-color:var(--ac);background:var(--bg);box-shadow:0 0 0 2px var(--ac-bg)}
.add-btn{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:1px solid var(--bd);background:transparent;color:var(--tx2);border-radius:var(--R);cursor:pointer;font-size:16px;font-weight:300;transition:all .15s ease;flex-shrink:0}
.add-btn:hover{background:var(--sf2);border-color:var(--ac);color:var(--ac);transform:scale(1.05)}
.add-btn:active{transform:scale(.95)}
#preview{font-size:9px;color:var(--tx2);max-height:36px;overflow-y:auto;padding:4px 2px 0;line-height:1.6}
#preview :deep(.pe){color:var(--tx2)}
#preview :deep(.pp){color:var(--yw)}
#preview :deep(.pf){color:var(--tx3);font-style:italic}
</style>
