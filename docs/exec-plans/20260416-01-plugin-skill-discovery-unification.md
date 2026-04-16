# Plugin Skill Discovery Unification

这是一份 living ExecPlan。`Progress`、`Surprises & Discoveries`、`Decision Log`、`Outcomes & Retrospective` 必须随着工作推进持续更新，且任何停顿点都要反映在 `Progress` 里。

本文档的目标是“可执行、可复用、可中断后继续”。也就是说：即使读者对本仓库完全陌生，只要按本文一步步执行，也能把变更做完并观察到行为生效；如果中途停下，重新打开本文也能知道下一步该做什么。

## Purpose / Big Picture

完成本次变更后，plugin 作者分享 skill 的方式会从“手写 `SkillEntry` 元数据”切换为“提供 skill 根目录，由 `jar-core` 统一扫描 `SKILL.md` 并解析元数据”。这意味着 skill 的唯一真相重新回到 skill 文件本身，plugin 不需要重复声明 `name`、`description` 或 `allowImplicitInvocation`，用户也不会再遇到 plugin 返回值和 `SKILL.md` 内容不一致的问题。

你可以通过 `@hijarvis/jar-core` 的测试验证行为：plugin 只返回 `skillRoots`，runtime 会像处理 `[skills].roots` 一样扫描目录、把 skill 加入 catalog，并在显式提及 `$skill-name` 时读取对应 `SKILL.md` 正文注入当前 turn prompt。旧式 `skills: SkillEntry[]` 会被直接删除且不保留兼容层，因为该能力尚未正式发布、没有对外兼容负担。

## Progress

- [x] (2026-04-16 00:00Z) 审阅现有 plugin/skills 实现，确认当前模型是 plugin 直接返回 `SkillEntry[]`，而 skill 正文注入仍依赖 `SkillEntry.path` 指向的 `SKILL.md`。
- [x] (2026-04-16 00:07Z) 确认仓库已有 `docs/plugins.md` 示例与 `packages/jar-core/src/plugins/manager.ts` 收集逻辑，但该模型存在元数据重复与单一真相破坏的问题。
- [x] (2026-04-16 00:15Z) 起草本 ExecPlan，确定目标是“plugin 贡献 roots，core 统一 discovery”。
- [x] (2026-04-16 00:22Z) 根据最新约束更新方案，确认旧 `skills: SkillEntry[]` 直接删除，不保留 deprecated 兼容层。
- [x] (2026-04-16 03:20Z) 锁定新的 plugin contribution 形状与合并顺序，并在 `Decision Log` 记录“最终 skills runtime 的生成时序”（completed: plan update; remaining: code changes）。
- [ ] 实现 `skillRoots` discovery pipeline，覆盖 config roots 与 plugin roots 的统一扫描（completed: none; remaining: code + tests）。
- [ ] 删除旧 `skills: SkillEntry[]` plugin 接口、双轨 overlay 逻辑与相关文档示例（completed: none; remaining: code + tests + docs）。
- [ ] 更新 `docs/plugins.md`、`docs/configuration.md`、`docs/skills.md`，确保对外语义和实现一致（completed: none; remaining: docs update）。

## Surprises & Discoveries

- Observation: 当前 plugin skill 并不是真正的“内联 skill”；它只是让 plugin 手工构造 `SkillEntry`，而实际 skill 正文读取仍然统一走文件系统。
  Evidence: `packages/jar-core/src/skills.ts` 中 `resolveSkillPromptContext()` 会直接执行 `readFile(skill.path, "utf8")`。

- Observation: 当前 docs 与实现已经出现语义漂移。配置文档写的是 plugin 贡献 skills “不需要文件系统路径”，但运行时代码要求每个 plugin skill 必须提供 `path`。
  Evidence: `docs/configuration.md` 的 `[plugins]` 段落与 `packages/jar-core/src/skills.ts` / `packages/jar-core/src/plugins/types.ts` 不一致。

- Observation: plugin manager 现在会在贡献合并后额外渲染 plugin skills overlay，而 config roots 的 catalog overlay 是在 runtime config load 阶段更早生成的。这意味着 skill catalog 当前存在两个来源与两个时序。
  Evidence: `packages/jar-core/src/config.ts` 在 `loadRuntimeConfig()` 中调用 `getSkillsCatalogOverlays()`；`packages/jar-core/src/plugins/manager.ts` 在 `getContributions()` 中调用 `renderPluginSkillsOverlay()`。

