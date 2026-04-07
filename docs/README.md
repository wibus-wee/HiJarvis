# Jar Documentation Index

- [Configuration](./configuration.md): `jar.toml` layout, provider selection, and runtime behavior.
- [Agent Runtime](./agent-runtime.md): workspace startup flow, source-first package boundaries, model resolution, and event handling.
- [Skills](./skills.md): skill discovery roots, catalog rendering, explicit per-turn skill injection, and persistence rules.
- [Slack Gateway](./slack-gateway.md): Slack Socket Mode gateway, thread/session mapping, and observed channel context rules.
- [Telegram Gateway](./telegram-gateway.md): Telegram long polling gateway, trigger rules, chat/session mapping, and streaming reply behavior.
- [WeChat Gateway](./wechat-gateway.md): Weixin bot gateway, direct-chat session mapping, and per-user queue behavior.
- [TUI](./tui.md): Ink-based `--repl` package, layout, keyboard behavior, and rendering boundaries.
- [Tools](./tools.md): built-in tool definitions, parameter shapes, return values, and workspace safety rules in `packages/jar-core`.
- [Sessions](./sessions.md): 会话持久化、JSONL 记录与快照机制。
