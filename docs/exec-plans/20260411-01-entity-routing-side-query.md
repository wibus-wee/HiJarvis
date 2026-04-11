# Add Entity Routing And Side Query Execution

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This document must be maintained in accordance with `/Users/wibus/.agents/skills/execplan/references/PLANS.md`. The non-negotiable requirements that shape this plan are: the plan must be self-contained, it must guide a novice without relying on prior chat context, it must define concrete user-visible outcomes, it must name exact files and commands, it must describe safe retry and recovery behavior, and it must keep the living sections up to date as implementation proceeds.

## Purpose / Big Picture

After this change, HiJarvis will no longer treat every Slack thread or Telegram conversation as an isolated bot identity. Instead, the system will support stable Jarvis entities that can be bound to multiple surfaces, and users will be able to issue a side query to a bound entity without contaminating that entity's main working thread. The first user-visible outcome is that a Telegram user can address a specific Jarvis entity by name and ask a short side question against that entity's current working thread, even if the entity's active work is happening on another surface.

Someone verifying this work should be able to configure at least one named entity in `jar.toml`, start the Telegram or Slack gateway, create a normal conversation for that entity, then issue a side-query command such as `/btw jarvis-a what are you working on?` and observe a short reply that is derived from the entity's live thread but does not get appended to that thread's normal transcript.

## Progress

- [x] (2026-04-11 00:00Z) Read the current runtime, session, Slack, and Telegram code to identify the real routing boundary.
- [x] (2026-04-11 00:05Z) Confirmed that current continuity is keyed directly by platform-derived `sessionId`, so an entity layer must be added above sessions.
- [x] (2026-04-11 00:10Z) Drafted this ExecPlan with a deliberately narrow scope: entity routing plus side query only.
- [x] (2026-04-11 00:20Z) Implemented minimal entity config and runtime model in `packages/jar-core/src/config.ts` and `jar.example.toml`, including a safe default `jarvis` entity when no explicit entities are configured.
- [x] (2026-04-11 00:30Z) Implemented entity/surface routing above `sessionId` in `packages/jar-core/src/entity-routing.ts`.
- [x] (2026-04-11 00:40Z) Implemented side-query execution mode in `packages/jar-core/src/session-executor.ts` that reads from a source session without appending to that session transcript.
- [x] (2026-04-11 00:50Z) Wired Telegram and Slack entrypoints through entity routing and added explicit `/btw` handling.
- [x] (2026-04-11 01:00Z) Added config/routing tests and updated runtime plus gateway docs.
- [x] (2026-04-11 01:05Z) Ran `pnpm --filter jar-core check`, `pnpm --filter @hijarvis/jar-telegram check`, and `pnpm --filter @hijarvis/jar-slack check` successfully.
- [ ] Re-run `pnpm --filter jar-core test` in an environment with the OpenAI API key required by the pre-existing `web_search` tests, or mark those tests as environment-gated in a separate change.

## Surprises & Discoveries

- Observation: Current HiJarvis does not have any product-level identity object above sessions. The smallest durable unit is a `sessionId`, and gateways derive that `sessionId` directly from surface-local coordinates.
  Evidence: `apps/jar-slack/src/slack-prompt.ts` defines `createSlackSessionId(...)`, `apps/jar-telegram/src/telegram-prompt.ts` defines `createTelegramSessionId(...)`, and both gateways pass those values into `executePromptInSession(...)`.

- Observation: The existing execution stack is already centralized enough that side query can be added as a sibling execution path rather than a gateway-specific hack.
  Evidence: `packages/jar-core/src/session-executor.ts` is the single normal-turn execution path used by both Slack and Telegram.

- Observation: The current test suite already contains unrelated `web_search` tests that require a live OpenAI API key, so `jar-core` test completion is partially environment-bound even when the new entity/side-query changes are correct.
  Evidence: `pnpm --filter jar-core test` now passes all new config/routing tests and fails only in `src/tools/web-search-tool.test.ts` with `OpenAI API key is required for web_search`.

## Decision Log

- Decision: Introduce a stable entity layer above sessions rather than trying to reinterpret existing session ids as identities.
  Rationale: Current session ids encode surface-local coordinates, so using them as identities would permanently couple the product model to platform-specific thread structure.
  Date/Author: 2026-04-11 / OpenCode

- Decision: Side query will be implemented as a separate execution mode, not as a normal turn with special prompt text.
  Rationale: A normal turn writes to transcript and snapshot state, which is exactly what side query is meant to avoid.
  Date/Author: 2026-04-11 / OpenCode

- Decision: This plan intentionally stops before agent-to-agent short ask.
  Rationale: Cross-agent contact depends on entity routing and side query, but it is a larger behavior package that should be validated only after side query itself works.
  Date/Author: 2026-04-11 / OpenCode

