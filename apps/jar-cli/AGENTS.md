# AGENTS.md

## Architecture

> Update this section if you make significant changes to the architecture.

```bash
apps/jar-cli/src/main.ts - CLI entrypoint and workspace wiring.
apps/jar-cli/src/render-agent-event.ts - One-shot stdout/stderr event renderer for the CLI adapter.
packages/jar-core/src/runtime.ts - Agent runtime assembly and model resolution.
packages/jar-core/src/prompt-executor.ts - Shared prompt execution policy (timeout, retry/backoff, and failure classification).
packages/jar-core/src/config.ts - TOML config loader built on smol-toml + zod.
packages/jar-core/src/lanes/ - Tape-backed thread/lane persistence substrate and materialization.
packages/jar-core/src/execution-types.ts - Turn/run/item and compaction fact types plus id generators.
packages/jar-core/src/tools.ts - Tool aggregation entrypoint that registers the local tool set.
packages/jar-core/src/tools/shared.ts - Shared tool option types and workspace path confinement.
packages/jar-core/src/tools/file-tools.ts - read_file and write_file implementations.
packages/jar-core/src/tools/patch-tool.ts - apply_patch parser, patch applier, and tool implementation.
packages/jar-core/src/tools/bash-tool.ts - bash, bash_output, and bash_kill implementations.
packages/jar-core/src/tools/web-fetch-tool.ts - web_fetch implementation for remote text-like content.
packages/jar-repl-ink/src/repl.tsx - Ink-based interactive REPL/TUI for multi-turn sessions.
packages/jar-repl-ink/src/tui/format.ts - Width-aware wrapping and truncation helpers for TUI panels.
packages/jar-repl-ink/src/tui/state.ts - TUI state reducer that normalizes agent events into transcript/tool/diagnostic panels.
jar.example.toml - Canonical config example. Keep this aligned with packages/jar-core/src/config.ts whenever config fields change.
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
