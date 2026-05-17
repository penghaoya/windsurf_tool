# AGENTS.md — windsurf-tools
# 通用偏好
- 用中文回复，代码注释用英文，注释写why不写how
- 简洁直接，不要多余总结和解释
- 直接写代码，不需要每次确认后再生成
# 代码风格
- 函数式优先，组合优于继承，TS/JS中避免0OP
- 新功能优先复用/重构现有代码，不堆砌
- KISS，DRY一最简可行方案
- 写代码时遵循 ai-coding-discipline 规则
# 架构与设计
- 从第一性原理解构问题一先明确什么是必须的，再决定怎么做
- 警惕XY问题-多角度审视方案，先确认真正要解决的是什么，主动提出替代方案解决根本问题，不要workaround-如果现有架构不支持，重构它0
- 质疑不合理的需求和方向一发现问题立刻指出，不要等我问才说，不要奉承或无脑赞同·架构设计时参考 ddia-principles 和 software-design-philosophy 规则

## 项目定位

Windsurf IDE 无感号池引擎 VSIX 扩展。自动管理多 Windsurf 账号，rate limit 前主动切换，零中断。

## 技术栈

- **语言**: JavaScript (ESM 源码，Vite 构建)
- **运行时**: VS Code Extension API (vscode ^1.85.0)
- **前端**: Vue 3 + Vite (Webview 侧边栏)
- **后端**: Node.js (Extension Host)
- **构建**: Vite 双流水线 (webview + extension)
- **打包**: @vscode/vsce → .vsix
- **网络**: 纯 Node.js https/http/tls，零第三方依赖
- **数据**: JSON 文件存储 (账号持久化) + 读写 Windsurf 内置 state.vscdb (SQLite，通过 Node.js 22.5+ 内置 `node:sqlite` DatabaseSync)

## 目录结构

```
windsurf-tools/
├── src/
│   ├── extension/              # Extension Host (Node.js ESM → CJS 输出)
│   │   ├── extension.js        # 激活入口 + 依赖装配 + 命令绑定
│   │   ├── core/               # 调度核心
│   │   │   ├── scheduler.js    # 引擎心跳 + 评估 + 切换执行 (_poolTick/evaluateActiveAccount/_performSwitch)
│   │   │   ├── defense.js      # L1-L5 检测 + 限流分类 + apiKey 缓存 + 安全中枢上报
│   │   │   ├── model.js        # Opus 守卫 + 模型降级/恢复
│   │   │   ├── state.js        # 共享状态 S + schedulerState + deps + 结构化日志 + 日志轮转
│   │   │   ├── window.js       # 多窗口心跳 + 共享状态同步 (Email 隔离)
│   │   │   └── refreshQueue.js # 刷新任务队列 (优先级 + 泳道并发 + 最小启动间隔)
│   │   ├── services/           # 业务服务
│   │   │   ├── account.js      # 账号 CRUD + 三路持久化 + 防抖写 + 限流标记 + 指纹字段
│   │   │   ├── accountSelector.js # 候选排序 (selectOptimal/findBestForModel)
│   │   │   ├── auth.js         # Devin-auth 认证 + Token 缓存 + 代理探测 + 双模式网络
│   │   │   ├── authInjector.js # S0(命令)+S1(DB直写) 注入 + Per-Account 指纹恢复 + Timing Jitter
│   │   │   ├── fingerprint.js  # 设备指纹 6ID 读写 + 原子写 storage.json
│   │   │   └── protobuf.js     # Protobuf 编解码 (纯函数)
│   │   ├── infra/
│   │   │   ├── sqlite.js       # state.vscdb 读写 (node:sqlite + 1s TTL 读副本缓存)
│   │   │   └── safeJson.js     # 原子 JSON 读写 (.bak 备份 + tmp+rename)
│   │   ├── ui/
│   │   │   ├── actions.js      # Webview 动作路由 (单一 switch 分发)
│   │   │   ├── statusbar.js    # 状态栏渲染
│   │   │   ├── webview.js      # Vue 产物加载器 + 状态推送
│   │   │   └── wisdom.js       # 智慧模板部署
│   │   └── shared/
│   │       ├── config.js       # 常量 + 正则 + 模型辅助 + 层级阈值函数
│   │       ├── messageTypes.js # Webview 消息契约
│   │       ├── accountParser.js# 通用账号文本解析 (与 Webview 共享)
│   │       └── quota.js        # cachedPlanInfo→usage 转换 + fresh-vs-cache 写入守卫
│   └── webview/                # Vue 3 前端 (ESM)
│       ├── main.js             # Vue 入口
│       ├── App.vue             # 根组件
│       ├── composables/useVscode.js  # Extension Host 通信桥接
│       ├── utils/format.js     # 格式化工具
│       ├── styles/theme.css    # 主题变量
│       └── components/         # UI 组件
│           ├── PoolOverview.vue    # 号池总览
│           ├── Toolbar.vue         # 工具栏
│           ├── ActiveAccountCard.vue # 当前激活账号卡
│           ├── QuickActions.vue    # 快捷操作 (紧急切换/批量添加等)
│           ├── ModeSwitcher.vue    # 自动/手动/调度阈值切换
│           ├── AddAccount.vue      # 添加账号
│           ├── AccountList.vue     # 账号列表
│           ├── AccountCard.vue     # 账号卡片
│           ├── QuotaMeter.vue      # 额度进度条
│           └── ToastMessage.vue    # Toast 通知
├── dist/                       # 构建产物
│   ├── extension.js            # Extension Host (Vite CJS)
│   └── webview/                # Vue 产物
│       ├── index.js
│       └── index.css
├── output/                     # VSIX 打包产物
├── vite.config.js              # Webview 构建配置
├── vite.config.extension.js    # Extension Host 构建配置
└── package.json                # VSIX 清单 + 构建脚本
```

