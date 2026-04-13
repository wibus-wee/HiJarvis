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
```

Both commands run via `tsx`, and internal packages such as `@hijarvis/jar-core` are consumed from source without a separate build step.

## Config Layout

`jar.toml` uses nine top-level tables:

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

[entities.jarvis]
display_name = "Jarvis"

[entities.pm]
display_name = "PM Jarvis"
system_prompt = "You are PM Jarvis."

[agent.compaction]
enabled = true
trigger_ratio = 0.9
budget_ratio = 0.9
summary_max_tokens = 1024

[provider.openai]
api_key = "replace-me"
base_url = "https://api.openai.com/v1"

[platform.slack.identities.slack_main]
entity = "jarvis"
bot_token = "xoxb-replace-me"
app_token = "xapp-replace-me"
signing_secret = "replace-me"
context_lookback_minutes = 15
context_message_limit = 12

[platform.slack.identities.slack_pm]
entity = "pm"
bot_token = "xoxb-replace-me-2"
app_token = "xapp-replace-me-2"
signing_secret = "replace-me-2"
context_lookback_minutes = 15
context_message_limit = 12

[platform.telegram.identities.telegram_main]
entity = "jarvis"
bot_token = "123456:replace-me"
allowed_chat_ids = [123456789]
allowed_usernames = ["wibus"]

[platform.telegram.identities.telegram_pm]
entity = "pm"
bot_token = "654321:replace-me"
allowed_chat_ids = [987654321]
allowed_usernames = ["wibus"]

[logging]
level = "info"
stderr = true
file_path = ".jar/logs/runtime.log"

[skills]
enabled = true
roots = [".jarvis/skills", "~/.jarvis/skills"]
max_scan_depth = 6
max_skills = 2000
max_catalog_chars = 12000
max_body_chars = 20000

[memory]
enabled = true
provider = "filesystem"

[memory.providers.filesystem]
root_dir = ".jar/memory"

[tools]
workspace_root = "."
max_file_bytes = 32768
command_timeout_ms = 30000
max_command_output_bytes = 32768
web_request_timeout_ms = 30000
max_web_response_bytes = 65536
max_concurrent_shells = 10

[sessions]
root_dir = ".jar/threads"
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

### `[entities.<id>]`

`entities` 定义稳定的 Jarvis 实体。它们不是 session，也不是某个平台里的 bot 凭证。实体只负责名字和 prompt 身份；它不再声明自己“在哪些平台出现”。真正出现在 Slack 或 Telegram 上的是 `platform.<platform>.identities.<identity>`。

- `display_name`: 可选的人类可读名称。默认使用 `<id>`。
- `system_prompt`: 可选的 entity 级 prompt 覆盖。未配置时继承 `[agent].system_prompt`。

`entities` 现在必须显式配置。Jar 不再偷偷制造默认 entity，因为普通平台消息必须通过某个真实 platform identity 进入系统，而不是通过一个抽象默认身份进入。

### `[provider.<name>]`

- `api_key`: optional provider API key. If omitted, `pi-ai` falls back to provider-specific environment variables.
- `base_url`: optional endpoint override. Useful for OpenAI-compatible gateways, proxies, and local model servers.

`agent.provider` selects which provider sub-table is used at runtime. For example, when `agent.provider = "openai"`, Jar reads only `[provider.openai]`.

Inactive provider tables are allowed. They are ignored until selected by `agent.provider`.

The built-in `web_search` tool reads the same active provider selection. Today the OpenAI branch is implemented against the Responses `web_search` tool, while non-OpenAI branches intentionally remain extension seams in `packages/jar-core/src/tools/web-search-tool.ts`.

### `[platform.slack]`

### `[platform.slack.identities.<identity_id>]`

每个 Slack identity 代表一个真实 Slack bot/app 身份。一个 identity 绑定一个 entity，并拥有自己独立的 Socket Mode 凭证、观察窗口和会话命名空间。

- `entity`: 该 Slack bot 绑定到哪个 Jarvis entity。
- `bot_token`: Slack bot token。用于 Socket Mode + Web API 调用。
- `app_token`: Slack app-level token (xapp-...)。Socket Mode 必需。
- `signing_secret`: Slack signing secret，用于 SDK 初始化。
- `context_lookback_minutes`: 当该 bot 在某个 channel scope 里还没有上一轮回复时，bootstrap fallback 向前回看顶层消息的时间窗。默认：`15`。
- `context_message_limit`: 每一轮 channel-scope prompt 里，最多带入多少条顶层 channel 消息。默认：`12`。
Slack gateway 现在读取 `jar.toml` 里的 `platform.slack.identities.*`，并为每个 identity 启动一个独立的 Slack runtime state。

这些环境变量仍然可以覆盖对应配置：

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SLACK_SIGNING_SECRET`
- `JARVIS_SLACK_CONTEXT_LOOKBACK_MINUTES`
- `JARVIS_SLACK_CONTEXT_MESSAGE_LIMIT`

