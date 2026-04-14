# AGENTS.md

## Architecture - FileTree

> Update this section if you make significant changes to the architecture.

```bash
.
├── 3rd
│   └── wechat-sdk - extracted WeChat API SDK with api, auth, media, messaging, storage, and util modules
├── apps
│   ├── jar-cli - CLI entrypoint for one-shot runs, thread commands, and the Ink REPL surface
│   ├── jar-slack - Slack Socket Mode gateway and identity supervisor with thread-first routing
│   └── jar-telegram - Telegram long-polling gateway and identity supervisor with chat/topic routing
├── docs
│   ├── README.md - documentation index for runtime, compaction, sessions, tools, gateways, TUI, and SDK docs
│   └── exec-plans - living implementation plans for large refactors and features
├── packages
│   ├── jar-core
│   │   └── src
│   │       ├── compaction - staged history compaction pipeline with assembly, policy, prompting, summaries, snipping, and lightweight passes
│   │       ├── execution - phased execution pipeline with agent creation, session loading, prompt preparation, event subscription, and finalization
│   │       ├── hooks - typed hook registry for intercepting and observing the execution pipeline (ingress, prompt, tools, response, errors)
│   │       ├── lanes - tape-backed thread/lane persistence, materialization, checkpoints, and audit records
│   │       ├── memory - long-term memory provider interface, filesystem provider, and memory tools
│   │       ├── side-question - /btw side-question live-thread registry and executor for ephemeral queries
│   │       └── tools - built-in file, patch, bash, and web tools plus shared workspace safety helpers
│   └── jar-repl-ink - Ink-based TUI package for the `--repl` experience
└── research
    ├── claude-code-compaction - research notes on Claude Code's compaction system
    ├── hijarvis-compaction-vs-claude-code.md - current parity gap audit between HiJarvis and Claude Code compaction
    └── hijarvis-arch-research-0409 - architecture research workspace
```

## Documentation

You should update the documentation in the docs directory as you make changes to the implementation. There is a README.md in the docs directory that serves as an index to the documentation, so you should refer to that file to see what documentation needs to be updated and for details.

Documentation is important for LLMs to understand how to develop agents using pi-mono's agent framework, and it is also important for human developers who want to use the framework. Please make sure to keep the documentation up to date and accurate.

## References

If you have questions about how to use pi-mono's agent framework, these resources may be helpful:

- https://github.com/badlogic/pi-mono/blob/main/packages/ai/README.md 
- https://github.com/badlogic/pi-mono/blob/main/packages/agent/README.md
- node_modules/@mariozechner/pi-agent-core
- node_modules/@mariozechner/pi-ai
- agent-design-skill: Guide for designing and implementing agents.