## Decision Log

- Decision: 新模型以 `skillRoots?: string[]` 为 MVP，而不是直接一步抽象成通用 `SkillProvider` 接口。
  Rationale: 当前仓库的 skill 语义本身就是以 `SKILL.md` 目录约定为中心，最小正确重构是让 plugin 贡献 roots 并复用现有 discovery pipeline。直接引入 provider 抽象会扩大设计面，并把“远程技能”“数据库技能”这类未来需求提前带进当前改造。
  Date/Author: 2026-04-16 / OpenCode

- Decision: 旧 `skills?: SkillEntry[]` plugin 接口直接删除，不提供 deprecated 兼容层。
  Rationale: 这套 plugin skill 分享能力尚未正式发布，当前没有稳定的外部兼容性负担。继续保留旧接口只会把“双真相”和双轨 overlay 逻辑延续到新设计里，增加实现复杂度并稀释本次重构的目标。
  Date/Author: 2026-04-16 / OpenCode

- Decision: 统一后的 discovery 结果应该只进入一条 catalog/render/injection 管线，避免“config catalog overlay + plugin overlay”双轨并存。
  Rationale: 本次重构的目标不是只让 plugin 写法更好看，而是恢复 skill discovery 的单一真相。如果保留双轨 overlay，只是把重复从 plugin 作者手里转移到 runtime 内部。
  Date/Author: 2026-04-16 / OpenCode

- Decision: 最终 `SkillsRuntime` 在 plugin manager 完成 `load()` 后生成，并由该 runtime 同时驱动 catalog overlay 与 per-turn 正文注入。
  Rationale: 只有在 plugin contributions 可用之后才能拿到完整 roots 集合。将最终 runtime 的构建放到 plugin load 之后，可以避免“config load 先扫一遍 + plugin 再补一份”的双轨来源，并让 catalog 与注入天然共享同一份 entries。
  Date/Author: 2026-04-16 / OpenCode

## Outcomes & Retrospective

该部分会在实现推进后持续更新。

完成后，plugin 分享 skill 时只需要暴露 skill 目录（`skillRoots`），不再重复填写 metadata。config roots 与 plugin roots 会走完全相同的扫描、排序、catalog 渲染、正文加载与错误处理逻辑。文档、类型、测试与 runtime 行为也会重新一致，不再出现“文档说可以，代码实际上不支持”的情况。

## Context and Orientation

当前仓库里，“skill” 指一个以目录为单位组织的能力包，目录下至少有 `SKILL.md`。`SKILL.md` 的 frontmatter 承载 `name` 与 `description` 等元数据；如果该 skill 目录中还存在 `agents/openai.yaml`，runtime 会读取 `allow_implicit_invocation` 来决定它是否进入 catalog。运行时不会把所有 `SKILL.md` 正文长期塞进 prompt，而是只在当前用户显式提及 `$skill-name` 时按需读取正文，并作为只在当前 turn 生效的 prompt fragment 注入模型输入。

当前关键文件如下。

`packages/jar-core/src/skills.ts` 是现有的唯一 skill discovery 与 prompt injection 实现。它负责扫描 roots、解析 `SKILL.md`、生成 `SkillEntry[]`、渲染 catalog，并在每轮执行前根据用户文本决定要加载哪些 skill 正文。

`packages/jar-core/src/config.ts` 负责解析 `[skills]` 配置，并在 `loadRuntimeConfig()` 时提前扫描 `config.skills.roots`，生成基础 catalog overlay。

`packages/jar-core/src/plugins/types.ts` 定义 plugin 可以返回什么贡献。旧接口允许 plugin 直接返回 `skills?: SkillEntry[]`；本次改造会用 `skillRoots?: string[]` 替换并切除该字段。

`packages/jar-core/src/plugins/manager.ts` 负责加载 plugin、收集贡献，并额外把 plugin skills 渲染成单独的 overlay。这个行为是当前 skill 双轨来源的核心。

`packages/jar-core/src/execution-service.ts` 与 `packages/jar-core/src/runtime.ts` 负责在具体执行时把 skills runtime、plugin overlays、tools 等组合起来。

