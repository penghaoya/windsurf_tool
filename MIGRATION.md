# 架构迁移方案 v2.0

## 目标结构

```
src/extension/
├── extension.js              # 激活入口，只做装配 (~350行)
│
├── core/                     # 调度核心
│   ├── scheduler.js          # 引擎心跳 + 评估 + 切换执行
│   ├── defense.js            # L1-L5 检测 + 限流分类
│   ├── model.js              # Opus 守卫 + 模型降级/恢复
│   ├── window.js             # 多窗口心跳 + 共享状态
│   └── state.js              # 共享可变状态 + 运行时
│
├── services/                 # 业务服务
│   ├── account.js            # 账号 CRUD + 持久化 + 限流标记
│   ├── accountSelector.js    # 候选排序 + 优先级策略
│   ├── auth.js               # Firebase 认证 + token 缓存
│   ├── authInjector.js       # 四策略注入 + 指纹轮转
│   └── fingerprint.js        # 设备指纹 6ID 读写
│
├── infra/                    # 基础设施适配
│   ├── sqlite.js             # state.vscdb 读写
│   ├── proxy.js              # 代理探测 + 模式管理
│   └── proto.js              # Protobuf 编解码 + gRPC 客户端
│
├── ui/                       # VS Code 宿主 UI
│   ├── webview.js            # Vue 产物加载 + 状态推送
│   ├── actions.js            # Webview 动作路由
│   ├── statusbar.js          # 状态栏渲染
│   └── wisdom.js             # 智慧模板部署
│
└── shared/                   # 共享配置与工具
    ├── config.js             # 常量 + 正则 + 模型辅助
    └── messageTypes.js       # Webview 消息契约
```

> `extension.old.js` (144KB) 直接删除，git history 已保留。

---

## 当前文件 → 新位置映射

| 当前文件 | 行数 | 新位置 | 说明 |
|---------|------|--------|------|
| `extension.js` | 1492 | 拆为 5 个文件 | 见下方详细拆分 |
| `authService.js` | 1300 | 拆为 3 个文件 | 见下方详细拆分 |
| `accountManager.js` | 1217 | 拆为 2 个文件 | 见下方详细拆分 |
| `engineState.js` | 275 | `core/state.js` | 整体搬迁 |
| `scheduler.js` | 722 | `core/scheduler.js` | 整体搬迁 |
| `defenseLayer.js` | 598 | `core/defense.js` | 整体搬迁 |
| `modelManager.js` | 132 | `core/model.js` | 整体搬迁 |
| `windowCoord.js` | 225 | `core/window.js` | 整体搬迁 |
| `config.js` | 144 | `shared/config.js` | 整体搬迁 |
| `sqliteHelper.js` | ~180 | `infra/sqlite.js` | 整体搬迁 |
| `fingerprintManager.js` | ~285 | `services/fingerprint.js` | 整体搬迁 |
| `webviewProvider.js` | 295 | `ui/webview.js` | 整体搬迁 |
| `extension.old.js` | 4200+ | **删除** | 死代码 |

---

## 详细拆分方案

### 1. extension.js (1492行) → 5 个文件

#### `extension.js` 保留 (~350行) — 激活入口

只保留激活、依赖装配、命令绑定：

```
保留函数:
  activate()                    # 激活入口
  _activate()                   # 内部激活
  _wireDeps()                   # deps 注册
  deactivate()                  # 注销
  _refreshOne()                 # 刷新单个账号 (与多模块紧耦合)
  _refreshAll()                 # 并行刷新所有
  _doRefreshPool()              # 刷新号池命令
  _doBatchAdd()                 # 批量添加命令
  _doImport()                   # 导入命令
  _doExport()                   # 导出命令
  _doSwitchMode()               # 切换代理模式
  _doResetFingerprint()         # 重置指纹命令
```

#### `services/authInjector.js` (~250行) — 认证注入

