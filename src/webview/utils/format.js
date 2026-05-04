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

/** 到期剩余时间格式化 (精确到小时)
 *  >3d  → "5天12小时"
 *  1-3d → "1天6小时"
 *  <1d  → "8小时" / "30分钟"
 *  ≤0   → "已过期"
 *  null → ''
 */
export function formatPlanRemaining(planEnd) {
  if (!planEnd) return ''
  const diff = planEnd - Date.now()
  if (diff <= 0) return '已过期'
  const totalMin = Math.floor(diff / 60000)
  const totalHours = Math.floor(totalMin / 60)
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  if (days >= 1) {
    return hours > 0 ? `${days}天${hours}小时` : `${days}天`
  }
  if (totalHours >= 1) {
    const mins = totalMin % 60
    return mins > 0 ? `${totalHours}小时${mins}分` : `${totalHours}小时`
  }
  return totalMin > 0 ? `${totalMin}分钟` : '<1分钟'
}

/** 紧凑倒计时: '45s' / '12m' / '5h' / '2d' */
export function fmtCompactReset(ts) {
  if (!ts) return ''
  const diff = ts - Date.now()
  if (diff <= 0) return '0s'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** 从某时间点至今的相对时间: '3d前' / '5h前' / '刚刚' */
export function fmtAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m}m前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h前`
  return `${Math.floor(h / 24)}d前`
}

/** 状态 dot class */
export function dotClass(rem, threshold, isExpired) {
  if (isExpired) return 'bad'
  if (rem === null) return 'dm'
  if (rem <= threshold) return 'bad'
  if (rem <= threshold * 3) return 'warn'
  return 'ok'
}
