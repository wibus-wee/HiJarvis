# Skills

Jar 的 skills 机制参考了 Codex 的做法，但做了适配到当前 Jar runtime 的映射。

当前实现的关键点是：Jar 在内部把 skill body 建模成一类显式的 prompt context fragment，而不是把 skills 逻辑直接散落在各个平台 adapter 里。

## 设计目标

- skill catalog 是长期能力声明，应该进入 developer-style overlay。
- `SKILL.md` 正文是重上下文的局部指令，只应在命中的那一轮作为 contextual fragment 注入。
- 平台适配器不负责扫描文件系统或解析 skill，只负责提供“这一轮用户真正说了什么”。

## Discovery

Jar 启动时会在以下 roots 里扫描 `SKILL.md`：

- `.jarvis/skills`
- `~/.jarvis/skills`

也可以通过 `jar.toml` 里的 `[skills].roots` 覆盖。

每个 skill 目录至少包含一个 `SKILL.md`。Jar 会读取 frontmatter 中的：

- `name`
- `description`

如果缺少 `name`，会回退为 skill 目录名。

如果存在 `agents/openai.yaml`，Jar 还会读取：

- `allow_implicit_invocation`

当它是 `false` 时，这个 skill 仍可通过显式 `$skill-name` 使用，但不会进入自动 catalog。

## Injection Model

运行时分两层：

1. 启动阶段
   Jar 解析所有 skill 元数据，并把可隐式触发的 skills catalog 追加到 runtime instruction overlay。
2. 每轮执行前
   Jar 从用户触发文本里提取 `$skill-name`，读取对应 `SKILL.md` 正文，先生成 `PromptContextFragment`，再在 provider 边界把它渲染成 `<skill>...</skill>` block 注入当前 prompt。

这意味着：

- model 总能看到当前可用的 skill 清单；
- 只有被显式点名的 skill，才会把正文带进这一轮上下文；
- 不会把所有 `SKILL.md` 全量塞进 system prompt。

## Trigger Sources

不同入口会把不同的“用户文本”传给 `preparePromptWithSkills()`：

skills 模块本身不再负责直接改写 prompt；它只返回“应该注入哪些 skill fragments”。真正的注入与清洗由 `prompt-context.ts` 负责。

- CLI / REPL：当前输入文本本身。
- Slack：当前消息 + 同一批被合并的 thread 消息；不会把观测到的 channel context 当成 skill trigger。
- Telegram：当前消息 + 同一批被合并的 follow-up 消息。
- WeChat：当前聚合窗口内的真实文本消息；不会把图片占位描述当成 trigger。

## Persistence Rules

skill body 注入是 turn-scoped 的，不应该永久污染会话历史。

Jar 通过两层清洗来保证这一点：

- message 落盘前，会去掉 `<skill>...</skill>` block；
- 后续轮次恢复历史后，旧的 user message 进入模型前也会再次清洗。

唯一保留未清洗 skill block 的场景，是“当前这一次正在执行的最新 user turn”，这样当前轮模型仍然能读到被点名的 skill 正文。

## Code Map

- `packages/jar-core/src/skills.ts`
  skill discovery、catalog rendering、显式 mention 解析，以及 skill fragment 生成。
- `packages/jar-core/src/prompt-context.ts`
  prompt context fragment 的渲染、注入、memory-excluded 清洗与 trigger text 提取。
- `packages/jar-core/src/config.ts`
  `[skills]` 配置解析与 runtime 初始化。
- `packages/jar-core/src/runtime.ts`
  把 catalog 追加到 runtime prompt overlay，并在 compaction 前清洗旧的 memory-excluded fragments。
- `packages/jar-core/src/session-executor.ts`
  执行前把 skill fragments 注入当前 turn，并在默认持久化路径里去掉 memory-excluded fragments。
