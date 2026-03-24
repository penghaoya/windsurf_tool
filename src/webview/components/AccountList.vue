<template>
  <div class="sect">
    <div class="stog" @click="toggleDetail">
      <span class="sarr" :style="{ transform: expanded ? 'rotate(90deg)' : '' }">▶</span>
      <span>{{ filteredAccounts.length }}/{{ accounts.length }} 个账号</span>
    </div>
    <div class="sbox" :class="{ open: expanded }">
      <div id="list">
        <template v-if="filteredAccounts.length > 0">
          <AccountCard
            v-for="item in filteredAccounts"
            :key="item.account.email || item.index"
            :account="item.account"
            :index="item.index"
            :isCurrent="item.index === currentIndex"
            :threshold="threshold"
            :groups="groups"
          />
        </template>
        <div v-else-if="accounts.length > 0" class="empty">
          <div class="empty-icon">🔍</div>
          当前分组无账号
        </div>
        <div v-else class="empty">
          <div class="empty-icon">📭</div>
          号池为空<br>
          <span style="color:var(--ac)">粘贴账号到上方输入框开始使用</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { postMessage } from '../composables/useVscode.js'
import AccountCard from './AccountCard.vue'

const props = defineProps({
  accounts: { type: Array, default: () => [] },
  currentIndex: { type: Number, default: -1 },
  threshold: { type: Number, default: 5 },
  selectedGroup: { type: String, default: '' },
  groups: { type: Array, default: () => [] },
})

const filteredAccounts = computed(() => {
  const g = props.selectedGroup
  return props.accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => {
      if (!g) return true
      if (g === '__none__') return !account.group
      return account.group === g
    })
})

const expanded = ref(true)

function toggleDetail() {
  expanded.value = !expanded.value
  postMessage('toggleDetail')
}
</script>

<style scoped>
.sect{margin-top:2px}
.stog{cursor:pointer;font-size:10px;color:var(--tx2);padding:4px 2px;display:flex;align-items:center;gap:5px;user-select:none;font-weight:500;transition:color .15s}
.stog:hover{color:var(--tx)}
.sarr{transition:transform .2s ease;font-size:7px;color:var(--tx3)}
.sbox{display:none;padding:2px 0}
.sbox.open{display:block}
.empty{text-align:center;padding:28px 12px;color:var(--tx3);font-size:12px;line-height:2}
.empty-icon{font-size:28px;margin-bottom:6px;opacity:.4}
</style>