### `[platform.telegram]`

### `[platform.telegram.identities.<identity_id>]`

每个 Telegram identity 代表一个真实 Telegram bot token。一个 identity 绑定一个 entity，并维护自己独立的 allowlist 和会话命名空间。

- `entity`: 该 Telegram bot 绑定到哪个 Jarvis entity。
- `bot_token`: Telegram bot token。
- `allowed_chat_ids`: 可选 chat id allowlist。配置后，这个 bot 只会处理这些 chat 的消息。
- `allowed_usernames`: 可选 username allowlist。配置后，这个 bot 只会处理这些发送者发来的消息。

Telegram gateway 默认使用 long polling，而不是 webhook，并且现在以 `platform.telegram.identities.*` 作为真实多 bot 配置入口。

这些环境变量可以覆盖对应配置：

- `TELEGRAM_BOT_TOKEN`
- `JARVIS_TELEGRAM_ALLOWED_CHAT_IDS`
- `JARVIS_TELEGRAM_ALLOWED_USERNAMES`

### `[logging]`

- `level`: 运行摘要日志级别，可选 `error`、`warn`、`info`、`debug`。默认：`info`。
- `stderr`: 是否把摘要日志同时输出到 `stderr`。默认：`true`。当前实现基于 `pino-pretty`，面向本地开发可读性。
- `file_path`: 可选的日志文件路径。相对路径会以配置文件所在目录为基准。当前实现会写入 `pino` JSONL，适合后续 grep 或脚本分析。

这套日志的设计目标不是替代 `.jar/threads/<threadId>/lanes/main/events.jsonl`，而是提供一层更适合开发和排障的“链路摘要”：

- `info`：只输出关键阶段边界，例如 Slack 事件接收、队列合并、channel delta 抓取、session 执行开始/结束、reply 发回 Slack。
- `debug`：在 `info` 基础上补充更多低层事件，例如 message 落盘、被忽略或被去重的 Slack 事件。

### `[skills]`

- `enabled`: 是否启用 skills 发现与注入。默认：`true`。
- `roots`: skill 根目录列表。相对路径以配置文件所在目录解析；默认值是 `[".jarvis/skills", "~/.jarvis/skills"]`。
- `max_scan_depth`: 目录扫描深度上限。默认：`6`。
- `max_skills`: 最多加载多少个 `SKILL.md`。默认：`2000`。
- `max_catalog_chars`: 注入到 system prompt 的 skills catalog 最大字符数。默认：`12000`。
- `max_body_chars`: 单个 `SKILL.md` 在单轮注入时的最大字符数。默认：`20000`。

Skills 的运行时语义是 Codex-style 的两层注入：

- 启动时扫描 `roots`，读取每个 `SKILL.md` 的 frontmatter，并把可隐式触发的 skill 清单拼进 system prompt overlay。
- 每一轮只会根据用户显式写出的 `$skill-name` 去读取对应 `SKILL.md` 正文，并把正文作为 turn-scoped block 注入到当前 prompt。
- 注入过的 `<skill>...</skill>` block 不会长期保存在 session 历史里；旧消息会在后续轮次进入模型前被清洗掉。

### `[memory]`

- `enabled`: 是否启用长期记忆工具。默认：`true`。
- `provider`: 当前启用的 memory provider 名称。默认：`"filesystem"`。

### `[memory.providers.<name>]`

每个 memory provider 都有自己独立的配置表。`[memory]` 只负责“启用 memory”以及“当前选哪个 provider”，具体 provider 参数都放在 `memory.providers.*` 下面。

内置 filesystem provider:

- `root_dir`: filesystem provider 的根目录。相对路径以配置文件所在目录解析。默认：`.jar/memory`。

外部 provider 约定：

- `module`: 可选的模块路径或包名。配置后，Jar 会动态加载该模块，并读取它导出的 `createMemoryProvider()` factory。
- 其他字段原样透传给该 provider 的 factory，由 provider 自己解释。

记忆系统按 entity 隔离，而不是按 thread 隔离：

- Slack/Telegram turn 通过 `platform.<platform>.identities.<identity>.entity` 解析 entity
- CLI/local-thread turn 回退到第一个已配置 entity
- 解析出的 entity id 会传入每一次 memory provider 调用

