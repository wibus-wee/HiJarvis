# Agent Runtime

This page documents how Jar boots inside the workspace, resolves configuration, assembles the runtime, and streams output.

## Current Shape

Jar supports both one-shot runs and multi-turn sessions. Each invocation:

1. Parses CLI arguments.
2. Loads `apps/jar-cli/jar.toml`.
3. Uses `packages/jar-core` to resolve a `pi-ai` model from `agent.provider` and `agent.model`.
4. Overrides the model `baseUrl` when `provider.<name>.base_url` is configured.
5. Builds the tool list from `packages/jar-core/src/tools.ts`.
6. Creates a `pi-agent-core` `Agent`.
7. Executes prompts via `packages/jar-core/src/prompt-executor.ts`.
8. Either streams assistant text to stdout through the CLI adapter or renders the Ink TUI package (`--repl`).
9. Optionally persists session transcripts and event logs through `packages/jar-core/src/session-store.ts`.

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

- `packages/jar-core`: runtime assembly, prompt execution policy, TOML config loading, tool registration, session persistence
- `packages/jar-repl-ink`: Ink UI and TUI state handling
- `apps/jar-cli`: argv parsing, one-shot output rendering, workspace wiring

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

`packages/jar-core/src/config.ts` performs two validation stages:

1. Parse TOML with `smol-toml`.
2. Validate structure with `zod`.

After schema validation, runtime-specific checks happen:

- `agent.provider` must exist in `pi-ai`'s known provider list
- `agent.model` must exist for the selected provider
- only the selected provider config under `provider.<name>` is validated for provider-specific fields
- tool limits such as `max_file_bytes` and `command_timeout_ms` must be positive integers
- retry and timeout values must satisfy policy constraints (for example, `retry_max_delay_ms >= retry_initial_delay_ms`)

## Model Resolution

Jar does not construct custom `pi-ai` models from scratch.

Instead it:

1. Uses `getModels(provider)` to fetch the built-in model registry.
2. Finds the configured model id.
3. Clones the selected model and overrides `baseUrl` when needed.

That keeps provider/model metadata aligned with `pi-ai` while still allowing custom gateways and proxies.

## Agent Construction

`packages/jar-core/src/runtime.ts` currently creates a single `pi-agent-core` `Agent` instance per run with:

- `systemPrompt`
- resolved `model`
- `thinkingLevel`
- built-in tools from `packages/jar-core/src/tools.ts`
- `maxRetryDelayMs` derived from config
- `getApiKey()` that only returns the configured API key for the active provider

The current built-in tools are:

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

`packages/jar-core/src/prompt-executor.ts` classifies failures into categories (`timeout`, `rate_limit`, `network`, `auth`, `input`, `tool`, `aborted`, `unknown`) and retries retryable failures using exponential backoff.

## Current Boundaries

Jar is intentionally minimal right now:

- default CLI runs a single prompt per process (multi-turn is available in REPL/session mode)
- no custom transport logic
- no provider-specific auth refresh flow
- retry behavior is process-local and config-driven; there is no persisted retry history
- no prompt compaction or transcript pruning
- no built-in tools beyond text file IO and shell execution

If any of these behaviors change, update this document together with `apps/jar-cli/src/main.ts`, `packages/jar-core/src/runtime.ts`, and any affected adapter package.

## 会话与 REPL

Jar 支持在 `--repl` 或 `--session` 模式下进行多轮会话。`--repl` 现在由 Ink 驱动，负责输入、状态栏、tool activity 与 diagnostics 面板；会话内容仍以 JSONL 追加写入，并在会话结束时写入快照以加速恢复。详情参见 [Sessions](./sessions.md) 和 [TUI](./tui.md)。
