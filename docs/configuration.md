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

For long-running adapters, the workspace uses the same source-first model during development:

```bash
pnpm dev:slack
pnpm --filter @hijarvis/jar-telegram dev -- --config ../../jar.toml
pnpm --filter @hijarvis/jar-wechat dev -- --config ../../jar.toml
```

Both commands run via `tsx`, and internal packages such as `@hijarvis/jar-core` are consumed from source without a separate build step.

## Config Layout

`jar.toml` uses six top-level tables:

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

[agent.compaction]
enabled = true
trigger_ratio = 0.9
budget_ratio = 0.9
summary_max_tokens = 1024

[provider.openai]
api_key = "replace-me"
base_url = "https://api.openai.com/v1"

[platform.slack]
bot_name = "jarvis"
bot_token = "xoxb-replace-me"
signing_secret = "replace-me"
context_lookback_minutes = 15
context_message_limit = 12
host = "0.0.0.0"
port = 3000

[platform.telegram]
bot_token = "123456:replace-me"
allowed_chat_ids = [123456789]
allowed_usernames = ["wibus"]
host = "0.0.0.0"
port = 3001

[platform.wechat]
base_url = "https://api-bot.hzxww.net"
token_path = ".jar/wechat/credentials.json"
coalesce_window_ms = 2500
host = "0.0.0.0"
port = 3002

[logging]
level = "info"
stderr = true
file_path = ".jar/logs/runtime.log"

[tools]
workspace_root = "."
max_file_bytes = 32768
command_timeout_ms = 30000
max_command_output_bytes = 32768
web_request_timeout_ms = 30000
max_web_response_bytes = 65536

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

#### `[agent.compaction]`

- `enabled`: 是否启用自动压缩。默认：`true`。
- `trigger_ratio`: 触发压缩的阈值（占 model context window 的比例）。默认：`0.9`。
- `budget_ratio`: 压缩后目标预算（占 model context window 的比例）。默认：`0.9`。
- `summary_max_tokens`: 摘要生成的最大输出 token。默认：`1024`。

`mid_turn` 下用于保留最小 tool tail 的预算现在是内部固定值，不再暴露为配置项。

### `[provider.<name>]`

- `api_key`: optional provider API key. If omitted, `pi-ai` falls back to provider-specific environment variables.
- `base_url`: optional endpoint override. Useful for OpenAI-compatible gateways, proxies, and local model servers.

`agent.provider` selects which provider sub-table is used at runtime. For example, when `agent.provider = "openai"`, Jar reads only `[provider.openai]`.

Inactive provider tables are allowed. They are ignored until selected by `agent.provider`.

### `[platform.slack]`

- `bot_name`: Slack gateway 显示名，占位字段。默认：`"jarvis"`。
- `bot_token`: Slack bot token。用于 Socket Mode + Web API 调用。
- `app_token`: Slack app-level token (xapp-...)。Socket Mode 必需。
- `signing_secret`: Slack signing secret，用于请求校验与 SDK 初始化。
- `context_lookback_minutes`: 当某个 channel scope 里还没有 Jarvis 的上一轮回复时，bootstrap fallback 向前回看顶层消息的时间窗。默认：`15`。
- `context_message_limit`: 每一轮 channel-scope prompt 里，最多带入多少条顶层 channel 消息。默认：`12`。
- `host`: 健康检查 HTTP 服务监听 host。默认：`"0.0.0.0"`。
- `port`: 健康检查 HTTP 服务监听端口。默认：`3000`。

Slack gateway 现在默认优先读 `jar.toml` 里的 `[platform.slack]`。