`docs/plugins.md`、`docs/configuration.md`、`docs/skills.md` 是对外文档。它们必须在这次重构中一起更新，因为现有问题有一部分已经体现在文档与实现失真上。

本文会使用几个术语。

“discovery” 指扫描 skill roots、找到 `SKILL.md`、解析 metadata、产生运行时 skill 列表的过程。

“catalog” 指 runtime 会暴露给模型的 skill 能力清单，通常以 system prompt overlay 的一段文本存在。

“overlay” 指一段会被追加到 system prompt 的文本片段（在本仓库中对应 `PromptSection`），用于让模型“看到”额外上下文。

“SkillsRuntime” 指一次扫描后的技能运行时视图（roots、entries、catalog、errors 与限制参数）。它既用于渲染 catalog，也用于根据 `$skill-name` 做正文注入。

“plugin root” 指 plugin 提供给 core 的一个目录路径，该目录及其子目录下可能包含多个 skill。

“旧接口” 指当前 `PluginInstallResult.skills?: SkillEntry[]` 这套直接由 plugin 手写 skill 元数据的贡献方式。本计划会直接删除它。

## Plan of Work

第一阶段先统一数据模型。修改 `packages/jar-core/src/plugins/types.ts`，在 `PluginInstallResult` 里新增 `skillRoots?: string[]`，并直接删除旧 `skills?: SkillEntry[]` 字段。与其让 plugin 作者直接理解 `SkillEntry` 的内部形状，不如让他们只负责指出 skill 文件所在目录。此处同时要同步收紧 manager-facing contribution 类型，让 `PluginContribution` 只携带 `skillRoots`，不再为旧接口保留数据形状。

第二阶段统一 discovery pipeline。核心目标是让 `[skills].roots` 与所有 plugin `skillRoots` 被合并成一份 roots 列表，然后统一调用 `packages/jar-core/src/skills.ts` 的扫描逻辑生成最终 `SkillsRuntime`。这里不应继续保留“config load 时扫一遍 + plugin manager 再额外渲染一段 overlay”的双轨模式。本计划选择把最终 runtime 的生成放到 plugin manager `load()` 之后（在执行管线初始化阶段完成），并确保后续所有 catalog 渲染与 prompt 注入都只消费这份最终 `SkillsRuntime`。

第三阶段删除旧路径并收拢渲染和注入逻辑。`packages/jar-core/src/plugins/manager.ts` 中专门为 plugin skills 调 `renderPluginSkillsOverlay()` 的逻辑应该被删除。任何读取 `pluginOverrides.skills`、或把 plugin skills 当成独立通道的地方也应一起移除。最终 catalog 渲染统一复用 `skills.ts` 的 catalog 渲染函数，`execution-service.ts`、`runtime.ts` 以及相关测试全部只消费统一后的 `SkillsRuntime`。

第四阶段补测试并修文档。测试重点不是“类型通过”，而是行为闭环：plugin 只给 root 时 skill 能被扫描出来；同一个 `SKILL.md` 改了 frontmatter 后 catalog 自动反映新值；旧 `skills` 接口在类型和运行时层面都不再存在；最终 prompt 注入只依赖统一后的 `SkillsRuntime`。文档要明确新写法，并解释为什么 plugin 不再直接返回 `SkillEntry[]`。

## Concrete Steps

下面所有命令都在仓库根目录 `/Users/wibus/dev/HiJarvis` 执行。

第一步，阅读并确认现有相关实现，确保改造入口准确。

    pnpm exec rg -n "skillRoots|skills\?: SkillEntry\[]|renderPluginSkillsOverlay|resolveSkillsRuntime|getSkillsCatalogOverlays" packages/jar-core/src docs

预期会看到 `packages/jar-core/src/plugins/types.ts`、`packages/jar-core/src/plugins/manager.ts`、`packages/jar-core/src/skills.ts`、`packages/jar-core/src/config.ts`、`docs/plugins.md` 等文件命中。

第二步，修改 plugin 类型与 manager contribution 形状。需要编辑：

    packages/jar-core/src/plugins/types.ts
    packages/jar-core/src/plugins/manager.ts

完成后可用 TypeScript 检查或测试快速发现类型断裂：

    pnpm --filter @hijarvis/jar-core test -- --runInBand