## 构建命令

```bash
npm run build           # 双构建 (webview + extension)
npm run build:webview   # 仅 Vue webview → dist/webview/
npm run build:ext       # 仅 Extension Host → dist/extension.js
npm run package         # 构建 + 打包 → output/windsurf-tools-{version}.vsix
npm run install-ext     # 打包并安装到 IDE
```

## 命令 (contributes.commands)

| 命令 | 说明 |
|------|------|
| `wam.switchAccount` | 切换账号 |
| `wam.refreshCredits` | 刷新当前账号额度 |
| `wam.refreshAllCredits` | 刷新全部账号并轮转 |
| `wam.smartRotate` | 智能轮转 (查全部·切最优) |
| `wam.panicSwitch` | 紧急切换 (限流应急, panic=true) |
| `wam.batchAdd` | 批量添加账号 (粘贴文本解析) |
| `wam.importAccounts` | 导入账号文件 |
| `wam.resetFingerprint` | 手动重置设备指纹 |
| `wam.switchMode` | 切换网络模式 (local/relay) |
| `wam.reprobeProxy` | 重新探测代理 |
| `wam.openPanel` | 打开管理面板 |
| `wam.initWorkspace` | 工作区配置 (智慧模板部署) |

## 配置项 (contributes.configuration)

| 键 | 默认 | 说明 |
|----|------|------|
| `wam.autoRotate` | `true` | `true`=自动调度, `false`=手动 (仅在 ≤manualThreshold 时切) |
| `wam.preemptiveThreshold` | `15` | 自动模式预防性切换阈值 (% 剩余) |
| `wam.manualThreshold` | `0` | 手动模式安全网阈值 (%); 0=纯手动不自动切 |
| `wam.rotateFingerprint` | `true` | 切号时应用 Per-Account 绑定指纹 |

> **调度模式**: `autoRotate=true` 启用全部自动调度; `autoRotate=false` 仅当激活账号 ≤`manualThreshold` 时触发一次安全网切换。

## 认证链 (v23.4 Devin-only, post-2026-05-04)