```
提取函数:
  injectAuth(context, index)          # S0-S3 四策略注入 (核心, ~160行)
  _loginToAccount(context, index)     # 登录总入口
  _checkAccount(context, index)       # 仅检查不注入
  _postInjectionRefresh()             # 注入后状态刷新序列
  _dbInjectApiKey(newApiKey)          # DB 直写 apiKey
  _discoverAuthCommand()              # 运行时命令发现
  _writeAuthFilesCompat(authToken)    # 认证文件兼容写入
  _readAuthApiKeyPrefix()             # apiKey 前缀读取
  _waitForApiKeyChange()              # 自适应等待 apiKey 变化
  _rotateFingerprintForSwitch()       # 切号指纹轮转
  _clearCachedPlanInfo()              # 清除缓存 PlanInfo

依赖:
  ← vscode, fs, path
  ← core/state.js (S, _logInfo, _logWarn, _logError)
  ← core/window.js (_getWindsurfGlobalStoragePath)
  ← services/fingerprint.js (resetFingerprint, hotVerify)
  ← infra/sqlite.js (getStateDbPath, dbReadKey, dbDeleteKey, dbTransaction)

导出:
  export { injectAuth, _loginToAccount, _checkAccount }
```

#### `ui/actions.js` (~120行) — Webview 动作路由

```
提取函数:
  _handleAction(context, action, arg)   # 25 个 case 的路由

  case 清单:
    login / checkAccount / explicitSwitch / refreshAll / refreshOne
    clearRateLimit / getCurrentIndex / getProxyStatus / getPoolStats
    getActiveQuota / getSwitchCount / getAccountBlocked / setMode
    setProxyPort / reprobeProxy / exportAccounts / importAccounts
    resetFingerprint / panicSwitch / batchAdd / refreshAllAndRotate
    getFingerprint / smartRotate / setAutoRotate / setPreemptiveThreshold

依赖:
  ← vscode
  ← core/state.js (S, schedulerState, _getAccountEmail, ...)
  ← core/scheduler.js (_performSwitch, _seamlessSwitch, _doPoolRotate)
  ← core/window.js (_syncSchedulerToShared)
  ← core/model.js (_readCurrentModelUid)
  ← services/fingerprint.js (readFingerprint)

导出:
  export { _handleAction }
  // 或 export function createActionHandler(context, deps) → handler
```

#### `ui/statusbar.js` (~160行) — 状态栏渲染

```
提取函数:
  _updatePoolBar()     # 状态栏文本 + MarkdownString tooltip (~150行)

依赖:
  ← vscode
  ← core/state.js (S, _getCapacityState, _isBoost, _getPreemptiveThreshold)
  ← core/scheduler.js (_slopePredict, _getVelocity, _isHighVelocity)
  ← core/defense.js (_getHourlyMsgCount, _isNearTierCap)
  ← core/model.js (_readCurrentModelUid, _getOpusMsgCount)
  ← core/window.js (_getActiveWindowCount)
  ← shared/config.js (CONCURRENT_TAB_SAFE, TIER_MSG_CAP_ESTIMATE, isOpusModel, ...)

导出:
  export { _updatePoolBar }
```

#### `ui/wisdom.js` (~330行) — 智慧模板部署

```
提取函数:
  _doInitWorkspace(context)            # 工作区初始化向导
  _doEmbeddedWisdom(context, path, action)  # 内置模板注入
  _loadWisdomBundle(context)           # 模板包加载
  callApi(apiPath, method, body)       # 内部 HTTP 调用 (可改为局部函数)

依赖:
  ← vscode, fs, path, http
  ← core/state.js (_logInfo, _logError)

导出:
  export { _doInitWorkspace }
```

---

### 2. authService.js (1300行) → 3 个文件

#### `infra/proxy.js` (~200行) — 代理探测

```
提取内容:
  模块级变量:
    PROXY_HOST, PROXY_PORTS, ACTIVE_PROXY_PORT
    PROXY_CHECKED, _probeDetail, ACTIVE_MODE
    RELAYS, RELAY

  方法 (改为独立函数或 ProxyResolver 类):
    _detectSystemProxy()         # 系统代理检测 (env/registry/macOS)
    _tcpProbe(host, port)        # TCP 端口连通性
    _verifyProxyReachability()   # HTTP CONNECT 验证
    _probeProxy()                # 智能多源探测入口
    reprobeProxy()               # 强制重新探测
    getProxyStatus()             # 获取当前状态
    setMode(mode)                # 手动切换模式
    setPort(port)                # 手动设置端口

导出:
  export class ProxyResolver { ... }
  // 或 export { reprobeProxy, getProxyStatus, setMode, setPort, ... }
```

