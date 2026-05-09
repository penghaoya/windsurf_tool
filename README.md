# Windsurf Tools

Windsurf IDE 无感号池引擎 VSIX 扩展 — 自动管理多 Windsurf 账号，rate limit 前主动切换，零中断。

> BUG反馈请联系作者：微信 `penghao_study`

## 核心能力

- **自动轮转** — 额度用尽前预判切换，无需手动干预
- **多层防御** — 10 层检测（Context Key / 斜率预测 / 速度检测 / Opus 预算等）确保限流前完成切号
- **层级感知** — Free / Pro / Max / Teams 差异化阈值与调度策略
- **设备指纹** — Per-Account 绑定 6 组设备 ID，切号恢复专属身份而非随机生成
- **防封控** — 最小切换间隔 30s + 每小时上限 30 次 + 注入前 Timing Jitter
- **三重持久化** — 账号数据存 3 个独立位置，卸载重装不丢失

## 工作原理

1. Firebase Auth 登录 → 获取 idToken
2. RegisterUser → 获取 apiKey
3. 注入 Windsurf Session（provideAuthTokenToAuthProvider / state.vscdb 直写）
4. GetPlanStatus → Protobuf 解码 → 实时监控 credits / quota

号池引擎以心跳轮询运行，检测到额度低于阈值或限流信号时自动选择最优账号切换。

## 许可

MIT