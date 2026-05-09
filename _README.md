# Windsurf 小助手

无感号池引擎 VSIX 扩展 — 自动管理多 Windsurf 账号，rate limit 前主动切换，零中断。

## 功能特性

- **号池引擎** — 多账号自动轮转，用尽即切，无感切换
- **层级感知调度** — Free/Pro/Max/Teams/Enterprise 差异化阈值与 Opus 预算 (v17.0)
- **多层防御** — Context Key / cachedPlanInfo / 斜率 / 速度 / Opus 预算 / 输出通道 / 多窗口协调
- **Per-Account 指纹** — 每个账号绑定专属 6 组设备 ID，切换时恢复而非随机生成 (v18.0)
- **防封控频率控制** — 最小切换间隔 30s + 每小时上限 30 次 + 注入时 200-2200ms Timing Jitter
- **三重持久化** — 账号数据存 3 个位置，卸载重装不丢失
- **侧边栏仪表盘** — Vue 3 实时展示号池状态、额度、切换记录

## 插件效果

<p align="center">
</p>

---

## 实现原理

### 1. 认证链 (四步注入)

插件通过逆向 Windsurf 的认证流程，实现账号的自动登录与注入：

```
Step 1: Firebase Auth 登录
        email + password → Firebase REST API → idToken + refreshToken

Step 2: RegisterUser (gRPC)
        idToken → Codeium RegisterUser API → apiKey
        (apiKey 是 Windsurf 所有 API 调用的凭证)

Step 3: 注入 Windsurf Session
        idToken → provideAuthTokenToAuthProvider
        → Windsurf 内部完成 registerUser / session 注入
        → 必要时降级到 apiKey 命令注入或 state.vscdb 直写

Step 4: GetPlanStatus (gRPC + Protobuf)
        idToken → Codeium GetPlanStatus API → 二进制 Protobuf 响应
        → 手写解码器解析 → 获取 credits / quota / plan 信息
```

### 2. 号池引擎运行机制

插件启动后进入自动驾驶模式，核心循环：

```
┌─────────────────────────────────────────────────┐
│                 号池引擎主循环                      │
│                                                   │
│  1. 检测当前账号状态 (10 层防御并行)                  │
│  2. 任一层触发 → shouldSwitch = true               │
│  3. selectOptimal() 选择最优账号                    │
│     ├─ 过滤: 已限流 / 已过期 / 额度耗尽             │
│     ├─ 价值最大化: 到期近+额度高=最优先 (v14.1)          │
│     └─ 预热验证: 刷新目标账号确认额度充足              │
│  4. 执行切换                                       │
│     ├─ 轮转设备指纹 (6 组 ID)                       │
│     ├─ 注入新账号 apiKey 到 state.vscdb             │
│     ├─ 清除旧账号缓存 (cachedPlanInfo)              │
│     └─ 触发 Windsurf 重新加载认证状态                │
│  5. 验证注入结果 → 更新状态 → 推送到仪表盘            │
└─────────────────────────────────────────────────┘
```

### 3. 多层防御体系

多层检测确保在 rate limit 触发**之前**完成切换：

| 层级 | 机制 | 原理 |
|------|------|------|
| L1-L2 | Context Key 轮询 | 读取 VS Code 内部 Context Key，检测 quota 变化 |
| L3-L4 | cachedPlanInfo + 模型/层级限流 | 读取 `state.vscdb` 中缓存的计划信息与 tier cap 信号 |
| L5 | gRPC 容量探测 | `CheckUserMessageRateLimit` — **当前禁用** (`L5_ENABLED=false`, Proto schema 变更) |
| L6 | 斜率预测 | 基于历史消息速率线性外推，预测何时耗尽 |
| L7 | 速度检测器 | 120 秒窗口内消息速率突变检测 |
| L8 | Opus 预算守卫 | 层级差异化: Max×10 > Pro/Teams×3 > Free×1 (`getModelBudgetForTier`) |
| L9 | 输出通道拦截 | 实时监控 Windsurf 输出通道，拦截 rate limit 错误信息 |
| L10 | 多窗口协调 | 共享状态文件 + 心跳机制，Email 隔离 (跨平台路径) |

### 3.1 调度策略 (v19)

号池引擎采用 Per-Account Runtime State + 统一切换入口 `_performSwitch`:

**心跳 / 扫描**
- 自适应心跳轮询: normal 45s / boost 8s / burst 3s
- 全池扫描: normal 300s / boost 120s / burst 60s (启动延迟 60s), `full_scan` 泳道串行 (1200ms gap)
- 预热新鲜度 5min: 候选最近刷新过则跳过网络请求直接用缓存
- 并行预热 Top-3 候选 (Promise.allSettled, 5s 超时), 取首个成功; 其余串行兜底