#### `infra/proto.js` (~350行) — Protobuf + gRPC 客户端

```
提取内容:
  常量:
    PLAN_STATUS_URLS, REGISTER_URLS
    AuthService.CHECK_RATE_LIMIT_URLS

  Protobuf 编解码:
    _encodeProtoString(value, fieldNumber)
    _readVarint(data, pos)
    _encodeVarintBuf(value)
    _parseCredits(buf)
    _parseProtoString(buf)
    _parseProtoMsg(buf)
    _parseUsageInfo(buf)           # 结构化 usage info 解析 (~160行)
    _encodeCheckRateLimitRequest(apiKey, modelUid)
    _parseCheckRateLimitResponse(buf)

  gRPC 客户端:
    getUsageInfo(email, password)     # GetPlanStatus → 解析
    getCredits(email, password)       # GetPlanStatus → credits
    _fetchPlanStatus(reqData)         # 多端点降级
    registerUser(email, password)     # RegisterUser → apiKey
    getOneTimeAuthToken(email, pass)  # OTAT (legacy fallback)
    checkRateLimitCapacity(apiKey, modelUid)  # L5 容量探测

  本地状态读取 (读写 state.vscdb):
    readCachedQuota()          # cachedPlanInfo → 额度
    readCachedRateLimit()      # 限流状态
    readCachedValue(key)       # 通用键值读取
    writeModelSelection(uid)   # 模型选择写入
    readCurrentApiKey()        # 当前 apiKey

依赖:
  ← infra/proxy.js (ProxyResolver — 代理通道)
  ← infra/sqlite.js (getStateDbPath, dbReadKey, dbReadKeys, ...)
  ← services/auth.js (获取 idToken)

注意:
  gRPC 客户端需要 HTTP 请求能力，有两种设计:
  A) proto.js 持有 httpClient 引用 (注入)
  B) proto.js 自包含 _httpsJson/_httpsBinary (移过来)
  推荐 B — HTTP 辅助函数与 proto 编解码紧耦合，一起搬更内聚
```

#### `services/auth.js` 保留 (~750行) — 认证核心

```
保留内容:
  常量:
    FIREBASE_KEYS, TOKEN_TTL

  Firebase 认证:
    login(email, password, forceFresh)   # 双模式登录
    getFreshIdToken(email, password)     # 获取新鲜 idToken

  Token 缓存:
    _getCachePath() / _getLegacyCachePath()
    _loadCache() / _saveCache()
    _getCachedToken() / _setCachedToken()
    clearTokenCache()

  HTTP 基础设施 (如果不移到 proto.js):
    _needsProxy(hostname)
    _proxyTunnel(hostname)
    _rawRequest(...)
    _decodeChunked(raw)
    _httpsJson(url, method, body, useProxy)
    _httpsBinary(url, method, bodyBuffer, useProxy)
    _tryRelaysJson(path, body)
    _tryRelaysBinary(path, bodyBuffer)
    _raceUrls(urls, bodyBuffer)

  Facade (委托到 proto.js):
    getUsageInfo → proto.getUsageInfo
    getCredits → proto.getCredits
    registerUser → proto.registerUser
    checkRateLimitCapacity → proto.checkRateLimitCapacity
    readCachedQuota → proto.readCachedQuota
    readCachedValue → proto.readCachedValue
    writeModelSelection → proto.writeModelSelection
    readCurrentApiKey → proto.readCurrentApiKey

  生命周期:
    constructor(storagePath)
    dispose()

依赖:
  ← https, http, tls, fs, path, os, net, child_process
  ← infra/proxy.js (ProxyResolver)
  ← infra/proto.js (gRPC 客户端)
  ← infra/sqlite.js

导出:
  export { AuthService }

设计决策:
  AuthService 保持 facade 角色，对 extension.js 暴露接口不变。
  内部委托到 ProxyResolver + ProtoClient，调用方零改动。
```