这些环境变量仍然可以覆盖对应配置：

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SLACK_SIGNING_SECRET`
- `JARVIS_SLACK_BOT_NAME`
- `JARVIS_SLACK_CONTEXT_LOOKBACK_MINUTES`
- `JARVIS_SLACK_CONTEXT_MESSAGE_LIMIT`
- `HOST`
- `PORT`

### `[platform.telegram]`

- `bot_token`: Telegram bot token。
- `allowed_chat_ids`: 可选 chat id allowlist。配置后，bot 只会处理这些 chat 的消息。
- `allowed_usernames`: 可选 username allowlist。配置后，bot 只会处理这些发送者发来的消息。
- `host`: Telegram health check HTTP 服务监听 host。默认：`"0.0.0.0"`。
- `port`: Telegram health check HTTP 服务监听端口。默认：`3001`。

Telegram gateway 默认使用 long polling，而不是 webhook。

这些环境变量可以覆盖对应配置：

- `TELEGRAM_BOT_TOKEN`
- `JARVIS_TELEGRAM_ALLOWED_CHAT_IDS`
- `JARVIS_TELEGRAM_ALLOWED_USERNAMES`
- `JARVIS_TELEGRAM_HOST`
- `JARVIS_TELEGRAM_PORT`

### `[platform.wechat]`

- `base_url`: 可选 iLink API base URL 覆盖项。
- `token_path`: 可选 credentials 文件路径；相对路径以当前工作目录解析，由 `@pinixai/weixin-bot` 持久化二维码登录态。
- `coalesce_window_ms`: WeChat 消息聚合窗口。窗口内连续发来的图片和文本会合并成一次 Jar turn。默认：`2500`。
- `host`: WeChat health check HTTP 服务监听 host。默认：`"0.0.0.0"`。
- `port`: WeChat health check HTTP 服务监听端口。默认：`3002`。

WeChat gateway 通过 `@pinixai/weixin-bot` 做二维码登录和长轮询。
如果当前模型支持 image input，聚合后的同一轮消息会把图片作为真正的多模态 image block 送进模型；持久化到 session 时只保留文字轨迹，不会把 base64 原图写进 `.jar/sessions`。

这些环境变量可以覆盖对应配置：

- `JARVIS_WECHAT_BASE_URL`
- `JARVIS_WECHAT_TOKEN_PATH`
- `JARVIS_WECHAT_HOST`
- `JARVIS_WECHAT_PORT`

### `[logging]`

- `level`: 运行摘要日志级别，可选 `error`、`warn`、`info`、`debug`。默认：`info`。
- `stderr`: 是否把摘要日志同时输出到 `stderr`。默认：`true`。当前实现基于 `pino-pretty`，面向本地开发可读性。
- `file_path`: 可选的日志文件路径。相对路径会以配置文件所在目录为基准。当前实现会写入 `pino` JSONL，适合后续 grep 或脚本分析。

这套日志的设计目标不是替代 `.jar/sessions/<sessionId>/events.jsonl`，而是提供一层更适合开发和排障的“链路摘要”：

- `info`：只输出关键阶段边界，例如 Slack 事件接收、队列合并、channel delta 抓取、session 执行开始/结束、reply 发回 Slack。
- `debug`：在 `info` 基础上补充更多低层事件，例如 message 落盘、被忽略或被去重的 Slack 事件。

### `[tools]`

- `workspace_root`: root directory exposed to the file tools and the default starting directory for the shell tool. Relative paths are resolved from the config file directory. Default: `"."`.
- `max_file_bytes`: maximum UTF-8 size accepted by `read_file`, `write_file`, and any file content produced by `apply_patch`. Default: `32768`.
- `command_timeout_ms`: shell command timeout in milliseconds. Default: `30000`.
- `max_command_output_bytes`: maximum buffered stdout/stderr captured from `bash`. Default: `32768`.
- `web_request_timeout_ms`: default timeout in milliseconds for `web_fetch` when the tool call omits `timeoutMs`. Default: `30000`.
- `max_web_response_bytes`: maximum UTF-8 response body size accepted by `web_fetch`. Default: `65536`.

### `[sessions]`

- `root_dir`: 会话存储目录。相对路径会以配置文件所在目录为基准。默认：`.jar/sessions`。

## Runtime Notes

- `apps/jar-cli/src/main.ts` loads the config from `@hijarvis/jar-core` and wires it into the same core package.
- `apps/jar-slack/src/slack-runtime.ts` reads `platform.slack`, emits summary logs through `config.logging`, and only uses environment variables as overrides.
- `apps/jar-telegram/src/telegram-runtime.ts` reads `platform.telegram`, emits summary logs through `config.logging`, and only uses environment variables as overrides.
- `apps/jar-wechat/src/wechat-runtime.ts` reads `platform.wechat`, emits summary logs through `config.logging`, and only uses environment variables as overrides.
- `packages/jar-core/src/runtime.ts` resolves the selected `pi-ai` model and overrides `model.baseUrl` when `provider.<name>.base_url` is set.
- `apps/jar-cli/src/main.ts` and `packages/jar-repl-ink/src/repl.tsx` use the same prompt execution policy for timeout, retry, and error classification.
- `packages/jar-core/src/session-executor.ts` emits session/tool summary logs without streaming every token delta.
- `packages/jar-core/src/runtime.ts` forwards `agent.retry_max_delay_ms` to `Agent.maxRetryDelayMs`.
- `packages/jar-core/src/runtime.ts` passes `provider.<name>.api_key` through `Agent.getApiKey()` for the active provider only.
- Tool registration is handled in `packages/jar-core/src/tools.ts`.
- Built-in tool behavior and restrictions are documented in [Tools](./tools.md).

## Validation

Core runtime parsing lives in `packages/jar-core/src/config.ts`, using `smol-toml` for TOML parsing and `zod` for schema validation. Adapter-specific validation is handled by the adapters themselves.

Core validation happens in two stages:

1. Validate the top-level TOML shape.
2. Validate the active provider config selected by `agent.provider`.

Platform-specific tables are validated when the adapter starts:

- Slack: `apps/jar-slack/src/slack-config.ts`
- Telegram: `apps/jar-telegram/src/telegram-config.ts`
- WeChat: `apps/jar-wechat/src/wechat-config.ts`

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

- `packages/jar-core/src/config.ts`
- `apps/jar-slack/src/slack-config.ts`
- `apps/jar-telegram/src/telegram-config.ts`
- `apps/jar-wechat/src/wechat-config.ts`
- `jar.example.toml`
- `docs/configuration.md`
- `docs/README.md` when a new config-related document is added
