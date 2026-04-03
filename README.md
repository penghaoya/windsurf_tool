# Windsurf 小助手

无感号池引擎 VSIX 扩展 — 自动管理多 Windsurf 账号，rate limit 前主动切换，零中断。

## 功能特性

- **号池引擎** — 多账号自动轮转，用尽即切，无感切换
- **10 层防御** — 多维度限流检测，从 Context Key 到 gRPC 探测全覆盖
- **设备指纹热重置** — 切号时自动轮转 6 组设备 ID，服务端视为全新设备
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

### 3. 10 层防御体系

多层检测确保在 rate limit 触发**之前**完成切换：

| 层级 | 机制 | 原理 |
|------|------|------|
| L1-L2 | Context Key 轮询 | 每 2 秒读取 VS Code 内部 Context Key，检测 quota 变化 |
| L3 | cachedPlanInfo 监控 | 每 10 秒读取 state.vscdb 中缓存的计划信息，检测额度耗尽 |
| L5 | gRPC 容量探测 | 调用 `CheckUserMessageRateLimit` 接口，获取实时剩余消息数 |
| L6 | 斜率预测 | 基于历史消息速率线性外推，预测何时耗尽 |
| L7 | 速度检测器 | 120 秒窗口内消息速率突变检测 |
| L8 | Opus 预算守卫 | 按模型分级限制: Thinking-1M=1条, Thinking=2条, Regular=3条 |
| L9 | 输出通道拦截 | 实时监控 Windsurf 输出通道，拦截 rate limit 错误信息 |
| L10 | 多窗口协调 | 共享状态文件 + 心跳机制，多窗口间账号隔离 (跨平台路径) |

### 3.1 调度策略 (v16.0)

号池引擎采用 Per-Account Runtime State + 统一切换入口:

| 机制 | 说明 |
|------|------|
| 账号隔离 | 命中 Trial 限流的账号隔离 1h，候选过滤+预热拒绝 |
| Trial池冷却 | 全局 Trial 限流时按模型族冷却整组 Trial 候选 (20min) |
| 模型降级 | Trial 池冷却无候选时自动从 Opus 降级到 Sonnet |
| 降级锁 | 降级后 120s 内 _readCurrentModelUid() 不读 DB，防止覆盖回 Opus |
| 降级清理 | 降级成功后清 Opus 消息计数 + per-model 限流标记 |
| 静默模式 | Trial 池冷却 + 降级锁生效时跳过预防性轮转 (避免重试风暴) |
| 失败防抖 | Trial 池冷却切换失败后 60s 内不重试 |
| UFEF 冷却 | 10min 冷却防止 safe↔urgent 账号频繁抖动 |
| Round-Robin | 同紧急度 + 额度差≤10% 时轮转，均匀消耗 |
| 指数退避 | 限流冷却 base×2^(n-1)，上限 3600s，恢复后归零 |
| 并行预热 | Top-3 候选 Promise.allSettled 并行探测 (5s 超时)，切号延迟从 15s→5s (v16.0) |
| 切号重置 | _dropAccountRuntime(旧) + _resetAccountRuntime(新) |
| 可配置阈值 | `wam.preemptiveThreshold` (默认 15, 0-100) |
| Mode-Aware | selectOptimal 返回有序数组，quota/credits/unknown 分组排序 |
| Email 隔离 | 多窗口协调使用 Email 而非 index，避免顺序变化失效 |
| 价值最大化 | selectOptimal: 到期近+额度高=最优先，Quota 7 级 / Credits 4 级排序 (v14.1) |
| 动态Opus冷却 | L5 resetsInSeconds 优先(≥300s)，固定 1500s 兜底 (v14.2) |
| Opus预算过滤 | opus_budget_guard 切号时过滤已耗尽候选，无候选时主动降级 Sonnet (v14.2) |
| L5 NO_DATA降频 | 连续≥5次无数据后逐步拉长探测间隔(最高120s) (v15.0) |
| 降级恢复 | Trial池冷却+降级锁过期后自动恢复到降级前的 Opus 模型 (v15.0) |
| Token精确过期 | JWT exp 计算精确过期时间(提前2min buffer) (v15.0) |
| 模型Credit成本 | MODEL_CREDIT_COST: Opus T1M=10, T=5, R=3, Sonnet=1 (v16.0) |
| Opus模型路由 | Opus 请求时 Pro 账号前置、Trial 后置 (成本感知路由) (v16.0) |
| L5容量自适应 | 剩余≤2条:3s / ≤5:8s / ≤10:15s，越少探测越频繁 (v16.0) |

### 4. 设备指纹热重置

Windsurf 通过 6 组设备 ID 识别用户设备，切号时必须轮转以避免服务端关联：

```
storage.serviceMachineId  ← UUID v4 (storage.json + state.vscdb)
telemetry.devDeviceId     ← UUID v4
telemetry.macMachineId    ← UUID v4
telemetry.machineId       ← 32位 hex (无短横)
telemetry.sqmId           ← 32位 hex (无短横)
machineid                 ← UUID v4 (独立文件)
```

热重置流程：生成新 ID → 写入 `storage.json` → 写入 `state.vscdb` → 写入 `machineid` 文件 → Windsurf 重启后自动读取新 ID。

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
├── core/
├── services/
├── infra/
├── ui/
└── shared/
```

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

## 鸣谢

本项目参考了以下开源项目，在此表示感谢：

- [windsurf-assistant](https://github.com/zhouyoukang/windsurf-assistant) — 核心架构与认证链设计参考

## 许可

MIT