- Decision: Keep the first entity-aware routing model additive by deriving entity thread session ids from `entity + surface + scope`, while leaving the underlying session store unchanged.
  Rationale: This keeps existing filesystem-backed session persistence intact and makes the new identity layer a narrow routing concern instead of a storage rewrite.
  Date/Author: 2026-04-11 / OpenCode

- Decision: Make ordinary platform turns route to the configured default entity for now, and reserve natural-language entity selection for a later iteration.
  Rationale: The current goal is to establish the entity layer and side-query path with minimal ambiguity; explicit `/btw <entity> ...` is enough for the first identity-aware slice.
  Date/Author: 2026-04-11 / OpenCode

## Outcomes & Retrospective

The first implementation slice is complete. HiJarvis now has a stable entity layer in config, a routing module above sessions, and a side-query execution path that reads from an entity thread without appending to that thread's transcript. Telegram and Slack both route normal turns through the default entity and now support explicit `/btw <entity> <question>` side queries.

The main remaining gap is not feature completeness within this plan's scope, but test environment portability. `jar-core` typecheck passes, and the app typechecks for Telegram and Slack pass. The remaining `jar-core` test failures come from pre-existing `web_search` tests that require an OpenAI API key, not from the new entity-routing or side-query code.

## Context and Orientation

HiJarvis is a TypeScript monorepo. The shared runtime lives in `packages/jar-core/src/`. The Slack gateway lives in `apps/jar-slack/src/slack-runtime.ts`. The Telegram gateway lives in `apps/jar-telegram/src/telegram-runtime.ts`. Both gateways currently normalize incoming platform events, build a prompt, derive a surface-specific `sessionId`, and call `executePromptInSession(...)` from `packages/jar-core/src/session-executor.ts`.

The phrase “entity” in this plan means a stable Jarvis identity such as `jarvis-a`. An entity is not a session and not a platform account. The phrase “surface” means one product entry point such as a Telegram chat or a Slack thread. The phrase “thread” means an entity's local, ongoing conversation context on one surface. In the current codebase, threads are stored as sessions. This plan keeps that storage model, but inserts routing logic above it so that the system can answer “which entity is this message for?” and “which thread should a side query read from?” without inventing any snapshot-style state object.

The key current files are:

- `packages/jar-core/src/config.ts`: parses `jar.toml` and builds the loaded runtime config.
- `packages/jar-core/src/runtime.ts`: creates an `Agent` with shared tools, system prompt, and compaction behavior.
- `packages/jar-core/src/session-executor.ts`: executes a normal prompt inside a persistent session and writes transcript, snapshot, turn, run, and item records.
- `packages/jar-core/src/session-store.ts`: stores transcript and session metadata keyed by `sessionId`.
- `apps/jar-slack/src/slack-runtime.ts`: Slack event handling and current thread-to-session mapping.
- `apps/jar-telegram/src/telegram-runtime.ts`: Telegram event handling and current conversation-to-session mapping.
- `apps/jar-slack/src/slack-prompt.ts` and `apps/jar-telegram/src/telegram-prompt.ts`: current helpers that derive surface-based session ids.

The smallest useful product slice is not cross-surface shared memory. It is the ability to bind one entity to multiple surfaces while preserving local threads per surface, then run a side query against an entity's active thread without contaminating that thread's normal history.

## Plan of Work

First, extend configuration in `packages/jar-core/src/config.ts` so the runtime can describe named entities and their allowed surface bindings. Keep the format deliberately minimal. The global provider, model, tools, and execution settings should remain shared. Entity configuration should add only the data needed to identify an entity, vary its prompt if needed, and bind it to one or more surfaces.

Second, add a routing layer in `packages/jar-core/src/` that resolves a platform event into two things: the target entity and the target session id for that entity's local thread on that surface. The routing layer must also be able to answer the reverse query needed by side query: given an entity id, find that entity's most recent active thread session. This routing layer should be implemented as a thin abstraction above `session-store.ts`, not as a replacement for it.

Third, implement a side-query execution path in `packages/jar-core/src/session-executor.ts` or a sibling module. This execution path must build an agent from the target entity's config, load the target session's messages as read-only input, run a single short answer, and return that answer without appending messages or writing a new snapshot for the target session. It may record a lightweight side-query audit event in a separate place if needed, but it must not mutate the target thread transcript.

Fourth, wire Slack and Telegram through the new router. Normal incoming turns should continue to create or use the correct session for the target entity on that surface. Add an explicit `/btw <entity> <question>` command in Telegram and Slack that resolves the named entity and runs the side-query path against that entity's most recent active thread.

Fifth, update tests and documentation. The config tests must prove that entities parse correctly. New routing tests must prove that entity-plus-surface resolution produces stable session ids and can locate a most-recent active thread. Execution tests must prove that side query returns a reply without modifying the target transcript. Gateway tests should cover command parsing where practical.

