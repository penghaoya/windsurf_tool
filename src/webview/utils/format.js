/**
 * 共享格式化工具函数
 */

/** 重置时间倒计时格式化 */
export function fmtReset(ts) {
  if (!ts) return null
  const diff = ts - Date.now()
  if (diff <= 0) return '0天 00:00:00'
  const d = Math.floor(diff / 86400000)
  const h = Math.floor((diff % 86400000) / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  const s = Math.floor((diff % 60000) / 1000)
  return `${d}天 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 进度条颜色 */
export function meterColor(v) {
  if (v === null || v === undefined) return 'var(--tx3)'
  return v > 30 ? 'var(--gn)' : v > 10 ? 'var(--yw)' : 'var(--rd)'
}

/** 紧急度颜色 */
export function urgencyColor(urgency) {
  if (urgency === 0) return 'var(--rd)'
  if (urgency === 1) return 'var(--yw)'
  if (urgency === 3) return 'var(--rd)'
  return 'var(--gn)'
}

/** 紧急度标签 */
export function urgencyLabel(urgency) {
  if (urgency === 0) return ' 紧急!'
  if (urgency === 1) return ' 将到期'
  return ''
}

/** 状态 dot class */
export function dotClass(rem, threshold, isExpired) {
  if (isExpired) return 'bad'
  if (rem === null) return 'dm'
  if (rem <= threshold) return 'bad'
  if (rem <= threshold * 3) return 'warn'
  return 'ok'
}
