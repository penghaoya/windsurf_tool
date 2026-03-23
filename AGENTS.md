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

## 调度策略 (v12.0)

### 预防性切换三层结构

```
_poolTick
 ├─ Tier 1: L5 gRPC (L5-A 耗尽 / L5-B 预警)
 ├─ Tier 2: 配额阈值
 │   ├─ T2-A: shouldSwitch (depleted/low/expired/rate_limited)
 │   ├─ T2-B: isRateLimited 直接检查
 │   ├─ T2-C: Opus 预算守卫
 │   └─ T2-D: UFEF 紧急切换 (含10min冷却, 唯一入口)
 └─ Tier 3: 启发式降级 (仅L5无效时)
     ├─ L2 斜率 / L4 burst / L5-Tab / L6 速度
     └─ L7 Gate4 小时消息 (Trial NO_DATA时 cap=15)
```

### 账号选择排序 (selectOptimal / findBestForModel)

1. **过期紧急度** — urgent(≤3d) > soon(≤7d) > safe(>7d)
2. **周重置浪费预防** — 额度相近(≤20)且>50时, 优先周重置更近的
3. **Round-Robin 均匀消耗** — 额度差≤10%时, 优先最久未用的账号
4. **最高剩余额度**
5. **最快过期** — 先用完快到期的
6. **最近重置**

### 调度优化机制

| 机制 | 说明 |
|------|------|
| UFEF 冷却 | 10min 冷却防止 safe↔urgent 频繁抖动 |
| Round-Robin | 同紧急度+额度差≤10%时轮转, 均匀消耗 |
| 指数退避 | 限流冷却 base×2^(n-1), 上限3600s, 恢复后归零 |
| 预热验证 | 切换前刷新目标账号(5s超时), 额度≤15%取消切换 |
| 自适应扫描 | 全池扫描: normal 300s / boost 120s / burst 60s |
| Trial 检测 | `global rate limit for trial users` → tier_cap 即时切号 |
| NO_DATA 保守 | L5 返回 -1/-1 时 Trial 预估上限降至 15 条 |

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
- 心跳 30s, 死亡 90s, 账号隔离

## 开发规则

- Extension Host 6 个源文件 (含 sqliteHelper.js)
- 所有源码 ESM (import/export)，构建时 Vite 转 CJS 输出
- `vscode` 和 Node.js 内置模块作为 external，不打包
- Webview 通过 `postMessage` 双向通信，不直接访问 Node.js API
- CSS 使用 VS Code 主题变量 (`--vscode-*`)，适配深/浅色主题
- 修改后验证: `npm run build` 无报错
- 发布前验证: `npm run package` 生成 .vsix