---

### 3. accountManager.js (1217行) → 2 个文件

#### `services/accountSelector.js` (~300行) — 排序策略

```
提取内容:
  排序核心:
    _sortQuotaCandidates(a, b)     # Quota 7 级排序
    _sortCreditsCandidates(a, b)   # Credits 4 级排序
    _sortUnknownCandidates(a, b)   # Unknown 兜底排序
    _sortCandidatesByMode(candidates, mode)

  选择入口:
    selectOptimal(excludeIndex, threshold, excludeEmails, options)
    findBestForModel(modelUid, excludeIndex, threshold, excludeEmails, options)

  辅助 (排序依赖):
    getExpiryUrgency(index)        # UFEF 紧急度
    getPlanDaysRemaining(index)    # 过期天数
    isExpired(index)               # 是否过期
    effectiveRemaining(index)      # 有效剩余
    effectiveResetTime(index)      # 有效重置时间
    getSelectionMode(index)        # 选择模式
    getDetectedMode()              # 池检测模式
    getLastUsedTs(index)           # 最后使用时间

设计选项:
  A) 独立模块，接收 accountManager 引用:
     export function selectOptimal(am, excludeIndex, ...) { ... }
  B) AccountManager 内部委托:
     AccountManager.selectOptimal → accountSelector.selectOptimal(this, ...)
  推荐 B — 保持外部接口不变，accountManager.selectOptimal() 签名不动
```

#### `services/account.js` 保留 (~900行) — 账号管理

```
保留内容:
  存储层:
    constructor / _init / _save
    _getGlobalStorageRootPath / _getUserHomePath
    _loadFrom / _loadAndMergeAll
    _discoverExtensionAccounts
    startWatching / stopWatching
    onChange / _notify

  CRUD:
    getAll / count / get / findByEmail
    add / remove / addBatch
    updateCredits / updateUsage / _pushCreditHistory
    incrementLoginCount

  导入导出:
    exportAll / exportToFile / importFromFile / merge

  限流标记:
    markRateLimited / isRateLimited / clearRateLimit / getRateLimitInfo
    rateLimitedCount / allDepleted
    markModelRateLimited / isModelRateLimited / clearModelRateLimit
    findAvailableModelVariant / getModelRateLimits / getOpusCooldownInfo

  统计聚合:
    getPoolStats / getActiveQuota / getPlanSummary / _isExhausted

  均匀消耗:
    markUsed / getLastUsedTs / _lastUsedTs

  格式化:
    static parseAccounts(text)
    static formatCountdown(ts)

  生命周期:
    dispose()

  选择委托 (→ accountSelector.js):
    selectOptimal → 委托
    findBestForModel → 委托
```

---

### 4. 新增文件

#### `shared/messageTypes.js` (~60行) — 消息契约

```js
/** Extension Host → Vue Webview */
export const MSG = {
  STATE: 'state',             // 全量状态推送
  TOAST: 'toast',             // Toast 通知 { msg, isError }
  LOADING: 'loading',         // 加载状态 { on }
  PREVIEW_RESULT: 'previewResult',  // 批量预览结果 { accounts }
  PWD_RESULT: 'pwdResult',    // 密码复制回调 { index, email, pwd }
};

/** Vue Webview → Extension Host */
export const ACTION = {
  REQUEST_STATE: 'requestState',
  REMOVE: 'remove',
  LOGIN: 'login',
  PREVIEW: 'preview',
  BATCH_ADD: 'batchAdd',
  REFRESH: 'refresh',
  REFRESH_ALL_AND_ROTATE: 'refreshAllAndRotate',
  REFRESH_ONE: 'refreshOne',
  SMART_ROTATE: 'smartRotate',
  PANIC_SWITCH: 'panicSwitch',
  SET_MODE: 'setMode',
  REPROBE_PROXY: 'reprobeProxy',
  RESET_FINGERPRINT: 'resetFingerprint',
  REMOVE_EMPTY: 'removeEmpty',
  TOGGLE_DETAIL: 'toggleDetail',
  SET_PROXY_PORT: 'setProxyPort',
  SET_AUTO_ROTATE: 'setAutoRotate',
  SET_PREEMPTIVE_THRESHOLD: 'setPreemptiveThreshold',
  EXPORT_ACCOUNTS: 'exportAccounts',
  IMPORT_ACCOUNTS: 'importAccounts',
  CLEAR_RATE_LIMIT: 'clearRateLimit',
  COPY_PWD: 'copyPwd',
};
```

