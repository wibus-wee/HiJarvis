# Agent Runtime

This page documents how Jar boots inside the workspace, resolves configuration, assembles the runtime, and streams output.

## Current Shape

Jar 现在支持两类 runtime surface：

1. `apps/jar-cli`：one-shot CLI 和 Ink REPL。
2. `apps/jar-slack`：基于 Slack Socket Mode 的 Slack gateway。
3. `apps/jar-telegram`：基于 grammY long polling 的 Telegram gateway。
4. `apps/jar-wechat`：基于 `@pinixai/weixin-bot` long polling 的 WeChat gateway。

CLI invocation 仍然保持原有流程：

1. Parses CLI arguments.
2. Loads `apps/jar-cli/jar.toml`.
3. Uses `packages/jar-core` to resolve a `pi-ai` model from `agent.provider` and `agent.model`.
4. Overrides the model `baseUrl` when `provider.<name>.base_url` is configured.
5. Builds the tool list from `packages/jar-core/src/tools.ts`.
6. Creates a `pi-agent-core` `Agent`.
7. Executes prompts via `packages/jar-core/src/prompt-executor.ts` for one-shot runs, or `packages/jar-core/src/session-executor.ts` when `--session` is used.
8. Either streams assistant text to stdout through the CLI adapter or renders the Ink TUI package (`--repl`).
9. Optionally persists session transcripts plus turn/run/item execution records through `packages/jar-core/src/session-store.ts`.

Slack gateway 的流程不同：

1. Starts an HTTP server in `apps/jar-slack/src/main.ts`.
2. Loads the same `jar.toml` through `packages/jar-core/src/config.ts`.
3. Starts a Socket Mode connection using Slack Web API credentials.
4. Handles `app_mention` and DM message events.
5. On a new `@mention`, subscribes the Slack thread, collects a bounded window of top-level channel messages before the mention, and composes an observed-context prompt.
6. On follow-up messages inside a subscribed Slack thread, routes the message into the same Jar session without rebuilding channel history.
7. Executes the turn through `packages/jar-core/src/session-executor.ts`.
8. Persists transcript/event/snapshot data plus session-scoped turn/run/item records through the same `packages/jar-core/src/session-store.ts`.
9. Emits summary logs through `packages/jar-core/src/logger.ts` so the request path is readable without replaying raw events.

Telegram gateway 则是：

1. Starts an HTTP health server in `apps/jar-telegram/src/main.ts`.
2. Loads the same `jar.toml` through `packages/jar-core/src/config.ts`.
3. Starts a grammY bot in long polling mode.
4. Handles all private chat messages, plus group messages that explicitly mention the bot or reply to a bot message.
5. Coalesces rapid follow-up messages per chat/topic in memory so long-running LLM turns do not interleave.
6. Builds a Telegram prompt from the current message, optional reply context, and any skipped messages.
7. Executes the turn through `packages/jar-core/src/session-executor.ts`.
8. Streams assistant text back to Telegram through `@grammyjs/stream`.
9. Persists transcript/event/snapshot data plus session-scoped turn/run/item records through the same `packages/jar-core/src/session-store.ts`.

WeChat gateway 则是：

1. Starts an HTTP health server in `apps/jar-wechat/src/main.ts`.
2. Loads the same `jar.toml` through `packages/jar-core/src/config.ts`.
3. Starts a `WeixinBot`, performs QR login when needed, then enters SDK-managed long polling.
4. Handles inbound WeChat direct messages from `bot.onMessage()`.
5. Coalesces rapid follow-up messages per user in memory so long-running LLM turns do not interleave.
6. Builds a WeChat prompt from the current message and any skipped messages.
7. Executes the turn through `packages/jar-core/src/session-executor.ts`.
8. Posts the final assistant text back through `bot.reply()`, with typing indicators around the LLM turn.
9. Persists transcript/event/snapshot data plus session-scoped turn/run/item records through the same `packages/jar-core/src/session-store.ts`.

## Entrypoint

`apps/jar-cli/src/main.ts` is the CLI entrypoint.

Responsibilities:

- parse `--config` / `-c`, `--repl`, `--session`, `--list-sessions`
- read prompt text from argv or stdin
- load validated config from `packages/jar-core/src/config.ts`
- create the runtime `Agent` via `packages/jar-core/src/runtime.ts`
- subscribe to runtime events
- execute prompts through `packages/jar-core/src/prompt-executor.ts`
- forward one-shot runtime output via `apps/jar-cli/src/render-agent-event.ts`
- launch `@hijarvis/jar-repl-ink` when `--repl` is enabled
- exit non-zero when the run fails

The workspace packages are split as follows:

- `packages/jar-core`: runtime assembly (substrate primitives + convenience APIs), prompt execution policy, TOML config loading, tool registration, session persistence
- `packages/jar-repl-ink`: Ink UI and TUI state handling
- `apps/jar-cli`: argv parsing, one-shot output rendering, workspace wiring
- `apps/jar-slack`: Slack Socket Mode gateway, observed context collection, and thread-first reply behavior
- `apps/jar-telegram`: grammY-based Telegram gateway, trigger filtering, queue coalescing, and streaming replies
- `apps/jar-wechat`: Weixin bot gateway, per-user queue coalescing, and final-text replies

