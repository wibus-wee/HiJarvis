# Jar Documentation Index

- [Configuration](./configuration.md): `jar.toml` layout, provider selection, and runtime behavior.
- [Agent Runtime](./agent-runtime.md): workspace startup flow, source-first package boundaries, session-bound turn/run/item execution, model resolution, and event handling.
- [Compaction Architecture](./compaction-architecture.md): snapshot-backed boundary, staged compaction pipeline, automatic partial compaction, PTL retry, artifact restoration, and runtime/session integration.
- [Exec Plans](./exec-plans/): living implementation plans for major refactors and features, including subsystem redesign work such as compaction.
- [Skills](./skills.md): skill discovery roots, catalog rendering, explicit per-turn skill injection, and persistence rules.
- [Slack Gateway](./slack-gateway.md): Slack Socket Mode gateway, thread/session mapping, and observed channel context rules.
- [Telegram Gateway](./telegram-gateway.md): Telegram long polling gateway, trigger rules, chat/session mapping, and streaming reply behavior.
- [WeChat Gateway](./wechat-gateway.md): Weixin bot gateway, direct-chat session mapping, and per-user queue behavior.
- [WeChat SDK](./wechat-sdk.md): 微信 iLink API SDK 抽离位置、导出内容与环境变量约定。
- [TUI](./tui.md): Ink-based `--repl` package, layout, keyboard behavior, and rendering boundaries.
- [Tools](./tools.md): built-in tool definitions, parameter shapes, return values, and workspace safety rules in `packages/jar-core`.
- [Sessions](./sessions.md): 会话持久化、turn/run/item 审计记录与快照机制。