> **背景**: 2026-05-04 起 Google 对 Firebase `signInWithPassword` 强制启用 App Check, 服务端/IDE 无法生成有效 token → 永久 401。`RegisterUser` 仅接受 `firebase_id_token`, 同步死亡。windsurf-assistant v17.42.20 (上游 reference) 与 WindsurfAPI v2.0.90+ 均已收敛到 Devin-only 路径。

### 主路径 (三步)

1. **CheckUserLoginMethod** (`windsurf.com/_backend/.../CheckUserLoginMethod`)
   - 主 probe; 失败回退 `windsurf.com/_devin-auth/connections` (兼容新旧 body shape)
   - 返回: `{ method: 'auth1', hasPassword: bool }`
2. **`_devin-auth/password/login`** (email + password) → `auth1Token`
3. **WindsurfPostAuth** (`X-Devin-Auth1-Token` header, 空 proto body)
   - host 优先 `_backend`, fallback `web-backend.windsurf.com`
   - binary proto 主, JSON fallback (多组织检测)
   - 返回: `sessionToken` (格式 `devin-session-token$xxx`)

### sessionToken 双重用途

- **作为 IDE apiKey 注入**:
  - **S0**: `vscode.commands.executeCommand('windsurf.provideAuthTokenToAuthProvider', sessionToken)`
  - **S1 fallback**: 直接写 `state.vscdb` 的 `windsurfAuthStatus.apiKey` (`dbInjectApiKey`)
- **作为 quota 查询 apiKey**: `GetUserStatus(metadata.apiKey=sessionToken)` → daily/weekly% (cascade gRPC 后端接受)

### 兼容/降级

| 路径 | 状态 | 说明 |
|------|------|------|
| Firebase signInWithPassword | **关闭** (`FIREBASE_LOGIN_ENABLED=false`) | App Check 永久 401, 关闭以消除冷启动 stampede |
| securetoken refreshToken renew | **保留** | 不受 App Check 影响, 老账号 cached refreshToken silent renew 仍可用 |
| RegisterUser (`register.windsurf.com`) | **deprecated shim** | 无 active call site, 兼容未来 firebase 复活 |
| GetOneTimeAuthToken | **删除** | 上游 401 invalid_token, 2026-05-04 起对所有 sessionToken 失效 |

### 并发保护 (v23.3+)

- **devin-auth slot**: `DEVIN_AUTH_MAX_CONCURRENCY=2` 全局并发上限 + `DEVIN_AUTH_MIN_START_GAP_MS=500` 启动间隔 + 8s acquire 超时 (`devin_slot_busy` 软失败, 不计入 429 counter)
- **429 指数退避**: 60s base × 2^n, 上限 300s 全局冷却 (`_devinAuthCooldownUntil`)
- **HTTPS host 三阶段熔断**: 失败 3 次走直连, 6 次整体 fail-fast

### wall-clock timeout (v23.3 修复)

`getUsageInfo` 使用 `Promise.race + setTimeout(10s)` 包裹 inner promise。修复前 timer 未在 inner 成功时 `clearTimeout` → 大量"任务先成功、10s 后假 timeout"日志噪音。现已用 `finally clearTimeout` 取消。

## 防封控架构 (v18.0)

### Per-Account 指纹绑定

每个账号绑定唯一设备指纹，切换时恢复而非随机生成：

```
切换到账号 #N
 ├─ S.am.getFingerprint(N) → 已有指纹?
 │   ├─ 是 → applyFingerprint(fp) → 恢复专属设备身份
 │   └─ 否 → generateFingerprint() → 生成+保存+应用
 ├─ machineid 文件写入
 ├─ storage.json 原子写入 (tmp+rename, 防崩溃损坏)
 ├─ state.vscdb 同步 (dbUpdateKeys)
 └─ hotVerify 延迟验证 (3s后确认生效)
```

- 账号数据持久化 `fingerprint` 字段 (6个ID + createdAt)
- 导出/导入时保留指纹数据
- 手动重置指纹 (`resetFingerprint`) 独立于 per-account 绑定