当前 `@hijarvis/jar-core` 内置四个记忆工具：`memory_search`、`memory_store`、`memory_update`、`memory_delete`。

当前 provider 解析顺序：

- 如果 `memory.provider` 是内置 provider，例如 `filesystem`，Jar 使用内置 factory
- 否则如果 `memory.providers.<name>.module` 已配置，Jar 动态加载该模块
- 否则报错

### `[tools]`

- `workspace_root`: root directory exposed to the file tools and the default starting directory for the shell tool. Relative paths are resolved from the config file directory. Default: `"."`.
- `max_file_bytes`: maximum UTF-8 size accepted by `read_file`, `write_file`, and any file content produced by `apply_patch`. Default: `32768`.
- `command_timeout_ms`: shell command timeout in milliseconds. Default: `30000`.
- `max_command_output_bytes`: maximum buffered stdout/stderr captured from `bash`. Default: `32768`.
- `web_request_timeout_ms`: default timeout in milliseconds for `web_fetch` when the tool call omits `timeoutMs`. Default: `30000`.
- `max_web_response_bytes`: maximum UTF-8 response body size accepted by `web_fetch`. Default: `65536`.
- `max_concurrent_shells`: maximum number of concurrent background `bash` commands. Default: `10`.

### `[sessions]`

- `root_dir`: thread/lane 存储目录。相对路径会以配置文件所在目录为基准。默认：`.jar/threads`。

## Runtime Notes

- `apps/jar-cli/src/main.ts` loads the config from `@hijarvis/jar-core` and wires it into the same core package.
- `apps/jar-slack/src/slack-runtime.ts` reads `platform.slack`, emits summary logs through `config.logging`, and only uses environment variables as overrides.
- `apps/jar-telegram/src/telegram-runtime.ts` reads `platform.telegram`, emits summary logs through `config.logging`, and only uses environment variables as overrides.
- `packages/jar-core/src/runtime.ts` resolves the selected `pi-ai` model and overrides `model.baseUrl` when `provider.<name>.base_url` is set.
- `packages/jar-core/src/config.ts` resolves `skills` at startup and passes the catalog/runtime metadata into `packages/jar-core/src/runtime.ts` and `packages/jar-core/src/thread-executor.ts`.
- `apps/jar-cli/src/main.ts` and `packages/jar-repl-ink/src/repl.tsx` use the same prompt execution policy for timeout, retry, and error classification.
- `packages/jar-core/src/thread-executor.ts` emits thread/tool summary logs without streaming every token delta.
- `packages/jar-core/src/runtime.ts` forwards `agent.retry_max_delay_ms` to `Agent.maxRetryDelayMs`.
- `packages/jar-core/src/runtime.ts` passes `provider.<name>.api_key` through `Agent.getApiKey()` for the active provider only.
- `packages/jar-core/src/config.ts` also forwards the active provider name, model, `provider.<name>.api_key`, and optional `provider.<name>.base_url` into `toolOptions` so provider-aware tools such as `web_search` can branch correctly.
- Tool registration is handled in `packages/jar-core/src/tools.ts`.
- Memory tool injection is handled in `packages/jar-core/src/execution-service.ts`, because the active entity is only known after ingress routing.
- Configured memory provider resolution lives in `packages/jar-core/src/memory/provider-resolution.ts`.
- Built-in tool behavior and restrictions are documented in [Tools](./tools.md).

## Validation

Core runtime parsing lives in `packages/jar-core/src/config.ts`, using `smol-toml` for TOML parsing and `zod` for schema validation. Adapter-specific validation is handled by the adapters themselves.

Core validation happens in two stages:

1. Validate the top-level TOML shape.
2. Validate the active provider config selected by `agent.provider`.

Platform-specific tables are validated when the adapter starts:

- Slack: `apps/jar-slack/src/slack-config.ts`
- Telegram: `apps/jar-telegram/src/telegram-config.ts`

Common failure cases:

- unknown top-level table names
- unsupported `agent.provider`
- a model id that does not exist for the selected provider
- invalid provider-specific keys under `provider.<name>`
- invalid `provider.<name>.base_url`
- invalid `[skills]` numeric limits
- non-positive tool limits
- invalid retry policy values (for example, `retry_max_delay_ms < retry_initial_delay_ms`)

## Change Rules

When config semantics change, update these files in the same patch:

- `packages/jar-core/src/config.ts`
- `apps/jar-slack/src/slack-config.ts`
- `apps/jar-telegram/src/telegram-config.ts`
- `jar.example.toml`
- `docs/configuration.md`
- `docs/README.md` when a new config-related document is added
