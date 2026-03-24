<template>
  <div class="sect">
    <div class="sbox" :class="{ open: expanded }">
      <div id="list">
        <template v-if="accounts.length > 0">
          <AccountCard
            v-for="(account, i) in accounts"
            :key="account.email || i"
            :account="account"
            :index="i"
            :isCurrent="i === currentIndex"
            :threshold="threshold"
          />
        </template>
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
import AccountCard from './AccountCard.vue'

defineProps({
  accounts: { type: Array, default: () => [] },
  currentIndex: { type: Number, default: -1 },
  threshold: { type: Number, default: 5 },
  expanded: { type: Boolean, default: true },
})
</script>

<style scoped>
.sect{margin-top:0}
.sbox{display:none;padding:2px 0}
.sbox.open{display:block}
.empty{text-align:center;padding:28px 12px;color:var(--tx3);font-size:12px;line-height:2}
.empty-icon{font-size:28px;margin-bottom:6px;opacity:.4}
</style>