如果当前测试 runner 不支持 `--runInBand`，则直接运行：

    pnpm --filter @hijarvis/jar-core test

第三步，统一 roots discovery 与最终 skills runtime 的构建。需要编辑：

    packages/jar-core/src/config.ts
    packages/jar-core/src/skills.ts
    packages/jar-core/src/runtime.ts
    packages/jar-core/src/execution-service.ts
    packages/jar-core/src/plugins/manager.ts

如果需要新增辅助函数，优先放在 `packages/jar-core/src/skills.ts`，例如“从 roots 解析 entries”或“合并 config roots 与 plugin roots 并产出稳定排序”。避免把 skill discovery 再复制一份到 plugins 目录。

第四步，增加或更新测试。优先在以下文件中补齐用例；如果现有测试组织不合适，可新增相邻测试文件。

    packages/jar-core/src/plugins/manager.test.ts
    packages/jar-core/src/skills.test.ts
    packages/jar-core/src/execution-service.test.ts

新增的测试场景至少应包括：

1. plugin 返回 `skillRoots`，目录内 skill 会进入最终 catalog。
2. plugin 不再需要手写 `name` / `description`；修改 `SKILL.md` frontmatter 后最终 entries 自动更新。
3. 旧 `skills` 接口在类型检查和运行时代码路径中都已不存在，相关旧测试和示例已被替换。
4. 显式提及 `$skill-name` 时，正文读取来自统一后的最终 skill entry，而不是 plugin 独立通道。

第五步，更新文档。

    docs/plugins.md
    docs/configuration.md
    docs/skills.md

文档完成后，再次运行测试：

    pnpm --filter @hijarvis/jar-core test

如果仓库包含 lint 或 typecheck 脚本，并且这些脚本目前对文档改动无副作用，再运行：

    pnpm lint
    pnpm typecheck

只有在仓库根 `package.json` 确认存在这些脚本时才执行；如果不存在，不要新增临时脚本。

## Validation and Acceptance

本计划的验收标准是可观察的统一行为，而不是仅仅“删掉了一个字段”。实现完成后，一个最小 demo plugin 应该能只通过返回 `skillRoots` 分享 skill，且 skill 元数据全部来自磁盘中的 `SKILL.md`。验证方式如下。

先运行 `@hijarvis/jar-core` 的测试命令：

    pnpm --filter @hijarvis/jar-core test

预期至少包含与 plugin skills、skills discovery、execution service 相关的通过用例，且新加测试在改造前失败、改造后通过。

如果增加了专门的集成测试，成功输出应类似：

    ok  - packages/jar-core/src/plugins/manager.test.ts
    ok  - packages/jar-core/src/skills.test.ts
    ok  - packages/jar-core/src/execution-service.test.ts

行为层面的 acceptance 需要证明三件事。

第一，plugin 可以只贡献目录，不需要重复填写 metadata。这个结论由测试中的临时 plugin + 临时 `SKILL.md` 目录证明。

第二，catalog 与正文加载共享同一来源。也就是说，测试里修改 `SKILL.md` frontmatter 或正文后，最终 entries 与 prompt 注入都反映变化，而不是仍然沿用 plugin 返回的旧值。

第三，旧接口被彻底切除。也就是说，类型定义、plugin manager、runtime、文档与测试中都不再出现“plugin 直接返回 `skills: SkillEntry[]`”这条路径。

文档层面的 acceptance 是：`docs/plugins.md` 不再教用户手写 `SkillEntry` 作为首选用法，`docs/configuration.md` 不再出现与实现冲突的“无需文件系统路径”描述，`docs/skills.md` 会明确 plugin roots 与 config roots 现在共享同一条 discovery pipeline。

## Idempotence and Recovery

本次改造应保持可重复执行。测试如果需要写临时 plugin 模块与 skill 目录，必须使用 OS temp 目录并在测试结束后清理。若遇到 Node ESM cache 导致同路径测试模块被复用，使用唯一文件名或 query string 的 file URL 避免缓存污染。

实现过程中的风险点有两个。第一个风险是 runtime 初始化顺序变化导致既有 catalog overlay 为空或重复。恢复路径是先让最终 skills runtime 在 plugin manager load 之后重新构建，并用测试锁住唯一来源，再继续删除旧 overlay 逻辑。第二个风险是 roots 合并顺序不稳定，导致 catalog 顺序相关测试偶发失败。恢复路径是把最终 roots 合并与 entries 排序集中到单个 helper 中，不要在 config、plugin manager、execution service 三处各自拼接数组。

