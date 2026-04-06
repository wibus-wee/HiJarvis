# Configuration

Jar is a minimal Node.js CLI agent built on `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core`.

This page focuses on `jar.toml`. For runtime flow and tool behavior, see:

- [Agent Runtime](./agent-runtime.md)
- [Tools](./tools.md)

## Run

```bash
pnpm dev -- --config ./apps/jar-cli/jar.toml "Read package.json and summarize the scripts."
```

You can also pipe the prompt through stdin:

```bash
echo "Run git status and explain the workspace state." | pnpm dev -- --config ./apps/jar-cli/jar.toml
```

## Config Layout

`jar.toml` uses three top-level tables:

```toml
[agent]
provider = "openai"
model = "gpt-4o-mini"
system_prompt = """
You are Jarvis, a concise local coding assistant.
Use tools when they materially improve accuracy.
"""
thinking_level = "minimal"
request_timeout_ms = 120000
retry_attempts = 5
retry_initial_delay_ms = 1000
retry_backoff_multiplier = 2
retry_max_delay_ms = 30000

[provider.openai]
api_key = "replace-me"
base_url = "https://api.openai.com/v1"

[tools]
workspace_root = "."
max_file_bytes = 32768
command_timeout_ms = 30000
max_command_output_bytes = 32768

[sessions]
root_dir = ".jar/sessions"
```

## Field Reference

### `[agent]`

- `provider`: active provider name. Must be one of the providers returned by `pi-ai`.
- `model`: model id for the selected provider.
- `system_prompt`: system prompt sent on every run.
- `thinking_level`: one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Default: `minimal`.
- `request_timeout_ms`: timeout for each prompt attempt before Jar aborts the in-flight run. Default: `120000`.
- `retry_attempts`: number of retries after the first failed attempt. Default: `5`.
- `retry_initial_delay_ms`: initial backoff delay before retry #1. Default: `1000`.
- `retry_backoff_multiplier`: exponential multiplier applied to each retry delay. Default: `2`.
- `retry_max_delay_ms`: upper bound for retry delay and provider-suggested retry waits. Default: `30000`.

### `[provider.<name>]`

- `api_key`: optional provider API key. If omitted, `pi-ai` falls back to provider-specific environment variables.
- `base_url`: optional endpoint override. Useful for OpenAI-compatible gateways, proxies, and local model servers.

`agent.provider` selects which provider sub-table is used at runtime. For example, when `agent.provider = "openai"`, Jar reads only `[provider.openai]`.

Inactive provider tables are allowed. They are ignored until selected by `agent.provider`.

### `[tools]`

- `workspace_root`: root directory exposed to the file tools and the default starting directory for the shell tool. Relative paths are resolved from the config file directory. Default: `"."`.
- `max_file_bytes`: maximum UTF-8 size accepted by `read_file`, `write_file`, and any file content produced by `apply_patch`. Default: `32768`.
- `command_timeout_ms`: shell command timeout in milliseconds. Default: `30000`.
- `max_command_output_bytes`: maximum buffered stdout/stderr captured from `bash`. Default: `32768`.

### `[sessions]`

- `root_dir`: 会话存储目录。相对路径会以配置文件所在目录为基准。默认：`.jar/sessions`。

## Runtime Notes

- `apps/jar-cli/src/main.ts` loads the config from `@hijarvis/jar-node` and wires it into `@hijarvis/jar-runtime`.
- `packages/jar-runtime/src/runtime.ts` resolves the selected `pi-ai` model and overrides `model.baseUrl` when `provider.<name>.base_url` is set.
- `apps/jar-cli/src/main.ts` and `packages/jar-repl-ink/src/repl.tsx` use the same prompt execution policy for timeout, retry, and error classification.
- `packages/jar-runtime/src/runtime.ts` forwards `agent.retry_max_delay_ms` to `Agent.maxRetryDelayMs`.
- `packages/jar-runtime/src/runtime.ts` passes `provider.<name>.api_key` through `Agent.getApiKey()` for the active provider only.
- Tool registration is handled in `packages/jar-node/src/tools.ts`.
- Built-in tool behavior and restrictions are documented in [Tools](./tools.md).

## Validation

Config parsing is implemented in `packages/jar-node/src/config.ts` using `smol-toml` for TOML parsing and `zod` for schema validation.

Validation happens in two stages:

1. Validate the top-level TOML shape.
2. Validate the active provider config selected by `agent.provider`.

Common failure cases:

- unknown top-level table names
- unsupported `agent.provider`
- a model id that does not exist for the selected provider
- invalid provider-specific keys under `provider.<name>`
- invalid `provider.<name>.base_url`
- non-positive tool limits
- invalid retry policy values (for example, `retry_max_delay_ms < retry_initial_delay_ms`)

## Change Rules

When config semantics change, update these files in the same patch:

- `packages/jar-node/src/config.ts`
- `jar.example.toml`
- `docs/configuration.md`
- `docs/README.md` when a new config-related document is added
