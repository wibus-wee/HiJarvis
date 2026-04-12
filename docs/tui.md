# TUI

Jar 使用 Ink 为 `--repl` 模式提供最小聊天式终端 UI。

## 目标

TUI 只替换交互层，不替换底层 agent 执行链：

- `packages/jar-core/src/runtime.ts` 继续负责创建 `Agent`
- `packages/jar-core/src/prompt-executor.ts` 继续负责 timeout、retry 与错误分类
- `packages/jar-core/src/lanes/` 继续负责 thread/lane tape、checkpoint 与 event 持久化
- `packages/jar-repl-ink/src/repl.tsx` 负责输入、消息渲染与最小交互
- `packages/jar-repl-ink/src/tui/format.ts` 负责基于终端宽度做 wrap / truncate

这保证了 one-shot CLI 与 `--repl` 共用同一套 agent/runtime 语义。

## 布局

`--repl` 当前只保留两块：

- Message list: 已完成消息与正在 streaming 的 assistant 输出
- Composer: 单行输入框与最少的操作提示

输入区使用 `@inkjs/ui` 的 `TextInput`，不再额外叠加自定义 prompt 前缀或多面板焦点逻辑。

## 键位

- `Enter`: 发送当前输入
- `Ctrl+C`: 若 agent 正在运行则发送 abort；否则退出 TUI
- `exit`, `quit`, `:q`, `:exit`, `:quit`: 退出 TUI

## 事件来源

TUI 消费 `pi-agent-core` 的 `AgentEvent`，重点使用：

- `message_update`: assistant 文本增量
- `message_end`: 用户、assistant、toolResult 消息落盘后的最终状态

tool 执行和 retry 仍在底层发生，但当前最小界面不会直接展示独立的 tool / diagnostics pane。

## 当前边界

当前 TUI 故意保持简单：

- 没有 session picker
- 没有 alternate-screen 专用模式
- 没有独立的 tool / diagnostics 面板
- 没有复杂的 pane focus 或自定义命令面板

这样做是为了降低渲染复杂度和维护成本，优先保证输入与对话输出稳定。

如果后续要增强交互，应优先扩展 `packages/jar-repl-ink/src/tui/state.ts` 的状态模型，而不是把组件直接耦合到底层 `AgentEvent`。