如果某一步做到一半导致类型错误或测试广泛失败，优先回退到“类型层先引入 `skillRoots`，但旧运行时路径尚未完全删除”的短暂中间状态，并尽快在同一分支内完成删除收口。由于该功能未发布，不建议长期保留这种半切换状态。

## Artifacts and Notes

当前行为的关键证据片段如下。

`packages/jar-core/src/skills.ts` 证明 prompt 注入最终仍然从磁盘读取 skill 正文：

    const rawContents = await readFile(skill.path, "utf8");

`docs/plugins.md` 当前示例要求 plugin 作者自己拼出 `SkillEntry`：

    return {
      skills: [{
        name: "vector-memory",
        description: "Search semantic memory via Qdrant",
        path: path.join(..., "SKILL.md"),
        allowImplicitInvocation: true,
      }],
    };

这正是本次重构要消除的重复声明。

期望的最小新示例形态应接近：

    export const createPlugin = (): JarPlugin => ({
      name: "my-skill-plugin",
      install() {
        return {
          skillRoots: [path.join(path.dirname(fileURLToPath(import.meta.url)), "skills")],
        };
      },
    });

目录结构应类似：

    my-plugin/
      src/plugin.ts
      skills/
        vector-memory/
          SKILL.md
          agents/openai.yaml

## Interfaces and Dependencies

在 `packages/jar-core/src/plugins/types.ts` 中，最终应存在如下语义的接口。名称可微调，但职责不能变。

    export type PluginInstallResult = {
      skillRoots?: string[];
      overlays?: PromptSection[];
      tools?: AgentTool[];
      memoryProvider?: MemoryProviderFactory;
      cleanup?: () => void | Promise<void>;
    };

    export type PluginContribution = {
      skillRoots: string[];
      overlays: PromptSection[];
      tools: AgentTool[];
      memoryProvider?: MemoryProviderFactory;
    };

在 `packages/jar-core/src/skills.ts` 中，需要提供一组足以支持统一 discovery 的公共 helper。名称不必完全相同，但应满足以下职责：

    resolveSkillsRuntime(input, configDirectory)
    loadSkillsFromRoots({ roots, maxScanDepth, maxSkills })
    renderSkillsCatalog(entries, maxCatalogChars)

如果需要新增 helper，建议提供一个“合并 roots 并产出稳定去重结果”的函数，但不再需要处理 legacy/discovered 双来源冲突。

在 `packages/jar-core/src/plugins/manager.ts` 中，`getContributions()` 必须返回 `skillRoots`。manager 不应该继续作为最终 skills catalog 的唯一渲染者，也不再接受 legacy `skills`。

在 `packages/jar-core/src/config.ts` 与 `packages/jar-core/src/runtime.ts` 中，最终运行时必须只持有一份合并后的 `SkillsRuntime`。如果需要新增一个“finalize skills runtime with plugin contributions”的步骤，该步骤应该在 plugin manager 已 load 完成、但 agent 创建之前执行。

依赖约束如下。

- 继续使用现有 `packages/jar-core/src/skills.ts` 的 frontmatter / `agents/openai.yaml` 解析逻辑，不重新发明第二套 parser。
- 继续使用现有 `HookRegistry`、`PromptSection`、`AgentTool`、`MemoryProviderFactory` 类型。
- 测试继续使用仓库现有的 `node:test` 与 temp 目录写法，不引入额外测试框架。
- 文档更新必须同步覆盖 `docs/plugins.md`、`docs/configuration.md`、`docs/skills.md`，因为这三处共同定义了 plugin skill 的公开语义。

Revision note (2026-04-16 00:15Z): Initial ExecPlan created to replace plugin-contributed `SkillEntry[]` with plugin-contributed `skillRoots` and unify skill discovery.
Revision note (2026-04-16 00:22Z): Updated the plan to remove the deprecated compatibility layer entirely because plugin-contributed `skills: SkillEntry[]` has not shipped and can be cut directly.
Revision note (2026-04-16 03:20Z): Refactored wording for self-containment, added missing term definitions, and resolved the “final skills runtime build timing” ambiguity in `Decision Log`.
