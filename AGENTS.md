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