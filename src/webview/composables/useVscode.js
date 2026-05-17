/**
 * VS Code Webview API 桥接层
 * 提供与 Extension Host 的双向通信
 */
import { ref, reactive } from 'vue'
import { ACTION, MSG } from '../../extension/shared/messageTypes.js'

// acquireVsCodeApi 在 VS Code webview 环境中全局可用
let _vscode = null
try { _vscode = acquireVsCodeApi() } catch {}

/** 发送消息到 Extension Host */
export function postMessage(type, data = {}) {
  _vscode?.postMessage({ type, ...data })
}

let _requestSeq = 0

/** 发送需要结果回执的动作 */
export function requestAction(type, data = {}) {
  const requestId = `${Date.now()}-${++_requestSeq}`
  _vscode?.postMessage({ type, requestId, ...data })
  return requestId
}

/** 号池状态 (由 Extension Host 推送) */
export const state = reactive({
  accounts: [],
  currentIndex: -1,
  pool: { total: 0, available: 0, depleted: 0, rateLimited: 0, expired: 0, health: 0, avgDaily: null, avgWeekly: null, nextReset: null, weeklyReset: null, avgCredits: null },
  activeQuota: null,
  threshold: 15,
  autoRotate: true,
  manualThreshold: 0,
  alwaysFreshFingerprint: true,
  switchCount: 0,
  switchStatus: null,
  lastDecision: null,
})

/** Toast 消息队列 */
export const toasts = ref([])

/** 加载状态 */
export const isLoading = ref(false)

/** 密码复制回调 (index → { email, pwd }) */
export const pwdResults = reactive({})

/** 动作回执 (requestId → { ok, result?, error? }) */
export const actionResults = reactive({})

let _toastId = 0

function addToast(msg, isError = false) {
  const id = ++_toastId
  toasts.value.push({ id, msg, isError })
  setTimeout(() => {
    toasts.value = toasts.value.filter(t => t.id !== id)
  }, 2700)
}

/** 主动请求 Extension Host 推送最新状态 */
export function requestState() {
  postMessage(ACTION.REQUEST_STATE)
}

/** 初始化消息监听 */
export function initMessageListener() {
  // 挂载后主动请求数据
  requestState()

  // 页面可见性变化时重新请求 (切换 tab 回来)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) requestState()
  })

  window.addEventListener('message', (e) => {
    const m = e.data
    if (!m || !m.type) return

    switch (m.type) {
      case MSG.STATE:
        if (m.accounts) state.accounts = m.accounts
        if (m.currentIndex !== undefined) state.currentIndex = m.currentIndex
        if (m.pool) state.pool = m.pool
        if (m.activeQuota !== undefined) state.activeQuota = m.activeQuota
        if (m.threshold !== undefined) state.threshold = m.threshold
        if (m.autoRotate !== undefined) state.autoRotate = m.autoRotate
        if (m.manualThreshold !== undefined) state.manualThreshold = m.manualThreshold
        if (m.alwaysFreshFingerprint !== undefined) state.alwaysFreshFingerprint = m.alwaysFreshFingerprint
        if (m.switchCount !== undefined) state.switchCount = m.switchCount
        if (m.switchStatus !== undefined) state.switchStatus = m.switchStatus
        if (m.lastDecision !== undefined) state.lastDecision = m.lastDecision
        break
      case MSG.TOAST:
        addToast(m.msg, m.isError)
        break
      case MSG.LOADING:
        isLoading.value = !!m.on
        break
      case MSG.ACTION_RESULT:
        if (m.requestId) {
          actionResults[m.requestId] = {
            ok: !!m.ok,
            result: m.result,
            error: m.error || null,
          }
        }
        break
      case MSG.PWD_RESULT:
        if (m.index !== undefined) {
          pwdResults[m.index] = { email: m.email, pwd: m.pwd }
        }
        break
    }
  })
}
