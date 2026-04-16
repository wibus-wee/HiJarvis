# Plugin Architecture v2 (Lifecycle, Contributions, Observability)

这是一份 living ExecPlan。`Progress`、`Surprises & Discoveries`、`Decision Log`、`Outcomes & Retrospective` 必须随着工作推进持续更新，且任何停顿点都要反映在 `Progress` 里。

本文档需要严格遵循 `/Users/wibus/.agents/skills/execplan/references/PLANS.md` 对 ExecPlan 的格式与内容要求。

## Purpose / Big Picture

完成本次变更后，plugin 作者可以构建“进程级加载、明确生命周期、可诊断”的扩展：插件只会在一个进程生命周期里初始化一次，能稳定注册 hook，能在退出时可靠释放资源；运行时能产出结构化诊断信息，让用户不必读源码就能判断“哪些插件加载了、哪些失败了、为什么”。

你可以通过 `jar-core` 的测试来验证：一个 demo plugin 被加载一次、它注册的 hook 生效、它贡献的 skill 能被注入（并可选地出现在可见的 catalog overlay 中）、以及 shutdown 时 cleanup 被调用一次且顺序正确。

第一阶段明确不做的事情：不修改现有 CLI / Slack / Telegram 的插件 wiring。仓库目前存在“plugins 不生效”的现象（根因需要单独决策），在我们决定 runtime 应该如何传递 `HookRegistry`、以及插件故障应该如何对用户可见之前，这一轮只做架构与可验证实现，并通过一个显式 opt-in 的集成入口在测试中验证。

## Progress

- [x] (2026-04-14 10:04Z) Read and applied PLANS.md formatting and required sections.
- [x] (2026-04-14 10:09Z) Audited the draft for repo constraints; rewrote to Chinese prose-first; reduced MVP scope to avoid over-design.
- [ ] 明确 v2 的 MVP 边界（completed: draft; remaining: align with Wibus on what ships in milestone 1 vs 2）。
- [ ] 实现 `PluginManager`（load once, shutdown once, diagnostics）并补齐单元测试（completed: none; remaining: code + tests）。
- [ ] 增加一个测试专用的 opt-in 集成入口，证明 hook 生效与 cleanup 调用（completed: none; remaining: code + tests）。
- [ ] 实现 plugin skill 的“可见性”最小闭环（catalog overlay 的最小做法），并用测试锁住（completed: none; remaining: code + tests）。
- [ ] 更新 `docs/plugins.md`，明确 v1/v2 差异与迁移策略（completed: none; remaining: docs update）。

## Surprises & Discoveries

仓库已经有一个强类型且带优先级的 hook 系统（`packages/jar-core/src/hooks`），具备 transform/tap 语义。v2 不应再引入另一套“middleware”模型，而是围绕 hook 做 lifecycle 和贡献的规范化。

当前 skills 的 catalog overlay 是在 config load 时生成的，这会导致“插件后置贡献的 skill”很难自然出现在可见 catalog 中。这里有两条路：做一次较大改造把 overlay 变成 runtime 组合；或者先实现一个更小的闭环，只为 plugin skills 额外渲染一个 overlay 并在 createAgent 时追加进去。

后续会在这里补充测试输出或最小实现的证据片段，记录遇到的坑和权衡。

## Decision Log

- Decision: Build “Plugin Architecture v2” as a new opt-in runtime entry point first, without changing existing CLI/Slack/Telegram wiring.
  Rationale: Wibus explicitly requested to think about the “plugins not effective” wiring issue before changing it. We can still ship architecture primitives and verify them with tests.
  Date/Author: 2026-04-14 / Codex

- Decision: MVP 优先解决 lifecycle + diagnostics + cleanup 可靠性；结构化 contributions（tools 等）延后到 milestone 2。
  Rationale: 过早引入 `tools`/`overlays` 的完整贡献模型会扩大设计面，且会隐含“按请求/按实体”选择工具的需求，容易拖慢 v2 落地。
  Date/Author: 2026-04-14 / Codex

## Outcomes & Retrospective

该部分会在里程碑完成后更新。目标结果是：

1) 一个清晰的插件生命周期：同一进程内加载/安装一次，shutdown 时 teardown 一次，不会随着请求次数增长而产生重复注册或资源泄漏。

2) 可诊断与可发现：用户能获得结构化信息（加载成功/失败、错误原因、耗时、贡献概要），且冲突处理是确定性的（至少能稳定报警/记录）。