### 切换频率控制

| 机制 | 值 | 说明 |
|------|-----|------|
| MIN_SWITCH_INTERVAL | 30s | 两次自动切换最小间隔 |
| MAX_SWITCHES_PER_HOUR | 30 | 每小时自动切换上限 |
| Timing Jitter | 200-2200ms | 注入前随机延迟, 降低时序规律性 |
| panic 旁路 | — | 紧急切换(L5耗尽等)绕过频率限制 |

- 频率控制仅在 `_performSwitch` (自动切换入口) 生效
- 手动切换 (`_seamlessSwitch` 直接调用) 不受限
- `S.lastSwitchTs` + `S.hourlySwitchLog` 追踪切换时间

## 10 层防御

| 层级 | 机制 |
|------|------|
| L1-L2 | Context Key 轮询 (quota 检测) |
| L3-L4 | Context Key 轮询 (model/tier 限流) |
| L5 | gRPC 容量主动探测 — **当前已禁用** (`L5_ENABLED=false`) |
| L6 | 斜率预测 (线性外推) |
| L7 | 速度检测器 (120s 突变) |
| L8 | Opus 消息预算守卫 |
| L9 | 输出通道实时拦截 |
| L10 | 多窗口协调 (账号隔离+心跳, 跨平台路径) |

## 调度策略 (v19.0)

### 调度架构

```
_poolTick
 ├─ 响应式切换: 额度下降 → 切到快照中额度未变的“静止”账号
 ├─ evaluateActiveAccount() → decision
 │   ├─ Tier 1: L5 gRPC (**已禁用**, L5_ENABLED=false)
 │   ├─ Tier 2: 配额阈值
 │   │   ├─ T2-A: shouldSwitch (depleted/low/expired/rate_limited)
 │   │   ├─ T2-B: isRateLimited 直接检查
 │   │   ├─ T2-C: Opus 预算守卫 (降级锁期间跳过)
 │   │   └─ T2-D: UFEF 紧急切换 (含10min冷却)
 │   └─ Tier 3: 启发式降级 (仅L5无效时)
 │       ├─ 斜率 / burst / Tab压力 / 速度
 │       └─ Gate4 小时消息 (Trial NO_DATA时 cap=15)
 ├─ 静默模式: Trial池冷却+降级锁生效时跳过预防性轮转 (避免重试风暴)
 ├─ 防抖: Trial池冷却失败后60s内不重试
 └─ _performSwitch() → 过滤隔离账号+有序候选遍历+预热验证+切换
     └─ Trial池冷却时无候选 → Free降级到SWE-1.5(零消耗) / 付费降级到Sonnet (v17.0)
```

### Per-Account Runtime State

- `schedulerState.accounts` Map (email 为 key)
- 每个账号独立维护: `hourlyMsgLog`, `msgRateLog`, `quotaHistory`, `velocityLog`, `opusMsgLog`, `capacity`
- 切号时 `_dropAccountRuntimeByEmail` (旧) + `_resetAccountRuntimeByEmail` (新)
- `accountQuarantines` Map: 隔离命中Trial限流的账号 (email为key, 含过期时间)
- `poolCooldowns` Map: Trial全局限流时按模型族冷却整组Trial候选

### 统一切换入口 (_performSwitch)

```
_performSwitch(context, options)
 ├─ v18.0: 频率保护 (非panic时)
 │   ├─ MIN_SWITCH_INTERVAL 30s 最小间隔检查
 │   └─ MAX_SWITCHES_PER_HOUR 30次/h 上限检查
 ├─ _getOrderedCandidates() → 有序候选列表
 │   └─ selectOptimal 内部过滤: 日额度≤5% / 限流 / 过期 / 模型限流
 ├─ _filterRuntimeCandidates() → 过滤隔离账号+Trial池冷却账号
 ├─ 并行预热 Top-3 候选 (5s超时, v16.0)
 │   ├─ _validateSwitchCandidate → refreshOne + 日额度地板检查
 │   ├─ Promise.allSettled 并发探测前3个候选
 │   ├─ 取第一个成功的 → 立即切换
 │   └─ 剩余候选串行兜底
 ├─ Trial池冷却时无候选 → _downgradeFromTrialPressure() → 降级到Sonnet
 └─ _seamlessSwitch() → Per-Account指纹恢复 + Jitter + 执行切换 + globalState持久化
```

