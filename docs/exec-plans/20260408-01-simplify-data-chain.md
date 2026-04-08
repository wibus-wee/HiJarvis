# Simplify the Config → Session Data Chain

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

## Purpose / Big Picture

At present the data chain from `loadRuntimeConfig()` to `executePromptInSession()` is tangled in three ways that make the code hard to read and maintain, and one way that is a functional bug:

1. `LoadedRuntimeConfig` has a nested field called `.runtime` whose type is most of `JarRuntimeOptions` — so every read looks like `config.runtime.runtime.provider`.
2. `SessionPromptOptions` is a manual flat copy of almost every field in `JarRuntimeOptions`. Every gateway call site spreads `...runtime.runtime` and then re-passes `skills`, `toolOptions`, and `sessionsRootDir` individually — four identical boilerplate blocks across four call sites.
3. Skills catalog overlays are already embedded in `agent.systemPromptOverlays` by `loadRuntimeConfig`, but `executePromptInSession` re-computes and appends them a second time — functional duplication that can cause double injection.
4. `compaction` defaults silently inside `createAgent` when it should be normalised once at `loadBaseConfig` time.
5. `writers` has a working default of `{ stderr: process.stderr }` yet every caller passes exactly that value and the parameter never needs to be overridden externally.

After this change a caller replaces ~15 spread fields with a single `config` argument:

    // before
    executePromptInSession({
      ...runtime.runtime,
      skills: runtime.skills,
      toolOptions: runtime.toolOptions,
      sessionsRootDir: runtime.sessions.rootDir,
      sessionId,
      prompt,
      skillTriggerText,
      turnTrigger: "platform_event",
      writers: { stderr: process.stderr },
      logger,
      turnInputMetadata: { ... },
      onEvent,
    })

    // after
    executePromptInSession({
      config: runtime,
      sessionId,
      prompt,
      skillTriggerText,
      turnTrigger: "platform_event",
      logger,
      turnInputMetadata: { ... },
      onEvent,
    })

Verification: `pnpm -r tsc --noEmit` reports zero type errors after all changes.

## Progress

- [x] (2026-04-08) Wrote ExecPlan.
- [x] (2026-04-08) Renamed `LoadedBaseConfig.runtime` / `LoadedRuntimeConfig.runtime` → `.agent`. Updated `config.ts`, `config.test.ts`.
- [x] (2026-04-08) Applied `defaultCompactionSettings` at `loadBaseConfig` time, removed silent fallback in `createAgent` and `session-executor`.
- [x] (2026-04-08) Replaced `SessionPromptOptions` with slim type taking `config: LoadedRuntimeConfig`. Fixed double skills injection inside `executePromptInSession`. Removed `writers` parameter.
- [x] (2026-04-08) Updated all four call sites: `telegram-runtime.ts`, `slack-runtime.ts`, `wechat-runtime.ts`, `jar-cli/main.ts`.
- [x] (2026-04-08) Updated `index.ts` exports (`createTools` alias removed, export `SessionPromptOptions`).
- [x] (2026-04-08) Ran `pnpm -r tsc --noEmit` — zero errors.
- [x] (2026-04-08) Updated docs (`agent-runtime.md`, `configuration.md`).

## Surprises & Discoveries

- The `config.test.ts` file already had a test asserting `config.runtime.compaction` equals `defaultCompactionSettings` when no compaction block is in the TOML, which confirmed that the default should be applied in `loadBaseConfig` rather than silently in `createAgent`.
- `jar-cli/main.ts` REPL path calls `createAgent` directly and does `...config.runtime` — after rename this becomes `...config.agent`.
- `export { createTools }` from `index.ts` was an undocumented alias for `createDefaultTools`; the CLI used `createTools` so this had to be checked carefully.

## Decision Log

- Decision: Rename `.runtime` sub-object to `.agent` in `LoadedBaseConfig` / `LoadedRuntimeConfig`.
  Rationale: Eliminates the `config.runtime.runtime.*` access pattern. The name `agent` matches the TOML `[agent]` section it corresponds to.
  Date/Author: 2026-04-08

