# Agent Runtime

This page documents how Jar boots inside the workspace, resolves configuration, assembles the runtime, and streams output.

## Current Shape

Jar 现在支持两类 runtime surface：

1. `apps/jar-cli`：one-shot CLI 和 Ink REPL。
2. `apps/jar-slack`：基于 Slack Socket Mode 的 Slack gateway。
3. `apps/jar-telegram`：基于 grammY long polling 的 Telegram gateway。

CLI invocation 现在统一走 ingress command 流程：

1. Parses CLI arguments.
2. Loads `apps/jar-cli/jar.toml`.
3. Uses `packages/jar-core` to resolve a `pi-ai` model from `agent.provider` and `agent.model`.
4. Overrides the model `baseUrl` when `provider.<name>.base_url` is configured.
5. Builds a normalized ingress command that carries routing, content, and audit semantics explicitly.
6. Sends that command through `packages/jar-core/src/execution-service.ts`.
7. The execution service creates a `pi-agent-core` `Agent` through `packages/jar-core/src/runtime.ts`, injects tools from `packages/jar-core/src/tools.ts`, and executes via `packages/jar-core/src/prompt-executor.ts`.
8. Either streams assistant text to stdout through the CLI adapter or renders the Ink TUI package (`--repl`).
9. Persists lane tape facts plus turn/run/item and raw event projections through the persistence ports in `packages/jar-core/src/persistence.ts` backed by `packages/jar-core/src/lanes/`.

Slack gateway 的流程不同：

1. Starts an HTTP server in `apps/jar-slack/src/main.ts`.
2. Loads the same `jar.toml` through `packages/jar-core/src/config.ts`.
3. Iterates `platform.slack.identities.*` and starts one Slack Socket Mode runtime per configured identity.
4. Each Slack runtime handles `app_mention` and message events for its own bot connection.
5. On a new `@mention`, the current Slack identity subscribes the thread, collects a bounded window of top-level channel messages before the mention, and composes an observed-context prompt.
6. On follow-up messages inside a subscribed Slack thread, the current identity routes the message into that identity's local thread without rebuilding channel history.
7. Builds a Slack-scoped ingress command and executes it through `packages/jar-core/src/execution-service.ts`.
8. Persists tape/event/checkpoint data plus thread-scoped turn/run/item records through `packages/jar-core/src/lanes/`.
9. Emits summary logs through `packages/jar-core/src/logger.ts` so the request path is readable without replaying raw events.

Telegram gateway 则是：

1. Starts an HTTP health server in `apps/jar-telegram/src/main.ts`.
2. Loads the same `jar.toml` through `packages/jar-core/src/config.ts`.
3. Iterates `platform.telegram.identities.*` and starts one grammY bot per configured identity.
4. Each Telegram bot handles all private chat messages, plus group messages that explicitly mention that bot or reply to that bot's message.
5. Coalesces rapid follow-up messages per chat/topic in memory so long-running LLM turns do not interleave.
6. Builds a Telegram prompt from the current message, optional reply context, and any skipped messages.
7. Builds a Telegram-scoped ingress command and executes it through `packages/jar-core/src/execution-service.ts`.
8. Streams assistant text back to Telegram through `@grammyjs/stream`.
9. Persists tape/event/checkpoint data plus thread-scoped turn/run/item records through `packages/jar-core/src/lanes/`.

## Entrypoint

`apps/jar-cli/src/main.ts` is the CLI entrypoint.

Responsibilities:

- parse `--config` / `-c`, `--repl`, `--thread`, `--list-threads`
- read prompt text from argv or stdin
- load validated config from `packages/jar-core/src/config.ts`
- build normalized ingress commands for one-shot, thread-bound, and side-question requests
- hand execution to `packages/jar-core/src/execution-service.ts`
- forward one-shot runtime output via `apps/jar-cli/src/render-agent-event.ts`
- launch `@hijarvis/jar-repl-ink` when `--repl` is enabled
- exit non-zero when the run fails