支持参数: `targetPolicy` (same_strategy/quota_first/same_model), `panic`, `refreshPool`, `allowThresholdFallback`, `candidates`

### 计划层级系统 (v17.0 — 2026-03 定价改革适配)

| 层级 | 价格 | 计费模式 | 超限行为 | 预防阈值 | Opus预算倍率 |
|------|------|----------|----------|----------|------------|
| **Free** | $0 | Quota (日/周) | 等待重置 | 20% | ×1 |
| **Pro** | $20/月 | Quota | Extra Usage | 15% | ×3 |
| **Max** | $200/月 | Quota | Extra Usage | 8% | ×10 |
| **Teams** | $40/座/月 | Quota | Extra Usage | 15% | ×3 |
| **Enterprise** | 定制 | Credits | Credits 购买 | 15% | ×3 |

- `PLAN_TIERS` 常量 + `getPlanTier(planStr)` 函数 (config.js)
- `_getPlanTier(index)` 读取账号层级 (state.js), `_isTrialLikeAccount` 委托给层级系统
- `getTierPreemptiveThreshold(tier)` 层级差异化阈值 (config.js)
- `getReactiveDropMin(tier)` 响应式切换按层级差异化 (Free=3% / Max=8%)
- `SWE_FREE_FALLBACK = 'swe-1.5'` 免费模型,不消耗 quota (config.js)
- Free账号降级目标: SWE-1.5 (零消耗); 付费账号: Sonnet (model.js)

### 账号选择排序 (selectOptimal) — v14.1 价值最大化

- 返回**有序数组** (非单个对象), `findBestForModel` 委托给 `selectOptimal`
- **Mode-Aware 分组排序**: quota/credits/unknown 三类分别排序后合并
- **Opus模型路由**: Opus请求时 Max前置 > Pro/Teams > Free后置 (额度感知路由) (v17.0)
- 支持 `excludeEmails` (多窗口隔离), `preferredMode`, `modelUid` 过滤
- 候选数据含 `tier`, `dailyRemaining`, `weeklyRemaining`, `isTrial` 字段 (v17.0)

**核心原则: 到期近+额度高 = 最优先** — 最大化"过期前能用掉的额度"

Quota 模式排序 (7级):
1. **T1 过期紧急度** — urgent(≤3d) > soon(≤7d) > safe(>7d)
2. **T2 额度高优先** — 最大化价值榨取 (差>15%时生效)
3. **T3 周额度高优先** — 更多周内可用容量 (差>15%时生效)
4. **T4 周重置更近优先** — 即将重置的先用 (>1h差异时生效)
5. **T5 过期更近优先** — 天数少的先用
6. **T6 Round-Robin** — 最久未用优先, 均匀消耗
7. **T7 日重置更近优先** — 最终兜底

Credits 模式排序 (4级):
1. **T1 过期紧急度**
2. **T2 额度高优先**
3. **T3 过期更近优先**
4. **T4 Round-Robin**

### 调度优化机制

**切换控制**
- UFEF 冷却 10min 防 safe↔urgent 抖动; Round-Robin 同级额度差≤10%时轮转均匀消耗
- 指数退避 base×2^(n-1) 上限 3600s; 并行预热 Top-3 候选 5s 超时 (Promise.allSettled)
- 自适应**心跳轮询**: normal `POLL_NORMAL=45s` / boost `POLL_BOOST=8s` / burst `POLL_BURST=3s`
- **全池扫描**间隔: normal 300s / boost 120s / burst 60s (启动后延迟 60s 启动)
- 全池扫描使用 `full_scan` 泳道 (并发=1, 最小启动间隔 1200ms), 且跳过 10min 内已刷新的账号
- 预热新鲜度: 候选 `usage.lastChecked` < `PREHEAT_FRESHNESS_TTL=5min` 时直接跳过网络请求
- 日额度 ≤5% 不作为候选 (`MIN_DAILY_QUOTA_FOR_SWITCH`)
- 可配置阈值 `wam.preemptiveThreshold` (默认15, 0-100); 用户覆盖优先于层级阈值