- Decision: Keep `skillTriggerText` as an optional field in the new `SessionPromptOptions`.
  Rationale: Gateways derive it differently (Slack combines skipped messages, Telegram uses the message text), so it cannot always be derived from `prompt`. When absent, `preparePromptWithSkills` simply skips skill matching.
  Date/Author: 2026-04-08

- Decision: Keep `turnTrigger` as an explicit optional field with default `"user_input"`.
  Rationale: Gateways pass `"platform_event"` to distinguish gateway-sourced turns from user-typed turns in session analytics. Keeping the field visible prevents callers from accidentally using the wrong default.
  Date/Author: 2026-04-08

- Decision: Remove `writers` from `SessionPromptOptions` entirely.
  Rationale: Every caller passed `{ stderr: process.stderr }` which is already the default. The abstraction added no value; removing it simplifies the public API.
  Date/Author: 2026-04-08

- Decision: Remove `tools` escape hatch from `SessionPromptOptions`.
  Rationale: No caller ever passed `tools` directly through the session path. The escape hatch existed alongside `toolOptions` but was dead code. If an advanced caller needs custom tools, they should call `createAgent` + `executePromptWithPolicy` directly.
  Date/Author: 2026-04-08

- Decision: Keep `serializeMessage` as an optional override.
  Rationale: The WeChat gateway needs to sanitize messages before they are persisted. This is a legitimate per-platform customization.
  Date/Author: 2026-04-08

## Outcomes & Retrospective

(To be filled in after completion.)

## Context and Orientation

The repository is a monorepo with one library package (`packages/jar-core`) and four application packages (`apps/jar-cli`, `apps/jar-slack`, `apps/jar-telegram`, `apps/jar-wechat`). TypeScript is compiled with `tsc`; tests run with `node:test`.

Key files modified by this plan:

- `packages/jar-core/src/config.ts` — defines `LoadedBaseConfig`, `LoadedRuntimeConfig`, `loadBaseConfig`, `loadRuntimeConfig`.
- `packages/jar-core/src/config.test.ts` — tests referencing `config.runtime.*` need updating to `config.agent.*`.
- `packages/jar-core/src/runtime.ts` — `createAgent` receives `JarRuntimeOptions` (which now always has `compaction` defined).
- `packages/jar-core/src/session-executor.ts` — `SessionPromptOptions` and `executePromptInSession` implementation.
- `packages/jar-core/src/index.ts` — public exports.
- `apps/jar-telegram/src/telegram-runtime.ts` — call site.
- `apps/jar-slack/src/slack-runtime.ts` — call site.
- `apps/jar-wechat/src/wechat-runtime.ts` — call site.
- `apps/jar-cli/src/main.ts` — call sites (two: REPL path and session path).

## Plan of Work

### Step A — Rename `.runtime` → `.agent` in `LoadedBaseConfig` and `LoadedRuntimeConfig`

In `config.ts`, rename the field named `runtime` (the one of type `Omit<JarRuntimeOptions, "tools">`) to `agent` in both `LoadedBaseConfig` and `LoadedRuntimeConfig`. Update the property name in `loadBaseConfig` and in `loadRuntimeConfig`. Also update `LoadedAgentConfig` alias if present.

In `config.test.ts`, replace every occurrence of `config.runtime.` that refers to this sub-object with `config.agent.`.

In `jar-cli/main.ts`, update the REPL path where `createAgent({ ...config.runtime, ... })` is written.

### Step B — Apply `defaultCompactionSettings` at `loadBaseConfig` time

In `config.ts`, after building the `runtime: { ... }` block, set `compaction` to `parsedConfig.agent.compaction ? parseCompactionConfig(parsedConfig.agent) : defaultCompactionSettings`.

Change the type of `agent.compaction` in both `LoadedBaseConfig` and `LoadedRuntimeConfig` from `CompactionSettings | undefined` to `CompactionSettings` (always defined).

