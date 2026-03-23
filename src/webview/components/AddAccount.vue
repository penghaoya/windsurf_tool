<template>
  <div class="add-section">
    <div class="addbar">
      <textarea
        ref="inputRef"
        id="bi"
        rows="1"
        placeholder="粘贴账号 (支持任意格式)"
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
  if (inputRef.value) inputRef.value.style.height = '60px'
}

function onBlur() {
  isFocused.value = false
  if (inputRef.value && !inputText.value.trim()) inputRef.value.style.height = '28px'
}

function doBatch() {
  const t = inputText.value.trim()
  if (t) {
    postMessage('batchAdd', { text: t })
    inputText.value = ''
    if (inputRef.value) inputRef.value.style.height = '28px'
  }
}
</script>

<style scoped>
.add-section{margin-bottom:5px}
.addbar{display:flex;gap:3px;align-items:flex-end}
.addbar textarea{flex:1;padding:5px 8px;background:var(--bg2);border:1px solid var(--bd);border-radius:var(--R3);color:var(--tx);font-size:10px;font-family:inherit;resize:none;height:28px;min-height:28px;transition:all .2s ease;line-height:1.4}
.addbar textarea::placeholder{color:var(--tx3)}
.addbar textarea:focus{outline:0;border-color:var(--ac);background:var(--bg);box-shadow:0 0 0 2px var(--ac-bg)}
.add-btn{width:28px;height:28px;display:flex;align-items:center;justify-content:center;border:1px solid var(--bd);background:transparent;color:var(--tx2);border-radius:var(--R3);cursor:pointer;font-size:14px;font-weight:300;transition:all .15s ease;flex-shrink:0}
.add-btn:hover{background:var(--sf2);border-color:var(--ac);color:var(--ac);transform:scale(1.05)}
.add-btn:active{transform:scale(.95)}
#preview{font-size:8px;color:var(--tx2);max-height:32px;overflow-y:auto;padding:3px 2px 0;line-height:1.5}
#preview :deep(.pe){color:var(--tx2)}
#preview :deep(.pp){color:var(--yw)}
#preview :deep(.pf){color:var(--tx3);font-style:italic}
</style>