---

## 执行阶段

### Phase 0 — 清理 + 搬迁纯移动文件 (30min)

**目标**: 建立目录骨架，搬迁不需要拆分的文件。

| 步骤 | 操作 | 风险 |
|------|------|------|
| 0.1 | 删除 `extension.old.js` | 无 |
| 0.2 | 创建 `core/` `services/` `infra/` `ui/` `shared/` 目录 | 无 |
| 0.3 | `config.js` → `shared/config.js` | 低: 仅 import 路径变化 |
| 0.4 | `engineState.js` → `core/state.js` | 低: 仅 import 路径变化 |
| 0.5 | `windowCoord.js` → `core/window.js` | 低 |
| 0.6 | `modelManager.js` → `core/model.js` | 低 |
| 0.7 | `defenseLayer.js` → `core/defense.js` | 低 |
| 0.8 | `scheduler.js` → `core/scheduler.js` | 低 |
| 0.9 | `sqliteHelper.js` → `infra/sqlite.js` | 低 |
| 0.10 | `fingerprintManager.js` → `services/fingerprint.js` | 低 |
| 0.11 | `webviewProvider.js` → `ui/webview.js` | 低 |
| 0.12 | 批量更新所有文件的 `import` 路径 | 中: 涉及全部文件 |
| 0.13 | 更新 `vite.config.extension.js` 入口路径 (如需) | 低 |
| 0.14 | `npm run build` 验证 | 门禁 |

**关键**: 步骤 0.12 是本阶段核心工作量。所有 `import { ... } from './xxx.js'` 要改为相对于新位置的路径。

**import 路径变更矩阵** (Phase 0 搬迁后):

| 文件 (新位置) | 旧 import | 新 import |
|--------------|-----------|-----------|
| `extension.js` (根) | `./config.js` | `./shared/config.js` |
| | `./engineState.js` | `./core/state.js` |
| | `./windowCoord.js` | `./core/window.js` |
| | `./modelManager.js` | `./core/model.js` |
| | `./defenseLayer.js` | `./core/defense.js` |
| | `./scheduler.js` | `./core/scheduler.js` |
| | `./sqliteHelper.js` | `./infra/sqlite.js` |
| | `./fingerprintManager.js` | `./services/fingerprint.js` |
| | `./webviewProvider.js` | `./ui/webview.js` |
| | `./accountManager.js` | `./services/account.js` |
| | `./authService.js` | `./services/auth.js` |
| `core/scheduler.js` | `./config.js` | `../shared/config.js` |
| | `./engineState.js` | `./state.js` |
| | `./modelManager.js` | `./model.js` |
| | `./windowCoord.js` | `./window.js` |
| | `./defenseLayer.js` | `./defense.js` |
| `core/defense.js` | `./config.js` | `../shared/config.js` |
| | `./engineState.js` | `./state.js` |
| | `./modelManager.js` | `./model.js` |
| | `./windowCoord.js` | `./window.js` |
| `core/model.js` | `./config.js` | `../shared/config.js` |
| | `./engineState.js` | `./state.js` |
| `core/window.js` | `./config.js` | `../shared/config.js` |
| | `./engineState.js` | `./state.js` |
| `core/state.js` | `./config.js` | `../shared/config.js` |
| `services/fingerprint.js` | `./sqliteHelper.js` | `../infra/sqlite.js` |
| `services/account.js` | 无外部 import | 不变 |
| `services/auth.js` | `./sqliteHelper.js` | `../infra/sqlite.js` |
| `ui/webview.js` | `./accountManager.js` | `../services/account.js` |