In `session-executor.ts`, remove the `const compactionSettings = options.compaction ?? defaultCompactionSettings;` fallback since it is now guaranteed to be defined.

In `runtime.ts` (`createAgent`), remove the `config.compaction ?? defaultCompactionSettings` fallback for the same reason. The type informs us it is always present.

Note: `JarRuntimeOptions.compaction` remains `CompactionSettings | undefined` for backward compatibility with direct `createAgent` callers; only the config-loaded path guarantees it is defined.

### Step C — Rebuild `SessionPromptOptions` and `executePromptInSession`

Replace the current ~20-field `SessionPromptOptions` type with:

    export type SessionPromptOptions = {
      config: LoadedRuntimeConfig;
      sessionId: string;
      prompt: PromptInput;
      onEvent?: (event: AgentEvent) => Promise<void> | void;
      skillTriggerText?: string;
      turnTrigger?: SessionTurnTrigger;
      turnInputMetadata?: Record<string, unknown>;
      serializeMessage?: (message: AgentMessage) => AgentMessage;
      logger?: Logger;
    };

Inside `executePromptInSession`, extract `provider`, `model`, `systemPrompt`, `systemPromptOverlays`, `thinkingLevel`, `providerConfig`, `execution`, `compaction` from `options.config.agent`. Extract `toolOptions` from `options.config.toolOptions`. Extract `sessionsRootDir` from `options.config.sessions.rootDir`. Extract `skills` from `options.config.skills`.

Fix the double skills injection: `config.agent.systemPromptOverlays` already contains the catalog via `loadRuntimeConfig`. Therefore, in `executePromptInSession`, do NOT call `getSkillsCatalogOverlays` again. Use `options.config.agent.systemPromptOverlays` directly as the system prompt overlays passed to `createAgent`.

Remove the `writers` parameter — always use `defaultWriters`.

### Step D — Update all four call sites

Update `telegram-runtime.ts`, `slack-runtime.ts`, `wechat-runtime.ts`, and `jar-cli/main.ts` to use the new signature as shown in the Purpose section above.

### Step E — Update `index.ts` exports

Ensure `SessionPromptOptions` is still exported. Check whether `createTools` alias (for `createDefaultTools`) is referenced anywhere and update or remove it.

### Step F — Validate with `tsc`

Run `pnpm -r tsc --noEmit` and fix any remaining type errors.

## Concrete Steps

All commands run from `/Users/wibus/dev/HiJarvis`.

    pnpm -r tsc --noEmit          # must show zero errors after each module is done

## Validation and Acceptance

Run `pnpm -r tsc --noEmit` from the repo root. Expect zero type errors. No runtime tests require live LLM access; the structural tests in `config.test.ts` validate the parsing logic.

## Idempotence and Recovery

All changes are file edits. If a step fails halfway, fix the offending file and re-run `tsc`.

## Artifacts and Notes

(Transcripts to be added during implementation.)

## Interfaces and Dependencies

After Step C, `SessionPromptOptions` in `packages/jar-core/src/session-executor.ts`:

    export type SessionPromptOptions = {
      config: LoadedRuntimeConfig;
      sessionId: string;
      prompt: PromptInput;
      onEvent?: (event: AgentEvent) => Promise<void> | void;
      skillTriggerText?: string;
      turnTrigger?: SessionTurnTrigger;
      turnInputMetadata?: Record<string, unknown>;
      serializeMessage?: (message: AgentMessage) => AgentMessage;
      logger?: Logger;
    };

After Step A, `LoadedRuntimeConfig` in `packages/jar-core/src/config.ts`:

    export type LoadedRuntimeConfig = {
      configFilePath: string;
      logging: { level: LogLevel; stderr: boolean; filePath?: string };
      agent: Omit<JarRuntimeOptions, "tools"> & { compaction: CompactionSettings };
      skills: SkillsRuntime;
      toolOptions: ToolOptions;
      sessions: { rootDir: string };
      platform: Record<string, unknown>;
    };