The workspace packages are split as follows:

- `packages/jar-core`: ingress normalization, application-layer execution services, runtime assembly, prompt execution policy, TOML config loading, tool registration, and tape-backed thread/lane persistence
- `packages/jar-repl-ink`: Ink UI and TUI state handling
- `apps/jar-cli`: argv parsing, one-shot output rendering, workspace wiring
- `apps/jar-slack`: Slack Socket Mode gateway, observed context collection, and thread-first reply behavior
- `apps/jar-telegram`: grammY-based Telegram gateway, trigger filtering, queue coalescing, and streaming replies

The workspace now uses a source-first runtime model:

- `packages/jar-core` and `packages/jar-repl-ink` export `src/index.ts` directly.
- `apps/jar-cli`, `apps/jar-slack`, and `apps/jar-telegram` execute through `tsx`.
- local development does not require a prebuild step for internal workspace packages before starting an app.

## CLI Contract

Supported forms:

```bash
pnpm dev -- --config ./apps/jar-cli/jar.toml "Read package.json and summarize the scripts."
echo "Run git status and explain the workspace state." | pnpm dev -- --config ./apps/jar-cli/jar.toml
pnpm dev -- --config ./apps/jar-cli/jar.toml --repl
pnpm dev -- --config ./apps/jar-cli/jar.toml --thread my-thread --repl
pnpm dev -- --config ./apps/jar-cli/jar.toml --list-threads
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

`packages/jar-core/src/execution-service.ts` is the shared application-layer execution seam. It:

- accepts a normalized ingress command plus `LoadedRuntimeConfig` and an optional `HookRegistry`
- resolves the target thread from structured ingress routing data instead of relying on adapters to compute thread ids separately
- creates a fresh `Agent` using `config.agent` fields and `createDefaultTools(config.toolOptions)`
- restores the persisted Jar thread from `config.sessions.rootDir`
- creates one explicit `turn` and one `run(kind=act)` for the current request
- injects skills from `config.skills` into each prompt turn; the system prompt catalog overlay is already embedded in `config.agent.systemPromptOverlays` by `loadRuntimeConfig` and is not re-applied here
- sanitizes older persisted user messages so previous memory-excluded contextual fragments do not keep accumulating in future context windows
- appends conversation facts, audit projections, and raw runtime events through separate persistence ports in `packages/jar-core/src/persistence.ts`
- maps the current execution into structured `items` such as `user_input`, `assistant_message`, `tool_call`, `tool_result`, `retry_notice`, and `compaction`
- emits summary logs for prompt/tool boundaries
- executes the prompt using the retry/timeout policy from `config.agent.execution`
- invokes registered hooks at each pipeline stage when a `HookRegistry` is provided (see [Hooks](#hooks) below)
- returns the accumulated assistant text together with `turnId` and `runId` for the caller to post back to the platform

`packages/jar-core/src/ingress.ts` owns the normalized command types and `/btw` parsing. CLI `--thread`, the Ink REPL, Slack, and Telegram all route `/btw <question>` through the same ingress path so the answer reads from the current live in-memory parent thread state without appending a normal persisted turn.

Identity-aware routing now sits above persistence. Adapters provide structured platform scopes; `packages/jar-core/src/ingress.ts` converts those scopes into stable local thread ids. The persistence model keeps thread/lane terminology and does not require a separate routing module before execution.

The current runtime keeps a narrow side-question live-thread registry so `/btw` can ask a one-shot side question from the parent's current in-memory state instead of replaying only persisted lane state. `/btw` is intentionally not a persisted fork, child lane, or multi-turn bubble.

Side-question live-thread captures are registered for the lifetime of an active ingress execution and are unregistered in `execution-service.ts` `finally` cleanup. A lazy 30 minute TTL sweep in the runtime-only registry acts as a backstop if an abnormal path skips explicit unregister.

The default tools (via `createDefaultTools()`) are:

- `read_file`
- `write_file`
- `apply_patch`
- `bash`

`executeSideQuestion()` remains tool-free by default, but direct callers can now opt in a constrained `tools` list for read-only or otherwise safe ephemeral side-question runs.

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

Slack and Telegram gateways additionally emit request-level summary logs. These logs intentionally summarize stage boundaries instead of mirroring every streaming delta, which keeps long-running sessions readable at `info` level. When the execution service is used, the core logs also attach `turnId` and `runId` to prompt/tool stage records.

For side questions, live capture refreshes now happen at snapshot boundaries: agent creation, `message_end`, and post-turn compaction. Streaming `text_delta` events no longer refresh the side-question snapshot, so `/btw` reads the latest completed assistant turn instead of partial token output.

In `--repl` mode, `packages/jar-repl-ink/src/repl.tsx` receives persisted initial messages plus per-turn event callbacks from the CLI adapter and routes those events into an Ink state reducer instead of talking to `Agent` directly. The TUI currently renders:

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

### Core Fault Model

Jar now normalizes runtime failures into a lightweight fault envelope so the root cause stack is preserved while execution context is explicit.

- **Fault**: the root-cause classification (`kind`, `code`, `retryable`, `severity`, `source`, `cause`).
- **FaultEnvelope**: attaches execution context (`phase`, `threadId`, `turnId`, `runId`, `durationMs`).

The pipeline applies a single classification step at the execution boundary and attaches the envelope without rewriting stack traces. Hooks receive the envelope for observability and do not alter control flow.

Key rules:

- Only the ingress boundary attaches the envelope.
- Phases do not wrap errors; they throw the raw cause.
- Logs record `fault` plus a serialized error/cause tree so root stacks remain visible.

## Current Boundaries

Jar is intentionally minimal right now:

- default CLI runs a single prompt per process (multi-turn is available in REPL/thread mode)
- Slack transport exists, but only as a dedicated Socket Mode app in `apps/jar-slack`
- Telegram transport exists as a dedicated grammY long-polling app in `apps/jar-telegram`
- no provider-specific auth refresh flow
- retry behavior is process-local and config-driven, but retry notices are now mirrored into session `items`
- prompt compaction is applied via the `packages/jar-core/src/compaction/` subsystem to keep long conversations within context limits; runtime sanitizes the current materialized lane view, then runs a staged pipeline of snip-style oldest-history trimming, lightweight tool-result reduction, summary compaction, and final payload assembly; summary generation also retries with progressively truncated history if the compaction request itself is too large, and compaction metadata is persisted into lane events/items while the compacted head is recorded as a lane checkpoint rather than as authoritative snapshot truth
- skills catalog overlays are supported, but full skill bodies remain turn-scoped and are not persisted as long-lived system prompt text
- no built-in tools beyond text file IO and shell execution
- hooks are available and exposed as an external plugin API via the plugin system (see [Plugins](./plugins.md))

## Hooks

`packages/jar-core/src/hooks/` provides a typed hook registry that lets callers intercept or observe the execution pipeline without modifying phase functions directly.

### Concepts

The hook system distinguishes two kinds of hooks based on their type signature:

- **Transform hooks** (`out: T`): receive pipeline data, return a (possibly rewritten) version. Executed serially by priority — each handler's output is merged into the next handler's input.
- **Tap hooks** (`out: void`): observe pipeline data without altering it. Executed concurrently via `Promise.allSettled` — individual failures are logged but never propagate.

The `HookMap` interface in `hooks/types.ts` defines all hook points. The TypeScript type system enforces that `registry.transform()` can only be called on transform points and `registry.tap()` only on tap points.

### Hook Points

| Point | Kind | When | Use case |
|---|---|---|---|
| `ingress:before` | transform | Before phase 1 | Rewrite or reject the incoming command |
| `session:loaded` | tap | After phase 2 | Observe session state, inject metadata |
| `prompt:transform` | transform | Before phase 3 | Content moderation, inject dynamic context (time, weather, calendar) |
| `prompt:prepared` | tap | After phase 3 | Prompt logging, token estimation |
| `tools:resolve` | transform | During phase 4 | Add, remove, or reorder tools |
| `tool:before` | transform | Per tool call | Permission checks, argument validation (bridges to `Agent.beforeToolCall`) |
| `tool:after` | transform | Per tool call | Result filtering, audit logging (bridges to `Agent.afterToolCall`) |
| `agent:event` | tap | During streaming | Real-time logging, metrics, event forwarding |
| `response:transform` | transform | Before return | Output moderation, formatting |
| `response:complete` | tap | After return | Analytics, billing, archival |
| `error:caught` | tap | On error | Error reporting, fallback strategies |

### Usage

```typescript
import { createHookRegistry, type HookRegistry } from "@hijarvis/jar-core";