## Concrete Steps

All commands run from `/Users/wibus/dev/HiJarvis`.

1. Read the current files before editing.

   `read packages/jar-core/src/config.ts`
   `read packages/jar-core/src/session-executor.ts`
   `read packages/jar-core/src/session-store.ts`
   `read apps/jar-slack/src/slack-runtime.ts`
   `read apps/jar-telegram/src/telegram-runtime.ts`

2. Add entity configuration and shared routing modules under `packages/jar-core/src/`.

   Expected new or updated files:

   - `packages/jar-core/src/config.ts`
   - `packages/jar-core/src/entity-routing.ts`
   - `packages/jar-core/src/index.ts`
   - `jar.example.toml`

3. Add side-query execution support.

   Expected new or updated files:

   - `packages/jar-core/src/session-executor.ts`
   - possibly `packages/jar-core/src/session-executor.test.ts`

4. Rewire Slack and Telegram to use routing and `/btw`.

   Expected updated files:

   - `apps/jar-slack/src/slack-runtime.ts`
   - `apps/jar-telegram/src/telegram-runtime.ts`
   - prompt helper files if session id helpers move or become router-backed

5. Update docs.

   Expected updated files:

   - `docs/configuration.md`
   - `docs/agent-runtime.md`
   - `docs/slack-gateway.md`
   - `docs/telegram-gateway.md`
   - `docs/README.md` if a new standalone doc is added

6. Run tests.

   Minimum required:

   `pnpm --filter jar-core test`

   Recommended after gateway edits:

   `pnpm --filter @hijarvis/jar-telegram test`
   `pnpm --filter @hijarvis/jar-slack test`
   `pnpm -r tsc --noEmit`

## Validation and Acceptance

Acceptance is based on observable behavior.

First, config parsing must succeed with at least one named entity and one surface binding. A config test should prove that `loadRuntimeConfig(...)` returns the expected entity objects and that legacy single-agent config still loads when the new entity section is absent.

Second, normal turns must still work. After starting either gateway and sending a normal message to a bound entity, the system should continue to create or reuse a persistent session and append to its transcript as before.

Third, side query must be demonstrably non-persistent. After creating a normal thread for `jarvis-a`, run `/btw jarvis-a what are you working on?` from a bound surface. The reply should mention the live thread's context. Afterward, reopening the target session should show that the side-query prompt and reply were not appended as normal messages.

Fourth, cross-surface access must work at the entity layer. A Telegram `/btw jarvis-a ...` command should be able to resolve the active thread for `jarvis-a` even if that active thread lives on Slack, provided the entity is configured for both surfaces.

Fifth, failures must be explicit. If `/btw` names an unknown entity or an entity with no active thread, the gateway should return a short human-readable error instead of inventing an answer.

## Idempotence and Recovery

This work is safe to perform incrementally. Existing sessions remain valid because the underlying session store is not being replaced. If routing code is partially implemented, the safe fallback is to keep the old direct session-id path in place until both gateways compile against the new router. Config changes should be additive: when entity config is absent, the system should preserve the existing single-agent behavior. If a side-query path fails mid-implementation, it should be possible to delete only the new `/btw` wiring while leaving the entity-aware normal-turn routing intact.

## Artifacts and Notes

Expected important artifacts after implementation include:

- a new routing module that maps `entity + surface + thread key` to stable session ids
- config examples showing one entity bound to Telegram and Slack
- tests proving side query does not mutate the target transcript

Expected proof transcript after implementation:

   $ pnpm --filter jar-core test
   ...
   pass ...

   Telegram:
   /btw jarvis-a what are you working on?
   Jarvis A: I am currently drafting the Slack thread response about ...

   Reopen target session:
   side-query prompt absent from transcript

## Interfaces and Dependencies

Use existing dependencies only. This feature should build on `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, and the current filesystem-backed session store.

At the end of this plan, the codebase should expose concepts equivalent to the following:

In `packages/jar-core/src/config.ts`, define stable loaded config types that include entity definitions and bindings.

In `packages/jar-core/src/entity-routing.ts`, define exported functions equivalent to:

    resolveEntityForSurface(...)
    resolveThreadSessionId(...)
    findMostRecentEntityThread(...)

In `packages/jar-core/src/session-executor.ts`, define a side-query entry point equivalent to:

    executeSideQueryInSession(...): Promise<{ outputText: string; entityId: string; sessionId: string }>

In gateway code, `/btw <entity> <question>` must route to the new side-query entry point rather than the normal prompt execution path.

Revision note: Updated after implementation to record completed entity config, routing, side-query execution, Telegram/Slack `/btw` wiring, passing typechecks, and the remaining unrelated `web_search` test environment dependency.
