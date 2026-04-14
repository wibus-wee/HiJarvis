# Jar Documentation

> HiJarvis (Jar) 是一个基于 `@mariozechner/pi-ai` / `@mariozechner/pi-agent-core` 构建的本地 AI agent 框架，支持 CLI、Slack、Telegram 等多平台接入。

## Core

| 文档 | 说明 |
|------|------|
| [Configuration](./configuration.md) | `jar.toml` 配置布局、provider 选择与运行时行为 |
| [Agent Runtime](./agent-runtime.md) | 工作区启动流程、source-first 包边界、thread/lane 执行模型、hooks 与事件处理 |
| [Sessions](./sessions.md) | Thread/lane 持久化、tape truth、checkpoint 与 turn/run/item 审计记录 |
| [Compaction Architecture](./compaction-architecture.md) | 分阶段压缩流水线、checkpoint 恢复、summary retry 与 runtime 集成 |

## Subsystems

| 文档 | 说明 |
|------|------|
| [Tools](./tools.md) | 内置工具定义、参数形状、返回值与工作区安全规则 |
| [Memory](./memory.md) | 长期记忆 provider 模型、per-entity 隔离、filesystem 存储与记忆工具 |
| [Skills](./skills.md) | Skill 发现、catalog 渲染、显式 per-turn 注入与持久化规则 |

## Gateways & Surfaces

| 文档 | 说明 |
|------|------|
| [Slack Gateway](./slack-gateway.md) | Slack Socket Mode gateway、thread/lane 映射与 channel 上下文规则 |
| [Telegram Gateway](./telegram-gateway.md) | Telegram long polling gateway、触发规则、chat/thread 映射与 streaming 回复 |
| [TUI](./tui.md) | Ink-based `--repl` 包、布局、键位与渲染边界 |

## Third-Party SDKs

| 文档 | 说明 |
|------|------|
| [WeChat SDK](./wechat-sdk.md) | 微信 iLink API SDK 抽离位置、导出内容与环境变量约定 |

## Internal

| 文档 | 说明 |
|------|------|
| [AGENTS.md](./AGENTS.md) | 面向 AI agent 的代码库导航指引（FileTree、关键路径） |
| [Exec Plans](./exec-plans/) | 大型重构与功能的实施计划存档 |
