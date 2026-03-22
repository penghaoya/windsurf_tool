# Windsurf 小助手

无感号池引擎 VSIX 扩展 — 自动管理多 Windsurf 账号，rate limit 前主动切换，零中断。

## 功能

- **号池引擎** — 多账号自动轮转，用尽即切，无感切换
- **10 层防御** — Context Key / gRPC 容量探测 / 斜率预测 / Opus 预算守卫 / 输出拦截
- **设备指纹热重置** — 切号时自动轮转 6 组设备 ID，服务端视为全新设备
- **三重持久化** — 账号数据存 3 个位置，卸载重装不丢失
- **侧边栏仪表盘** — Vue 3 实时展示号池状态、额度、切换记录

## 安装

```bash
# 构建 + 打包
npm run package

# 安装到 Windsurf
npm run install-ext
```

生成的 `.vsix` 在 `output/` 目录。

## 构建命令

| 命令 | 说明 |
|------|------|
| `npm run build` | 双构建 (webview + extension) |
| `npm run build:webview` | 仅 Vue webview |
| `npm run build:ext` | 仅 Extension Host |
| `npm run package` | 构建 + 打包 VSIX |
| `npm run install-ext` | 打包并安装到 IDE |

## 技术栈

- **运行时**: VS Code Extension API
- **前端**: Vue 3 + Vite
- **构建**: Vite 双流水线 (ESM → CJS)
- **数据**: JSON 持久化 + node:sqlite (state.vscdb 读写)
- **网络**: 纯 Node.js 内置模块，零第三方依赖

## 许可

MIT