3) 迁移路径清晰：不要求一次性改动 app runtimes 的 wiring，就能在 `jar-core` 层验证 v2 并逐步替换。

## Context and Orientation

在本仓库中，“plugin” 当前指一个 JS/TS 模块：导出 `createPlugin()` 工厂或 default `JarPlugin` 对象；plugin 可以注册 hook handler，并可选返回 skill entries 和 cleanup 函数。

当前关键文件包括：

    packages/jar-core/src/plugins/types.ts
    packages/jar-core/src/plugins/loader.ts
    packages/jar-core/src/execution/phase-init-stores.ts
    packages/jar-core/src/execution/phase-prepare-prompt.ts
    packages/jar-core/src/hooks/registry.ts
    packages/jar-core/src/runtime.ts
    docs/plugins.md

本文会使用一些术语，定义如下：

“Lifecycle” 指：plugin module 什么时候被加载、install 什么时候运行、shutdown 时如何释放资源。

“Contribution” 指：plugin 返回给 runtime 的结构化产物，runtime 可以以一致的方式合并和应用（例如 skills、overlays 等）。

“Prompt overlay” 指：每次 agent 创建时附加到 system prompt 的文本段落。在本仓库里，overlay 在 `packages/jar-core/src/runtime.ts` 中通过 `buildSystemPrompt()` 进行拼接。

“Diagnostics” 指：面向用户/日志的结构化信息，用于描述 plugin load/install/shutdown 的结果（成功、失败、冲突、耗时等）。

## Plan of Work

先做一个真正可落地的 MVP：引入 `PluginManager`，负责“加载一次、安装一次、关机一次、诊断可见”。它需要能在同一进程生命周期里保证幂等（反复调用 `load()` 也不会重复 install），并在 `shutdown()` 时可靠执行 teardown（包括 plugin 返回的 cleanup）。

为了避免复杂化，MVP 阶段的“结构化贡献”只做两类：

第一类是 `skills`（保证提及注入可用，并提供最小可见性闭环）；第二类是 `overlays`（用于把 plugin skills 的 catalog 变成可见文本）。`tools` 贡献先不做，因为它天然会引出“按 entity / 按 command / 按 platform”的选择与冲突策略，容易把 v2 扩成一个新的工具系统。

对于“plugin skills 是否出现在可见 catalog overlay”这个问题，MVP 采用更小的实现：在 createAgent 的那一刻，把“基于 plugin skills 渲染出来的一段 overlay”追加到 `systemPromptOverlays`，而不是整体重构 `loadRuntimeConfig()` 的 overlay 生成逻辑。这样可以把改动面控制在 `jar-core` 内部且更容易回滚。

诊断能力应该是 v2 的核心交付之一：`PluginManager` 必须能输出结构化 diagnostics，包含每个插件的加载/创建/安装/关机的结果与错误信息。后续再决定是否要 fail-fast 或 isolate 的默认行为，但 MVP 先实现 isolate 并把信息留在 diagnostics 里。

最后，通过一个测试专用的 opt-in 集成入口来验证 v2：在测试中显式创建 `HookRegistry` 与 `PluginManager`，把 hooks 传给 `executeIngressCommand()`，从而证明 hook 生效与 shutdown 行为正确，而不触碰现有 app runtimes 的 wiring。

## Concrete Steps

下面所有命令都在仓库根目录执行。

第一步，新增 v2 实现文件并定义核心类型。新增 `packages/jar-core/src/plugins/manager.ts`，实现一个 `createPluginManager()` 工厂（或者等价导出），并在 `packages/jar-core/src/plugins/types.ts` 中补齐 v2 所需类型（diagnostics、contribution、manager public API）。为了控制复杂度，MVP 阶段不新增 `module-resolution.ts`，仍复用现有 loader 对 `modulePath` 的 ESM import 规则；如果后续要支持 package specifier 与 config 路径归一化，需要单独开决策点。

第二步，为 lifecycle/diagnostics 写单元测试。新增 `packages/jar-core/src/plugins/manager.test.ts`，测试用例通过临时目录写入一个 demo plugin module 并加载它，断言：重复调用 `load()` 不会重复 install；`shutdown()` 会调用 cleanup 且只调用一次；当插件 import/create/install 失败时，错误不会默认把进程打崩，但会进入 diagnostics。