const hooks = createHookRegistry({ logger });

// Inject current time into every prompt
hooks.register({
  point: "prompt:transform",
  name: "inject-datetime",
  priority: 50,
  handler: ({ prompt, skillTriggerText }) => ({
    prompt: `[Current time: ${new Date().toISOString()}]\n\n${prompt as string}`,
    skillTriggerText,
  }),
});

// Block sensitive bash commands
hooks.register({
  point: "tool:before",
  name: "permission-guard",
  priority: 10,
  handler: (ctx) => {
    if (ctx.toolCall.name === "bash") {
      return { block: true, reason: "Bash is disabled" };
    }
    return undefined;
  },
});

// Pass to execution
await executeIngressCommand({ config, command, hooks });
```

### Integration

The `hooks` parameter is optional on `executeIngressCommand()`. When omitted, no hook overhead is incurred — the pipeline skips all hook call sites via `hooks?.has()` guards.

Tool-level hooks (`tool:before`, `tool:after`) bridge directly into the upstream `pi-agent-core` `Agent.beforeToolCall` / `Agent.afterToolCall` callbacks rather than wrapping tool functions. This preserves the agent's native abort signal propagation and streaming update mechanism.

### Files

- `packages/jar-core/src/hooks/types.ts` — `HookMap`, `HookPoint`, `HookHandler`, `HookRegistration`, `HookRegistry`, `TransformHookPoint`, `TapHookPoint`
- `packages/jar-core/src/hooks/registry.ts` — `createHookRegistry()` implementation
- `packages/jar-core/src/hooks/index.ts` — unified re-exports

## Session Execution Model

Jar 现在正在显式收敛到五层执行对象：

- `thread`: 一个稳定的对话范围标识，例如一个 Slack thread 或 Telegram chat/topic 所映射出的本地容器
- `lane`: thread 内的一条执行线。当前主路径只有一个 `main` lane；lane 仍然是持久化 truth 的边界，而不是 `/btw` 这类一次性 side question 的生命周期容器。
- `tape`: lane 的 append-only 事实流，作为恢复与未来 fork 的 canonical truth。
- `turn`: 一次输入触发的一单位工作。
- `run`: 某个 `turn` 的一次具体执行；当前默认只有一个 `run(kind=act)`。
- `item`: `run` 内的细粒度审计记录，例如 assistant delta、tool 调用、retry 通知、compaction。

当前实现里：

- `tape.jsonl` 正在成为上下文恢复的主来源
- `head.json` 如果存在，也只是 derived cache，不是 source of truth
- `turns.jsonl`、`runs.jsonl`、`items.jsonl` 只承担执行审计与后续扩展职责
- `events.jsonl` 继续保留原始底层事件流，不被 `items` 取代

If any of these behaviors change, update this document together with `apps/jar-cli/src/main.ts`, `packages/jar-core/src/runtime.ts`, and any affected adapter package.

## 会话与 REPL

Jar 支持在 `--repl` 或 `--thread` 模式下进行多轮会话。`--repl` 现在由 Ink 驱动，负责输入、状态栏、tool activity 与 diagnostics 面板；底层正常执行路径已经切到 tape-backed lane substrate。详情参见 [Sessions](./sessions.md) 和 [TUI](./tui.md)。
