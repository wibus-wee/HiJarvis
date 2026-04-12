# Sessions

Jar 现在使用 tape-backed lane 模型。正常执行路径的主语已经不是“把 `session.json` 当作真相再恢复”，而是“把 append-only tape 当作真相，再 materialize 当前 lane view”。

如果你需要看“当前这一次请求到底跑到了哪一步”，现在有三层资料可看：

- 运行摘要日志：适合开发排障，强调链路边界和可读性。
- lane 内的 `turns.jsonl` / `runs.jsonl` / `items.jsonl`：适合看一次请求的结构化执行轨迹。
- lane 内的 `tape.jsonl` 与 `events.jsonl`：适合深度调试和回放事实流，其中 tape 是恢复与未来分叉的核心事实流，events 仍然更偏底层审计。

## 当前目录结构

新的主路径是 thread/lane 结构：

- `threads/<threadId>/meta.json`: thread 元信息，例如当前活跃 lane。
- `threads/<threadId>/lanes/main/meta.json`: lane 元信息。
- `threads/<threadId>/lanes/main/tape.jsonl`: append-only tape，作为当前 conversation truth。
- `threads/<threadId>/lanes/main/head.json`: 派生缓存，只用于加速与调试，不是 source of truth。
- `threads/<threadId>/lanes/main/events.jsonl`: 底层事件流审计。
- `threads/<threadId>/lanes/main/turns.jsonl`: turn 级结构化记录。
- `threads/<threadId>/lanes/main/runs.jsonl`: run 级结构化记录。
- `threads/<threadId>/lanes/main/items.jsonl`: item 级细粒度执行记录。

第一版 lane runtime 只支持一个 `main` lane。这里先把 lane 抽象建立起来，是为了让未来可以从 live lane fork 出临时分支，而不是继续把“整个当前上下文”绑定在一个可变 snapshot 文件上。

## Tape 与恢复

Tape 是 append-only 的事实流。正常用户消息、assistant 最终消息、以及 compaction checkpoint 都会追加到 `tape.jsonl`。恢复时，系统从 tape materialize 当前 lane view，而不是把 `head.json` 当真相读回来。

现在的关键语义是：

- `tape.jsonl` 是 canonical truth。
- `head.json` 是 derived cache。
- `turns.jsonl` / `runs.jsonl` / `items.jsonl` 是审计投影。
- `events.jsonl` 是底层事件审计，不是恢复真相。

这和旧模型不同。旧模型里，`session.json` 与 `messages.jsonl` 共同承担恢复职责；新模型里，恢复应该围绕 tape 和 lane checkpoint 发生。

## Checkpoint

compaction 不再意味着“把整个当前上下文重写进一个权威 snapshot 文件”。在新的 lane 模型里，compaction 的持久化目标是 lane checkpoint，也就是 tape 上的一条重建边界记录。

简化理解：

- 历史事实仍然保留在 tape 上。
- checkpoint 只是告诉 materializer：“可以从这里开始重建，而不必从头全扫。”
- checkpoint 带来的 `headMessages` 是派生重建状态，不是覆盖历史。

## 审计层

`turns.jsonl`、`runs.jsonl`、`items.jsonl` 仍然保留，因为它们对调试和未来扩展有价值。但它们现在更明确地是审计层，而不是恢复层。

当前执行对象仍然是：

- `thread`: 一个稳定的对话范围标识
- `lane`: thread 内的一条执行线；当前只有 `main`
- `turn`: 一次输入触发的一单位工作
- `run`: 某个 turn 的一次具体执行
- `item`: run 内的细粒度审计记录

## CLI 使用

```bash
pnpm dev -- --config ./apps/jar-cli/jar.toml --repl
pnpm dev -- --config ./apps/jar-cli/jar.toml --thread my-thread --repl
pnpm dev -- --config ./apps/jar-cli/jar.toml --thread my-thread "Continue this thread"
pnpm dev -- --config ./apps/jar-cli/jar.toml --list-threads
```

CLI 现在使用 `--thread` 明确表达持久化容器选择。