**层级感知 (v17.0)**
- 层级差异化预防性阈值: Free=20% / Pro/Teams/Enterprise=15% / Max=8% (用户 `wam.preemptiveThreshold` 覆盖优先)
- 响应式切换阈值: Free=3% / Pro=5% / Max=8% / Credits=8%
- Opus 预算倍率: Free×1 / Pro/Teams/Enterprise×3 / Max×10
- Opus 请求路由: Max 前置 > Pro/Teams/Enterprise > Free 后置
- 降级目标: Free→SWE-1.5 (零消耗) / 付费→Sonnet

**账号选择排序 (v14.1 价值最大化)**
- 核心原则: 到期近+额度高 = 最优先 (最大化过期前榨取)
- `selectOptimal` 返回有序数组, Quota 7 级 / Credits 4 级, 分组 quota/credits/unknown
- 15% 额度带宽阈值 + Round-Robin 同级额度差≤10% 时轮转均匀消耗

**Trial / 限流防护**
- 账号隔离 1h: 命中 Trial 限流的账号候选过滤 + 预热拒绝
- Trial 池冷却 20min: 全局 Trial 限流时按模型族冷却整组候选
- 自动降级: 池冷却无候选时 Opus → Sonnet/SWE-1.5, 降级锁 120s 防覆盖
- 降级恢复: 池冷却 + 降级锁都过期后自动恢复原 Opus 模型
- UFEF 10min 冷却防止 safe↔urgent 抖动; 指数退避 base×2^(n-1) 上限 3600s
- 静默模式: 池冷却 + 降级锁生效时跳过预防性轮转避免重试风暴

**防封控 (v18.0)**
- Per-Account 指纹绑定: 切号时恢复专属 6 组设备 ID 而非随机生成
- 切换频率: `MIN_SWITCH_INTERVAL=30s` + `MAX_SWITCHES_PER_HOUR=30` (panic 旁路)
- Timing Jitter: 认证注入前 200-2200ms 随机延迟
- `storage.json` 原子写入: tmp+rename 防崩溃损坏

**可靠性**
- fresh-vs-cache 写入守卫: 30s 内 `local_cache` 不覆盖 API 实时写入 (`shared/quota.js`)
- 原子 JSON + `.bak` 备份 (`infra/safeJson.js`); SQLite 1s TTL 读副本缓存
- JWT exp 精确过期 (提前 2min buffer); Proto3 默认值三层修复 (0% 被省略场景)
- 多窗口 Email 隔离; `schedulerState` 同步 max(until) 合并

**刷新队列** (`core/refreshQueue.js`)
- 优先级: high (切号预热) > normal > low (全池扫描)
- 泳道并发: `full_scan` 1 并发 1200ms gap; `batch_import_verify` 5000ms gap
- 同 key pending 任务合并, 高优先级可升级排队任务

### 4. Per-Account 设备指纹 (v18.0)

Windsurf 通过 6 组设备 ID 识别用户设备，每个账号**绑定唯一指纹**，切换时恢复而非随机生成：

```
storage.serviceMachineId  ← UUID v4 (storage.json + state.vscdb)
telemetry.devDeviceId     ← UUID v4
telemetry.macMachineId    ← UUID v4
telemetry.machineId       ← 32位 hex (无短横)
telemetry.sqmId           ← 32位 hex (无短横)
machineid                 ← UUID v4 (独立文件)
```

**切号流程**:
```
切换到账号 #N
 ├─ am.getFingerprint(N) → 已有?
 │   ├─ 是 → applyFingerprint(fp) 恢复专属设备身份
 │   └─ 否 → generateFingerprint() 生成 + 持久化 + 应用
 ├─ storage.json 原子写入 (tmp+rename)
 ├─ state.vscdb 同步 + machineid 文件写入
 └─ hotVerify 延迟 3s 验证生效
```

- 账号 JSON 持久化 `fingerprint` 字段, 导入导出保留
- 手动 `wam.resetFingerprint` 仅清空当前 storage, 不影响 Per-Account 绑定

### 5. 数据读写 (state.vscdb)

Windsurf 将内部状态存储在 SQLite 数据库 `state.vscdb` 中，插件通过 Node.js 22.5+ 内置的 `node:sqlite` 模块直接读写：

- **读操作**: 复制 DB 到临时文件 → `DatabaseSync` 以只读模式打开 → 查询 → 关闭删除临时文件 (避免锁冲突)
- **写操作**: `DatabaseSync` 直接打开原始 DB → 设置 `busy_timeout = 5000` (等待 Windsurf 释放锁) → 执行写入 → 关闭
- **事务支持**: 多个写操作可合并为一个事务 (如注入 apiKey + 清除缓存)

