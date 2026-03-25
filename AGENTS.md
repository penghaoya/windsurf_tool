# AGENTS.md — windsurf-tools

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
│   │   ├── extension.js        # 主入口，号池引擎，12 命令，10 层防御
│   │   ├── authService.js      # Firebase 认证链 + Protobuf 积分查询
│   │   ├── accountManager.js   # 账号 CRUD + 三重持久化 + 号池聚合
│   │   ├── fingerprintManager.js # 设备指纹 6ID 读取/重置/热轮转
│   │   ├── sqliteHelper.js     # state.vscdb 读写 (node:sqlite DatabaseSync)
│   │   └── webviewProvider.js  # Vue 产物加载器 + 消息路由 + 状态推送
│   └── webview/                # Vue 3 前端 (ESM)
│       ├── main.js             # Vue 入口
│       ├── App.vue             # 根组件
│       ├── composables/useVscode.js  # Extension Host 通信桥接
│       ├── utils/format.js     # 格式化工具
│       ├── styles/theme.css    # 主题变量
│       └── components/         # UI 组件
│           ├── PoolOverview.vue    # 号池总览
│           ├── Toolbar.vue         # 工具栏
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

## 认证链 (四步)

1. Firebase 登录 (email+password) → idToken
2. RegisterUser (idToken) → apiKey
3. provideAuthTokenToAuthProvider (idToken) → 注入 Windsurf session
4. GetPlanStatus (idToken) → Protobuf 解析 → credits/quota

## 10 层防御

| 层级 | 机制 |
|------|------|
| L1-L2 | Context Key 轮询 (quota 检测) |
| L3-L4 | Context Key 轮询 (model/tier 限流) |
| L5 | gRPC 容量主动探测 (CheckUserMessageRateLimit) |
| L6 | 斜率预测 (线性外推) |
| L7 | 速度检测器 (120s 突变) |
| L8 | Opus 消息预算守卫 |
| L9 | 输出通道实时拦截 |
| L10 | 多窗口协调 (账号隔离+心跳, 跨平台路径) |

## 调度策略 (v14.0)

### 调度架构

```
_poolTick
 ├─ 响应式切换: 额度下降 → 切到快照中额度未变的“静止”账号
 ├─ evaluateActiveAccount() → decision
 │   ├─ Tier 1: L5 gRPC (L5-A 耗尽 / L5-B 预警)
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
     └─ Trial池冷却时无候选 → 自动降级到Sonnet
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
 ├─ _getOrderedCandidates() → 有序候选列表
 ├─ _filterRuntimeCandidates() → 过滤隔离账号+Trial池冷却账号
 ├─ 遍历候选: _validateSwitchCandidate() (5s预热)
 │   ├─ 账号已隔离 / Trial池冷却中 → 跳过
 │   ├─ 额度≤阈值 / 已限流 → 跳过
 │   └─ 超时 → 跳过, 尝试下一个
 ├─ Trial池冷却时无候选 → _downgradeFromTrialPressure() → 降级到Sonnet
 └─ _seamlessSwitch() → 执行切换
```

支持参数: `targetPolicy` (same_strategy/quota_first/same_model), `panic`, `refreshPool`, `allowThresholdFallback`, `candidates`

### 账号选择排序 (selectOptimal) — v14.1 价值最大化

- 返回**有序数组** (非单个对象), `findBestForModel` 委托给 `selectOptimal`
- **Mode-Aware 分组排序**: quota/credits/unknown 三类分别排序后合并
- 支持 `excludeEmails` (多窗口隔离), `preferredMode`, `modelUid` 过滤
- 候选数据含 `dailyRemaining`, `weeklyRemaining` 独立字段 (v14.0)

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

| 机制 | 说明 |
|------|------|
| UFEF 冷却 | 10min 冷却防止 safe↔urgent 频繁抖动 |
| Round-Robin | 同紧急度+额度差≤10%时轮转, 均匀消耗 |
| 指数退避 | 限流冷却 base×2^(n-1), 上限3600s, 恢复后归零 |
| 预热验证 | _validateSwitchCandidate: 5s超时, 逐个遍历候选 |
| 自适应扫描 | 全池扫描: normal 300s / boost 120s / burst 60s |
| Trial 检测 | `global rate limit for trial users` → tier_cap 即时切号 |
| NO_DATA 保守 | L5 返回 -1/-1 时 Trial 预估上限降至 15 条 |
| 账号隔离 | 命中Trial限流的账号隔离1h, 候选过滤+预热拒绝 |
| Trial池冷却 | 全局Trial限流时按模型族冷却整组Trial候选(20min) |
| 模型降级 | Trial池冷却无候选时自动从Opus降级到Sonnet |
| 降级锁 | 降级后120s内_readCurrentModelUid()不读DB, 防止覆盖回Opus |
| 降级清理 | 降级成功后清Opus消息计数+per-model限流标记 |
| 静默模式 | Trial池冷却+降级锁生效时跳过预防性轮转 |
| 失败防抖 | Trial池冷却切换失败后60s内不重试 |
| 切号重置 | _dropAccountRuntime(旧) + _resetAccountRuntime(新) |
| 可配置阈值 | `wam.preemptiveThreshold` (默认15, 0-100) |
| 动态Opus冷却 | L5 resetsInSeconds优先(≥300s), 固定1500s兜底 (v14.2) |
| Opus预算过滤 | opus_budget_guard切号时过滤Opus预算已耗尽的Trial候选 (v14.2) |
| 全池Opus检查 | 切号前统计可用Trial候选,无候选时主动降级Sonnet (v14.2) |
| Opus切号兜底 | opus_budget_guard切号失败→降级Sonnet作为最后防线 (v14.2) |
| 提前preempt | budget>1时提前1条触发(T=1条切,R=2条切),留buffer完成切号 (v14.2) |
| L5 NO_DATA降频 | 连续≥5次NO_DATA后逐步拉长探测间隔(最高120s),减少无效网络请求 (v15.0) |
| 降级恢复 | Trial池冷却过期+降级锁过期后自动恢复到降级前的Opus模型 (v15.0) |
| Token精确过期 | JWT exp字段计算精确过期时间(提前2min buffer),替代固定50min TTL (v15.0) |
| SQLite读缓存 | 1s TTL读副本缓存,同窗口内多次读操作复用同一copyFile副本 (v15.0) |
| _refreshPanel防抖 | 50ms防抖合并频繁调用,减少Webview序列化开销 (v15.0) |

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

## 开发规则

- Extension Host 6 个源文件 (含 sqliteHelper.js)
- 所有源码 ESM (import/export)，构建时 Vite 转 CJS 输出
- `vscode` 和 Node.js 内置模块作为 external，不打包
- Webview 通过 `postMessage` 双向通信，不直接访问 Node.js API
- CSS 使用 VS Code 主题变量 (`--vscode-*`)，适配深/浅色主题
- 修改后验证: `npm run build` 无报错
- 发布前验证: `npm run package` 生成 .vsix
