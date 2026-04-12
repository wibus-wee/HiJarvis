# Jar Documentation Index

- [Configuration](./configuration.md): `jar.toml` layout, provider selection, and runtime behavior.
- [Agent Runtime](./agent-runtime.md): workspace startup flow, source-first package boundaries, thread/lane-bound turn/run/item execution, model resolution, and event handling.
- [Compaction Architecture](./compaction-architecture.md): simplified staged compaction pipeline, checkpoint-based recovery, PTL retry, and runtime/thread-lane integration.
- [Memory](./memory.md): long-term memory provider model, per-entity scoping, filesystem storage, and memory tool behavior.
- [Exec Plans](./exec-plans/): living implementation plans for major refactors and features, including subsystem redesign work such as compaction.
- [Skills](./skills.md): skill discovery roots, catalog rendering, explicit per-turn skill injection, and persistence rules.
- [Slack Gateway](./slack-gateway.md): Slack Socket Mode gateway, thread/lane mapping, and observed channel context rules.
- [Telegram Gateway](./telegram-gateway.md): Telegram long polling gateway, trigger rules, chat/thread mapping, and streaming reply behavior.
- [WeChat SDK](./wechat-sdk.md): 微信 iLink API SDK 抽离位置、导出内容与环境变量约定。
- [TUI](./tui.md): Ink-based `--repl` package, layout, keyboard behavior, and rendering boundaries.
- [Tools](./tools.md): built-in tool definitions, parameter shapes, return values, and workspace safety rules in `packages/jar-core`.
- [Sessions](./sessions.md): thread/lane 持久化、tape truth、checkpoint 与 turn/run/item 审计记录。