**Trial 防护**
- Trial 限流检测 → 账号隔离 1h + Trial 池冷却 20min (按模型族)
- 池冷却无候选 → 模型降级: Free→SWE-1.5(零消耗), 付费→Sonnet
- 降级锁 120s 防覆盖 + 降级成功清 Opus 计数 + 静默模式跳过预防性轮转
- 冷却+锁过期后自动恢复降级前 Opus 模型

**Opus 守卫**
- 多层级预算: Max×10 > Pro/Teams×3 > Free×1 (getModelBudgetForTier)
- 提前 preempt: budget>1 时提前 1 条触发, 留 buffer 完成切号
- Opus 预算耗尽的 Trial 候选在切号时过滤; 全池无候选 → 降级 Sonnet 兜底
- Opus 模型路由: Opus 请求时 Max 前置 > Pro/Teams > Free 后置

**防封控**
- Per-Account 指纹绑定: 切换时恢复专属设备身份而非随机生成
- 切换频率: MIN_SWITCH_INTERVAL=30s + MAX_SWITCHES_PER_HOUR=30
- Timing Jitter: 注入前 200-2200ms 随机延迟; storage.json 原子写入 (tmp+rename)

**数据可靠性**
- Proto3 默认值修复: 日额度 0% 被省略 → 三层防御正确识别为耗尽
- cachedPlanInfo email 校验, 防止数据污染; activeIndex 持久化防崩溃回退
- Token 精确过期 (JWT exp, 提前 2min buffer); SQLite 1s TTL 读副本缓存
- 账号存储防抖 300ms 合并写入; `_refreshPanel` 50ms 防抖; tooltip 指纹缓存
- **fresh-vs-cache 写入守卫** (`shared/quota.js`): 30s 窗口内 `local_cache` 不覆盖 `api/api_json/apikey_status` 实时写入
- **原子 JSON 读写** (`infra/safeJson.js`): tmp+rename + `.bak` 备份, 读取时自动回退到 `.bak`
- **结构化日志**: `_logInfo/_logWarn/_logError` 写 OutputChannel + 文件 (2MB 切片, 保留 3 份)

### Proto3 默认值修复

Proto3 不发送值为 0 的字段。日额度 = 0% 时 `dailyPct=undefined` → 三层防御:
1. `protobuf.js`: billing=quota 且一维度存在时，缺失维度默认 0
2. `account.js`: `effectiveRemaining` / `getDailyRemaining` 中 daily=null+weekly 存在 → 返回 0

## 账号存储架构

### 持久化字段 (JSON)

| 字段 | 类型 | 说明 |
|------|------|------|
| `email` | string | 登录邮箱 (唯一键) |
| `password` | string | 登录密码 |
| `credits` | number? | Credits 余额 (credits 模式) |
| `loginCount` | number | 累计登录次数 |
| `addedAt` | number | 添加时间戳 |
| `rateLimit` | object? | 持久化限流状态 (`until`, `resetsIn`, `type`, `model`) |
| `fingerprint` | object? | Per-Account 设备指纹 (6个ID + createdAt) |
| `usage` | object? | 额度信息 (见下) |

### usage 子结构

`mode`, `billingStrategy`, `daily` {used,total,remaining}, `weekly` {used,total,remaining},
`plan`, `resetTime`, `weeklyReset`, `extraBalance`, `planStart`, `planEnd`, `lastChecked`

### 运行时状态 (仅内存, 不持久化)