### 6. 三重持久化

账号数据写入 3 个独立位置，任一存活即可恢复：

```
P0: <extensionStoragePath>/windsurf-assistant-accounts.json  (扩展存储)
P1: <globalStorage>/windsurf-assistant-accounts.json         (全局存储，卸载扩展后存活)
P2: ~/.wam/accounts-backup.json                              (用户目录，卸载 Windsurf 后存活)
```

启动时自动发现所有位置 → 合并去重 → 以最新数据为准。删除操作同步写入所有位置，防止"复活"。

---

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    Extension Host (Node.js)              │
│                                                          │
│  extension.js ─── 激活入口 / 装配 / 命令绑定              │
│       │                                                  │
│       ├── core/ ───── 调度核心 / 防御层 / 状态 / 窗口协调   │
│       ├── services/ ─ 账号管理 / 认证 / 注入 / 指纹        │
│       ├── infra/ ──── SQLite 适配                          │
│       ├── ui/ ─────── Webview / 状态栏 / 动作路由          │
│       └── shared/ ─── 配置常量 / 消息契约                  │
│                    │                                     │
│                    │ postMessage                          │
│                    ▼                                     │
│  ┌─────────────────────────────────┐                     │
│  │     Vue 3 Webview (侧边栏)       │                     │
│  │  App.vue → 组件树 → 实时仪表盘    │                     │
│  └─────────────────────────────────┘                     │
└─────────────────────────────────────────────────────────┘
```

当前 `src/extension/` 目录结构：

```text
extension/
├── extension.js
├── core/          # scheduler / defense / model / state / window / refreshQueue
├── services/     # account / accountSelector / auth / authInjector / fingerprint / protobuf
├── infra/        # sqlite / safeJson
├── ui/           # actions / statusbar / webview / wisdom
└── shared/       # config / messageTypes / accountParser / quota
```

详见 `AGENTS.md` 中的完整目录结构与模块职责说明。

## 技术栈

- **语言**: JavaScript (ESM 源码，Vite 构建为 CJS)
- **运行时**: VS Code Extension API (vscode ^1.85.0)
- **前端**: Vue 3 + Vite (Webview 侧边栏)
- **构建**: Vite 双流水线 (webview + extension)
- **数据**: JSON 文件 + node:sqlite DatabaseSync (state.vscdb)
- **网络**: 纯 Node.js https/http/tls，零第三方运行时依赖
- **Protobuf**: 手写编解码器，无 protobuf.js 依赖

## 安装

```bash
npm install        # 安装依赖
npm run package    # 构建 + 打包
npm run install-ext  # 安装到 Windsurf
```

生成的 `.vsix` 在 `output/` 目录。

## 构建命令

| 命令 | 说明 |
|------|------|
| `npm run build` | 双构建 (webview + extension) |
| `npm run build:webview` | 仅 Vue webview → `dist/webview/` |
| `npm run build:ext` | 仅 Extension Host → `dist/extension.js` |
| `npm run package` | 构建 + 打包 → `output/*.vsix` |
| `npm run install-ext` | 打包并安装到 IDE |
| `npm test` | 运行 `tests/*.test.mjs` (ESM loader) |

## 命令面板

| 命令 | 说明 |
|------|------|
| `wam.switchAccount` | 切换账号 |
| `wam.refreshCredits` / `wam.refreshAllCredits` | 刷新当前 / 全部账号额度 |
| `wam.smartRotate` | 智能轮转 (查全部·切最优) |
| `wam.panicSwitch` | 紧急切换 (限流应急) |
| `wam.batchAdd` / `wam.importAccounts` | 批量添加 / 导入账号 |
| `wam.resetFingerprint` | 重置设备指纹 |
| `wam.switchMode` / `wam.reprobeProxy` | 切换本地/中转 / 重探代理 |
| `wam.openPanel` | 打开管理面板 |
| `wam.initWorkspace` | 工作区配置 (智慧模板部署) |

## 配置项

| 键 | 默认 | 说明 |
|----|------|------|
| `wam.autoRotate` | `true` | 自动调度; `false` 时仅在 ≤`manualThreshold` 时切一次 |
| `wam.preemptiveThreshold` | `15` | 自动模式预防性切换阈值 (% 剩余) |
| `wam.manualThreshold` | `0` | 手动模式安全网阈值; 0=纯手动 |
| `wam.rotateFingerprint` | `true` | 切号时应用 Per-Account 绑定指纹 |

## 鸣谢

本项目参考了以下开源项目，在此表示感谢：

- [windsurf-assistant](https://github.com/zhouyoukang/windsurf-assistant) — 核心架构与认证链设计参考

## 许可

MIT