第三步，添加一个测试专用的 opt-in 集成测试，证明 hook 生效和 overlay 注入闭环。新增 `packages/jar-core/src/plugins/integration.test.ts`，显式创建 `HookRegistry` 与 `PluginManager`，并把 hooks 传入 `executeIngressCommand()`。插件在 `response:transform` 上打一个可断言的 marker，同时贡献一个 overlay（或通过 plugin skills 渲染出来的 overlay）并证明它被追加进 `createAgent()` 的 `systemPromptOverlays`。

第四步，更新 `docs/plugins.md`，明确标注 v2 仍是 opt-in，描述 lifecycle、diagnostics、以及 plugin skills 可见性的实现方式，并给出一个最小示例与一个本地运行测试的命令。

## Validation and Acceptance

v2 MVP 的验收标准是行为可验证，而不是“代码存在”：

1) 执行 `pnpm --filter @hijarvis/jar-core test` 通过，并至少包含：
   - lifecycle 测试：install/cleanup 调用次数正确，顺序可断言；
   - failure isolation 测试：broken plugin 产生 diagnostics，且默认不导致测试进程直接崩溃；
   - 集成测试：在显式传入 hooks 的情况下，plugin hook 能改变 response，且 overlay 注入闭环可观测。

2) 行为确定性：插件 load 顺序稳定；diagnostics 的生成顺序稳定；当出现冲突（例如 duplicate plugin name 或 duplicate skill name）时，diagnostics 的输出稳定且可断言。

3) `docs/plugins.md` 描述 v2 的行为与边界，并至少包含一个最小 plugin 示例和一条测试命令。

## Idempotence and Recovery

所有步骤都应可重复执行。测试写临时文件到 OS temp 目录并清理。如果遇到 ESM module caching 导致重跑行为不一致，测试侧应通过 unique file URL（例如 `file://.../plugin.mjs?cacheBust=...`）规避同一 module instance 复用。

如果重构导致测试失败，恢复路径是：优先回滚 `packages/jar-core/src/plugins/` 内的改动到最近一次通过测试的状态，再继续推进下一步。

## Artifacts and Notes

预期测试输出形态（示例）：

    > pnpm --filter @hijarvis/jar-core test
    ...
    ok  - plugins/manager.test.ts
    ok  - plugins/integration.test.ts

随着实现推进，会把关键输出片段补充到这里，作为行为证据。

## Interfaces and Dependencies

在 MVP 结束时，应该存在并可被测试依赖的类型与接口如下（名称可微调，但语义必须满足）。

In `packages/jar-core/src/plugins/types.ts`, define:

    export type PluginContribution = {
      skillRoots?: string[];
      overlays?: PromptSection[];
    };

    export type PluginDiagnostic = {
      pluginName?: string;
      modulePath: string;
      phase: "import" | "create" | "install" | "contribution_merge" | "shutdown";
      level: "info" | "warn" | "error";
      message: string;
    };

In `packages/jar-core/src/plugins/manager.ts`, define:

    export type PluginManagerOptions = {
      config: LoadedRuntimeConfig;
      hooks: HookRegistry;
      logger?: Logger;
      defaultFailureMode?: "isolate" | "fail_fast";
    };

    export type PluginManager = {
      load(): Promise<void>;
      getContributions(): PluginContribution;
      getDiagnostics(): PluginDiagnostic[];
      shutdown(): Promise<void>;
    };

Dependencies:

- Use existing `HookRegistry` from `packages/jar-core/src/hooks`.
- Use existing skill discovery helpers from `packages/jar-core/src/skills.ts` (scan `SKILL.md` from roots).
- Use existing prompt section type `PromptSection` from `packages/jar-core/src/prompt-builder.ts`.
- For tests, use Node’s `node:test` and filesystem temp directories (consistent with existing tests in `jar-core`).

Revision note (2026-04-14 10:04Z): Initial ExecPlan draft created to design and implement plugin architecture v2 without changing current app runtime wiring.
Revision note (2026-04-14 10:09Z): Rewrote prose into Chinese to match repo conventions for Markdown docs; reduced MVP scope (dropped `tools` contribution and `module-resolution`), and clarified the minimal overlay strategy to avoid a large `loadRuntimeConfig()` refactor.
Revision note (2026-04-16 03:20Z): Updated the `PluginContribution` skills field to `skillRoots` to match the unified skill discovery model implemented in `jar-core`.