- `_rateLimits` Map — 完整限流信息 (8字段, 含指数退避)
- `_modelRateLimits` Map — per-(account,model) 限流桶
- `_lastUsedTs` Map — Round-Robin 均匀消耗追踪
- `_rateLimitHitCount` Map — 连续命中计数 (指数退避)

### 存储策略

- **三路持久化**: extension dir + globalStorage root + ~/.wam/ (防卸载/重装丢失)
- **防抖写入**: `_save()` 300ms debounce 合并高频写, `_flushSave()` 在 dispose 时强制刷盘
- **多源合并**: `_loadAndMergeAll` 从所有路径加载 → email 去重 → fresher data wins
- **自动迁移**: 加载时清理废弃字段 (creditHistory, lastChecked, usage.credits, maxPremiumMessages 等)
- **外部同步**: fs.watch 监听文件变更, 150ms 延迟重载 (多窗口场景)

### 候选排序 (accountSelector.js)

排序逻辑独立于 account.js, 由 `selectOptimal()` / `findBestForModel()` 委托调用

## 认证架构 (auth.js)

- **网络双模式**: `local` (本地代理 CONNECT tunnel) / `relay` (自建中转, 无需VPN)
- **代理智能探测**: 系统代理 → 环境变量 → 端口扫描 → CONNECT 验证 → relay 降级
- **Token 缓存**: JWT exp 精确过期 (提前 2min buffer), disk-persistent + memory Map
- **Protobuf 编解码**: 独立 `protobuf.js` 纯函数模块, auth.js 直接调用 (无 wrapper 层)
- **多端点容错**: `_raceUrls` 串行尝试 + `_tryRelays` 中转降级

## 数据流

```
Extension Host                          Vue Webview
─────────────                          ─────────────
_pushState() ──── postMessage ────→ useVscode.state (reactive)
                                       │
              ◄── postMessage ──── postMessage('requestState')
              ◄── postMessage ──── postMessage('refresh')
              ◄── postMessage ──── postMessage('remove', {index})
```

## 多窗口协调

- 共享状态文件: `wam-window-state.json` (跨平台路径)
  - macOS: `~/Library/Application Support/Windsurf/User/globalStorage/`
  - Linux: `~/.config/Windsurf/User/globalStorage/`
  - Windows: `%APPDATA%/Windsurf/User/globalStorage/`
- 原子写入: tmp文件 → rename, 失败降级直写
- 心跳 30s, 死亡 90s, **Email 隔离** (非 index, 避免顺序变化失效)
- `schedulerState` (隔离/池冷却) 通过 `syncSchedulerToShared` 同步到共享状态, 多窗口合并 max(until)

## 刷新任务队列 (core/refreshQueue.js)

统一的账号刷新调度, 避免并发爆炸与节流踩踏:

- **优先级**: `high` (切号预热) > `normal` > `low` (全池扫描)
- **任务去重**: 同 `key` 的 pending 任务合并, 高优先级可升级已排队任务
- **泳道并发控制** (`lane` + `laneConcurrency` + `minStartGapMs`):
  - `full_scan` 泳道: concurrency=1, gap=1200ms (避免风暴)
  - `batch_import_verify` 泳道: gap=5000ms (批量导入验证节流)
- **入口**: `enqueueRefresh(index, options)` / `enqueueRefreshAll(indexes, options)`
- 由 `extension.js` 注入 worker, 暴露为 `deps.refreshOne/refreshAll`

## 开发规则

- Extension Host 采用 `core/services/infra/ui/shared` 分层结构，避免回退到单层大文件
- 所有源码 ESM (import/export)，构建时 Vite 转 CJS 输出
- `vscode` 和 Node.js 内置模块作为 external，不打包
- Webview 通过 `postMessage` 双向通信，不直接访问 Node.js API
- CSS 使用 VS Code 主题变量 (`--vscode-*`)，适配深/浅色主题
- 修改后验证: `npm run build` 无报错
- 发布前验证: `npm run package` 生成 .vsix
