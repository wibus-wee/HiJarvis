# Sessions

Jar 现在支持基于 `jsonl` 的会话持久化，用于多轮对话、会话恢复以及审计。

默认情况下，只有在启用 `--repl` 或显式传入 `--session` 时才会创建会话目录。`--repl` 现在使用 Ink TUI，但底层会话写入机制没有变化。

如果你需要看“当前这一次请求到底跑到了哪一步”，优先看运行摘要日志；如果你需要还原底层事实，再看 session 目录。两者职责不同：

- 运行摘要日志：适合开发排障，强调链路边界和可读性。
- `events.jsonl`: 适合深度调试和回放，事件更细，但不适合作为日常开发控制台。

## 目录结构

每个会话对应一个目录，包含以下文件：

- `messages.jsonl`: 逐行追加的消息记录，作为可恢复的主日志
- `session.json`: 会话快照，包含完整消息数组与最后序号
- `meta.json`: 会话元信息（创建时间、最近更新时间、模型与 provider）
- `events.jsonl`: 事件记录（包含 streaming 增量、tool 执行事件、以及 compaction 事件），用于回放或调试，不参与会话恢复

## JSONL 记录结构

`messages.jsonl` 采用一行一个 JSON 对象的形式：

```json
{"v":1,"type":"message","sessionId":"sess_20260406_120000_abcd12","sequence":1,"recordedAt":1775400000000,"message":{"role":"user","content":"Hello","timestamp":1775400000000}}
```

## 快照策略

会话结束时会写入 `session.json` 快照，用于加速恢复。

恢复时优先读取快照，再从 `messages.jsonl` 追加序号更大的记录。

## streaming 与恢复

`messages.jsonl` 只保存最终消息，因此“恢复”指的是恢复模型上下文的真实状态，而不是复现当时的 streaming 动画。

如果需要回放 streaming 过程，使用 `events.jsonl`。它记录了 `message_update`、`tool_execution_*` 以及 `compaction` 等事件，但这些事件不会影响会话恢复的上下文。

## CLI 使用

```bash
pnpm dev -- --config ./apps/jar-cli/jar.toml --repl
pnpm dev -- --config ./apps/jar-cli/jar.toml --session my-session --repl
pnpm dev -- --config ./apps/jar-cli/jar.toml --session my-session "Continue this session"
pnpm dev -- --config ./apps/jar-cli/jar.toml --list-sessions
```
