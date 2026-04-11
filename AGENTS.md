# AGENTS.md

## Architecture - FileTree

> Update this section if you make significant changes to the architecture.

```bash
.
├── 3rd
│   └── wechat-sdk - extracted WeChat API SDK
├── apps
│   ├── jar-cli - a CLI interface with a readline loop
│   ├── jar-slack - a Slack bot
│   ├── jar-telegram - a Telegram bot
├── docs
│   └── exec-plans - living implementation plans for large refactors and features
├── packages
│   └── jar-core
│       └── src
│           └── compaction - staged compaction subsystem with boundary, pipeline, summary, partial compaction, retry, and artifact restoration
└── research
    ├── claude-code-compaction - research notes on Claude Code's compaction system
    └── hijarvis-compaction-vs-claude-code.md - current parity gap audit between HiJarvis and Claude Code compaction
```

## Config Layout

Use this shape for runtime config:

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

[platform.slack]
bot_name = "jarvis"
bot_token = "xoxb-replace-me"
signing_secret = "replace-me"
context_lookback_minutes = 15
context_message_limit = 12
host = "0.0.0.0"
port = 3000

[platform.wechat]
base_url = "https://api-bot.hzxww.net"
token_path = ".jar/wechat/credentials.json"
coalesce_window_ms = 2500
host = "0.0.0.0"
port = 3002

[tools]
workspace_root = "."
max_file_bytes = 32768
command_timeout_ms = 30000
max_command_output_bytes = 32768
web_request_timeout_ms = 30000
max_web_response_bytes = 65536
```

Notes:

- `agent.provider` selects which `provider.<name>` table is used at runtime.
- Keep provider-specific fields inside `provider.<name>`, not a flat `[provider]` table.
- If you change config semantics, update both `jar.example.toml` and `packages/jar-core/src/config.ts` in the same patch.

## Documentation

You should update the documentation in the docs directory as you make changes to the implementation. There is a README.md in the docs directory that serves as an index to the documentation, so you should refer to that file to see what documentation needs to be updated and for details.

Documentation is important for LLMs to understand how to develop agents using pi-mono's agent framework, and it is also important for human developers who want to use the framework. Please make sure to keep the documentation up to date and accurate.

## References

If you have questions about how to use pi-mono's agent framework, these resources may be helpful:

- https://github.com/badlogic/pi-mono/blob/main/packages/ai/README.md 
- https://github.com/badlogic/pi-mono/blob/main/packages/agent/README.md
- node_modules/@mariozechner/pi-agent-core
- node_modules/@mariozechner/pi-ai