---

### Phase 1-A — 拆 authService.js (1.5h)

**目标**: 将 1300 行拆为 auth.js + proxy.js + proto.js，AuthService facade 接口不变。

| 步骤 | 操作 | 验证 |
|------|------|------|
| 1.1 | 创建 `infra/proxy.js`，提取代理探测代码 (~200行) | 编译通过 |
| 1.2 | 创建 `infra/proto.js`，提取 Protobuf + gRPC 代码 (~350行) | 编译通过 |
| 1.3 | `services/auth.js` 内部改为委托 proxy + proto | 编译通过 |
| 1.4 | 确保 AuthService 对外接口 **零变化** | `npm run build` |

**接口兼容保障**:

```js
// services/auth.js — facade 保持不变
class AuthService {
  constructor(storagePath) {
    this._proxy = new ProxyResolver();
    this._proto = new ProtoClient(this, this._proxy);
    // ... token cache 等自有逻辑
  }

  // 以下方法签名不变，内部委托
  async reprobeProxy() { return this._proxy.reprobeProxy(); }
  getProxyStatus() { return this._proxy.getProxyStatus(); }
  setMode(mode) { this._proxy.setMode(mode); }
  setPort(port) { this._proxy.setPort(port); }

  async getUsageInfo(email, password) { /* 登录 → 委托 proto */ }
  async getCredits(email, password) { /* 登录 → 委托 proto */ }
  async registerUser(email, password) { /* 登录 → 委托 proto */ }
  async checkRateLimitCapacity(apiKey, modelUid) { return this._proto.checkRateLimitCapacity(apiKey, modelUid); }

  readCachedQuota() { return this._proto.readCachedQuota(); }
  readCachedValue(key) { return this._proto.readCachedValue(key); }
  writeModelSelection(uid) { return this._proto.writeModelSelection(uid); }
  readCurrentApiKey() { return this._proto.readCurrentApiKey(); }
}
```

---

### Phase 1-B — 拆 extension.js (1.5h)

**目标**: 从 1492 行降至 ~350 行。

| 步骤 | 操作 | 验证 |
|------|------|------|
| 1.5 | 创建 `services/authInjector.js`，提取注入链 (~250行) | 编译通过 |
| 1.6 | 创建 `ui/statusbar.js`，提取状态栏 (~160行) | 编译通过 |
| 1.7 | 创建 `ui/actions.js`，提取动作路由 (~120行) | 编译通过 |
| 1.8 | 创建 `ui/wisdom.js`，提取智慧部署 (~330行) | 编译通过 |
| 1.9 | `extension.js` 改为 import + 委托 | `npm run build` |

**deps 注册更新**:

```js
// extension.js — _wireDeps 更新
import { _loginToAccount } from './services/authInjector.js';
import { _updatePoolBar } from './ui/statusbar.js';

function _wireDeps() {
  deps.loginToAccount = _loginToAccount;
  deps.refreshOne = _refreshOne;         // 保留在 extension.js
  deps.refreshAll = _refreshAll;         // 保留在 extension.js
  deps.doPoolRotate = _doPoolRotate;     // 来自 core/scheduler.js
  deps.updatePoolBar = _updatePoolBar;   // 来自 ui/statusbar.js
  deps.syncSchedulerToShared = _syncSchedulerToShared;
  deps.performSwitch = _performSwitch;
  deps.trackMessageRate = _trackMessageRate;
}
```

---

### Phase 2 — 拆 accountManager.js (1h)

**目标**: 分离排序策略，保持外部接口不变。

| 步骤 | 操作 | 验证 |
|------|------|------|
| 2.1 | 创建 `services/accountSelector.js` (~300行) | 编译通过 |
| 2.2 | `services/account.js` 内部委托 selector | 编译通过 |
| 2.3 | 确保 `selectOptimal` / `findBestForModel` 签名不变 | `npm run build` |

**委托模式**:

```js
// services/account.js
import { createSelector } from './accountSelector.js';

class AccountManager {
  constructor(storagePath, options) {
    // ...原有逻辑...
    this._selector = createSelector(this);
  }

  selectOptimal(excludeIndex, threshold, excludeEmails, options) {
    return this._selector.selectOptimal(excludeIndex, threshold, excludeEmails, options);
  }

  findBestForModel(modelUid, excludeIndex, threshold, excludeEmails, options) {
    return this._selector.findBestForModel(modelUid, excludeIndex, threshold, excludeEmails, options);
  }
}
```

```js
// services/accountSelector.js
export function createSelector(am) {
  return {
    selectOptimal(excludeIndex, threshold, excludeEmails, options) {
      // 原 AccountManager.selectOptimal 逻辑
      // 通过 am.get() / am.isRateLimited() / am.isExpired() 等访问数据
    },
    findBestForModel(...) { ... },
  };
}
```

---

### Phase 3 — 消息契约 + 文档 (30min)

| 步骤 | 操作 |
|------|------|
| 3.1 | 创建 `shared/messageTypes.js` |
| 3.2 | `ui/webview.js` 和 `src/webview/composables/useVscode.js` 引用常量 |
| 3.3 | 更新 AGENTS.md 目录结构 + 模块职责 |
| 3.4 | 更新 README.md 架构图 |
| 3.5 | `npm run build` 最终验证 |

---

## Vite 构建配置

### `vite.config.extension.js`

入口路径不变 (仍是 `src/extension/extension.js`)，Vite 通过 import 链自动追踪所有子模块：

```js
// 仅需确认 entry 路径正确
entry: resolve(__dirname, 'src/extension/extension.js'),
```

**无需修改** — Vite tree-shake 从入口开始，新的 `core/` `services/` `infra/` `ui/` `shared/` 子目录通过 import 自动包含。

### `vite.config.js` (Webview)

如果 `shared/messageTypes.js` 被 webview 引用，需确认 Vite resolve 能找到 `src/extension/shared/`：

```js
// 可能需要添加 alias
resolve: {
  alias: {
    '@shared': resolve(__dirname, 'src/extension/shared'),
  }
}
```

或者 webview 侧直接用相对路径 `../../extension/shared/messageTypes.js`。

---

## 风险控制

### 原则

1. **纯提取重构** — 不改业务逻辑，只移动代码 + 调整 import/export
2. **Facade 兼容** — AuthService / AccountManager 对外接口零变化
3. **逐步验证** — 每个步骤 `npm run build`，不积累错误
4. **Git 原子提交** — 每个 Phase 一个 commit，方便回滚

### 高风险点

| 风险 | 缓解措施 |
|------|---------|
| import 路径批量替换遗漏 | Phase 0.12 用 grep 全量扫描 `from './'` 确认无残留 |
| 循环依赖引入 | deps 注册模式不变，新模块不互相直接 import |
| authInjector 引用 S 和 deps | 通过 import core/state.js 保持现有模式 |
| selectOptimal 拆出后性能 | 委托模式零额外开销 (函数引用) |
| Webview messageTypes 跨目录 | 构建时验证 Vite resolve |

### 回滚方案

每个 Phase 独立 commit:
- Phase 0: `git revert` → 恢复原结构
- Phase 1-A/B: 独立 commit，可单独回滚
- Phase 2/3: 低风险，极少需要回滚

---

## 迁移后指标

| 指标 | 迁移前 | 迁移后 |
|------|--------|--------|
| `extension.js` 行数 | 1492 | ~350 (**-76%**) |
| `authService.js` 行数 | 1300 | ~750 (**-42%**) |
| `accountManager.js` 行数 | 1217 | ~900 (**-26%**) |
| 最大文件行数 | 1492 | ~900 |
| 最大文件体积 | 54KB | ~30KB |
| 模块总数 | 13 | 17 |
| 目录层级 | 扁平 1 层 | 领域分层 2 层 |
| 单文件最大职责数 | 5 | 1 |
| 死代码 | 144KB | 0 |