The workspace now uses a source-first runtime model:

- `packages/jar-core` and `packages/jar-repl-ink` export `src/index.ts` directly.
- `apps/jar-cli`, `apps/jar-slack`, `apps/jar-telegram`, and `apps/jar-wechat` execute through `tsx`.
- local development does not require a prebuild step for internal workspace packages before starting an app.

## CLI Contract

Supported forms:

```bash
pnpm dev -- --config ./apps/jar-cli/jar.toml "Read package.json and summarize the scripts."
echo "Run git status and explain the workspace state." | pnpm dev -- --config ./apps/jar-cli/jar.toml
pnpm dev -- --config ./apps/jar-cli/jar.toml --repl
pnpm dev -- --config ./apps/jar-cli/jar.toml --session my-session --repl
pnpm dev -- --config ./apps/jar-cli/jar.toml --list-sessions
```

Rules:

- if no prompt is provided in argv, Jar tries stdin
- if neither argv nor stdin provides a prompt, Jar prints usage and exits with an error
- `--help` and `-h` print usage and exit successfully
- `--repl` requires a TTY stdin

## Config Loading Flow

`packages/jar-core/src/config.ts` exposes two levels of config loading:

- `loadBaseConfig()`: parses TOML, validates schema, resolves paths, returns `skillsConfig` without resolving skills runtime — suitable for callers that want to control skill discovery separately.
- `loadRuntimeConfig()`: convenience wrapper that calls `loadBaseConfig()` + `resolveSkillsFromConfig()`, returning a fully resolved config with skills and `systemPromptOverlays` ready to use.

The validation stages are:

1. Parse TOML with `smol-toml`.
2. Validate structure with `zod`.

After schema validation, runtime-specific checks happen:

- `agent.provider` must exist in `pi-ai`'s known provider list
- `agent.model` must exist for the selected provider
- only the selected provider config under `provider.<name>` is validated for provider-specific fields
- tool limits such as `max_file_bytes` and `command_timeout_ms` must be positive integers
- retry and timeout values must satisfy policy constraints (for example, `retry_max_delay_ms >= retry_initial_delay_ms`)

Adapter-specific tables are validated when each adapter starts:

- Slack: `apps/jar-slack/src/slack-config.ts`
- Telegram: `apps/jar-telegram/src/telegram-config.ts`
- WeChat: `apps/jar-wechat/src/wechat-config.ts`

## Model Resolution

Jar does not construct custom `pi-ai` models from scratch.

Instead it:

1. Uses `getModels(provider)` to fetch the built-in model registry.
2. Finds the configured model id.
3. Clones the selected model and overrides `baseUrl` when needed.

That keeps provider/model metadata aligned with `pi-ai` while still allowing custom gateways and proxies.

## Agent Construction

`packages/jar-core/src/runtime.ts` currently creates a single `pi-agent-core` `Agent` instance per run with:

- `systemPrompt`, assembled through `packages/jar-core/src/prompt-builder.ts`
- `systemPromptOverlays`: generic `PromptSection[]` fragments appended to the base system prompt (e.g. skills catalog). `createAgent()` does not know about skills — it only receives prompt overlays.
- resolved `model`
- `thinkingLevel`
- injected `tools` (caller provides the tool array; `createAgent()` does not create tools itself)
- `maxRetryDelayMs` derived from config
- `getApiKey()` that only returns the configured API key for the active provider

Prompt assembly is now split into two layers:

- `buildSystemPrompt()`: owns the final system prompt text handed to `pi-agent-core`. It wraps the configured base prompt and appends generic `systemPromptOverlays`.
- `buildTurnPrompt()`: owns adapter-level per-turn text assembly. Adapters such as Slack use it to compose observed context, queued follow-up messages, and the current user request without mutating the system prompt.
- `resolveSkillPromptContext()`: owns skill discovery for the current turn. It only reacts to `$skill-name` mentions from the trigger text supplied by the caller and returns typed skill fragments.
- `prompt-context.ts`: owns contextual fragment rendering, prompt injection, and memory-excluded cleanup before persistence or compaction.
- `getSkillsCatalogOverlays()`: convenience helper that converts a `SkillsRuntime` catalog into `PromptSection[]` for passing to `createAgent()`.

`packages/jar-core/src/session-executor.ts` is the shared session-bound execution seam (convenience API). It:

- accepts a single `config: LoadedRuntimeConfig` object instead of individual agent fields — callers do not need to spread or duplicate any agent configuration
- creates a fresh `Agent` using `config.agent` fields and `createDefaultTools(config.toolOptions)`
- restores the persisted Jar session from `config.sessions.rootDir`
- creates one explicit `turn` and one `run(kind=act)` for the current request
- injects skills from `config.skills` into each prompt turn; the system prompt catalog overlay is already embedded in `config.agent.systemPromptOverlays` by `loadRuntimeConfig` and is not re-applied here
- sanitizes older persisted user messages so previous memory-excluded contextual fragments do not keep accumulating in future context windows
- appends runtime events/messages back into the session store
- maps the current execution into structured `items` such as `user_input`, `assistant_message`, `tool_call`, `tool_result`, `retry_notice`, and `compaction`
- emits summary logs for prompt/tool boundaries
- executes the prompt using the retry/timeout policy from `config.agent.execution`
- returns the accumulated assistant text together with `turnId` and `runId` for the caller to post back to the platform

The default tools (via `createDefaultTools()`) are:

- `read_file`
- `write_file`
- `apply_patch`
- `bash`

Non-selected provider configs are ignored at runtime.

## Event Handling

In one-shot mode, `apps/jar-cli/src/main.ts` subscribes to the agent event stream and `apps/jar-cli/src/render-agent-event.ts` renders a minimal subset:

- `message_update.text_delta`: written to stdout
- `tool_execution_start`: logged to stderr
- `tool_execution_end`: logged to stderr

Jar does not currently render:

- full event traces
- usage or token stats
- tool partial updates
- structured reasoning blocks
- persisted transcripts

Slack, Telegram, and WeChat gateways additionally emit request-level summary logs. These logs intentionally summarize stage boundaries instead of mirroring every streaming delta, which keeps long-running sessions readable at `info` level. When the execution seam is used, the core logs also attach `turnId` and `runId` to prompt/tool stage records.

In `--repl` mode, `packages/jar-repl-ink/src/repl.tsx` subscribes to the same event stream but routes it into an Ink state reducer instead of writing directly to stdout/stderr. The TUI currently renders:

- persisted transcript history from the restored session
- streaming assistant text
- tool execution status and latest partial/result payloads
- prompt retry/error diagnostics produced by `packages/jar-core/src/prompt-executor.ts`

## Error Behavior

Errors can come from several layers:

- CLI parsing
- TOML parsing
- config validation
- model lookup
- tool execution
- provider/API errors

`apps/jar-cli/src/main.ts` catches the final error, writes the message to stderr, and sets a non-zero exit code.

`packages/jar-core/src/prompt-executor.ts` classifies failures into categories (`timeout`, `rate_limit`, `network`, `auth`, `input`, `tool`, `aborted`, `unknown`) and retries retryable failures using exponential backoff. Upstream `5xx` responses, including HTML error pages returned by reverse proxies such as Cloudflare, are treated as retryable `network` failures rather than terminal `input` errors.

## Current Boundaries

Jar is intentionally minimal right now:

- default CLI runs a single prompt per process (multi-turn is available in REPL/session mode)
- Slack transport exists, but only as a dedicated Socket Mode app in `apps/jar-slack`
- Telegram transport exists as a dedicated grammY long-polling app in `apps/jar-telegram`
- WeChat transport exists as a dedicated `@pinixai/weixin-bot` long-polling app in `apps/jar-wechat`
- no provider-specific auth refresh flow
- retry behavior is process-local and config-driven, but retry notices are now mirrored into session `items`
- prompt compaction is applied via the `packages/jar-core/src/compaction/` subsystem to keep long sessions within context limits; runtime first slices history from the snapshot-backed compaction boundary, then sanitizes that history, then runs a staged pipeline that may apply snip-style oldest-history trimming, lightweight tool-result reduction, automatic partial-or-full summary compaction, and final payload assembly; summary generation also retries with progressively truncated history if the compaction request itself is too large, and the subsystem now restores structured artifacts such as recent tool-state and skill-state cues into the compacted payload while persisting compaction metadata into session events/items and snapshot boundary state
- skills catalog overlays are supported, but full skill bodies remain turn-scoped and are not persisted as long-lived system prompt text
- no built-in tools beyond text file IO and shell execution

## Session Execution Model

Jar 现在显式区分四层执行对象：

- `session`: 长期持久化的会话容器，也是恢复模型上下文的边界
- `turn`: 一次输入触发的一单位工作
- `run`: 某个 `turn` 的一次具体执行；当前默认只有一个 `run(kind=act)`
- `item`: `run` 内的细粒度审计记录，例如 assistant delta、tool 调用、retry 通知、compaction

当前实现里：

- `messages.jsonl` 和 `session.json` 仍然是上下文恢复的唯一来源
- `turns.jsonl`、`runs.jsonl`、`items.jsonl` 只承担执行审计与后续扩展职责
- `events.jsonl` 继续保留原始底层事件流，不被 `items` 取代

If any of these behaviors change, update this document together with `apps/jar-cli/src/main.ts`, `packages/jar-core/src/runtime.ts`, and any affected adapter package.

## 会话与 REPL

Jar 支持在 `--repl` 或 `--session` 模式下进行多轮会话。`--repl` 现在由 Ink 驱动，负责输入、状态栏、tool activity 与 diagnostics 面板；会话内容仍以 JSONL 追加写入，并在会话结束时写入快照以加速恢复。详情参见 [Sessions](./sessions.md) 和 [TUI](./tui.md)。
