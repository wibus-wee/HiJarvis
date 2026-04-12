# Rebuild HiJarvis As A Tape-Backed Lane Runtime

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This document must be maintained in accordance with `/Users/wibus/.agents/skills/execplan/references/PLANS.md`. The non-negotiable requirements that shape this plan are: the plan must be fully self-contained for a novice, it must describe observable behavior rather than internal intent alone, it must name exact files and commands, it must remain safe to retry, and it must keep the living sections accurate as implementation proceeds.

## Purpose / Big Picture

After this change, HiJarvis will stop treating `session.json.messages` as the authoritative conversation state and will instead use an append-only tape as the canonical source of truth for each conversation thread. Normal execution will run on a lane backed by tape entries and checkpoints, and recovery will materialize a view from tape rather than restoring a mutable snapshot as the product's real state. The user-visible outcome is that the runtime acquires the correct substrate for future live-lane fork features such as side ask, without implementing side ask itself in this plan.

Someone verifying this work should be able to create a normal Slack, Telegram, or CLI conversation, inspect the new on-disk lane storage, and observe that recovery happens from append-only tape records plus lane checkpoints rather than from a privileged `session.json` snapshot. They should also be able to trigger compaction and observe that the system appends a checkpoint record instead of rewriting the authoritative history in place.

## Progress

- [x] (2026-04-11 13:05Z) Re-read current session, runtime, compaction, and gateway architecture plus tape.systems concepts to confirm that the existing snapshot-backed model cannot support future live-lane forks.
- [x] (2026-04-11 13:10Z) Decided that this refactor is intentionally destructive: there is no legacy-data compatibility path because the user confirmed there is no old data to preserve.
- [x] (2026-04-11 13:30Z) Added failing tests for the new lane substrate: tape append/read, checkpoint-based materialization, and lane-backed execution tracking.
- [x] (2026-04-11 13:42Z) Created the first `packages/jar-core/src/lanes/` substrate with types, path layout, tape IO, materialization, and a lane-backed conversation handle.
- [x] (2026-04-11 13:55Z) Refactored normal execution to depend on a lane-backed conversation handle instead of `writeSnapshot(...)` semantics.
- [ ] Move normal prompt execution and compaction persistence onto tape-backed lanes (completed: `jar-core` normal executor path now opens `openConversationHandle(...)` and appends lane checkpoints; remaining: route adapters and docs through thread/lane terminology, then retire legacy session-store authority).
- [ ] Replace session-id-centric recovery assumptions with thread/lane terminology in routing and docs.
- [ ] Run focused tests and typechecks, record actual outcomes, and fix regressions.

## Surprises & Discoveries

- Observation: HiJarvis already has several append-only logs, but the real recovery boundary is still the mutable `session.json.messages` snapshot.
  Evidence: `packages/jar-core/src/session-store.ts` reconstructs state from `session.json` plus replay of later `messages.jsonl` records, and `docs/sessions.md` / `docs/compaction-architecture.md` explicitly describe that snapshot as the authoritative current context.

- Observation: The current side-query path is a read-only query over persisted transcript state, not a fork of live execution state.
  Evidence: `packages/jar-core/src/session-executor.ts` opens the source session, copies `sourceSession.messages`, disables tools, and never records a fork lineage or live-lane checkpoint.

- Observation: The compaction subsystem is already modular enough that the biggest persistence change is not inside the compaction algorithms themselves, but in how their results are recorded.
  Evidence: `packages/jar-core/src/compaction/*` already returns normalized compaction results and stage metadata; the old behavior comes from persisting compacted messages back into `session.json` in `packages/jar-core/src/session-executor.ts`.

- Observation: The most important seam was removing snapshot authority from the executor contract before deleting old session code. Once the normal execution path stopped calling `writeSnapshot(...)`, the lane substrate could coexist and be validated without a giant one-shot deletion.
  Evidence: `packages/jar-core/src/session-executor.ts` now opens `openConversationHandle(...)` from `packages/jar-core/src/lanes/handle.ts`, and focused `jar-core` lane/tracker tests pass with the normal path writing lane checkpoints instead of snapshots.

## Decision Log

- Decision: The first tape-backed runtime will support only one active `main` lane per thread and will not implement merge.
  Rationale: The user explicitly wants fork-only architecture for now and does not want schedule-driven shortcuts. Merge would expand the design surface dramatically and is unnecessary for the current goal.
  Date/Author: 2026-04-11 / OpenCode

- Decision: There will be no compatibility layer for old session data.
  Rationale: The user explicitly stated there is no old data and wants a destructive rebuild. Carrying migration code would preserve old conceptual boundaries and slow the redesign.
  Date/Author: 2026-04-11 / OpenCode

- Decision: Canonical tape recovery will be based on stable facts and checkpoints, not streaming delta events.
  Rationale: Streaming deltas remain valuable audit/observability data, but they are too unstable and too transport-shaped to serve as the authoritative rebuild substrate for future lane forks.
  Date/Author: 2026-04-11 / OpenCode

- Decision: Any cache or materialized head file is explicitly derived and non-authoritative.
  Rationale: The whole point of this refactor is to move truth from mutable snapshots to append-only tape entries. A cache may exist for performance but must never become authoritative again.
  Date/Author: 2026-04-11 / OpenCode

## Outcomes & Retrospective

Current midpoint outcome: the lane substrate exists under `packages/jar-core/src/lanes/`, focused tape/materialization tests pass, and the normal `executePromptInSession(...)` path now depends on a lane-backed conversation handle that appends checkpoints instead of calling `writeSnapshot(...)`. The remaining work is to propagate thread/lane terminology through routing and docs and then remove legacy session-store authority from the main runtime path.

## Context and Orientation

HiJarvis is a TypeScript monorepo. Shared runtime code lives in `packages/jar-core/src/`. Today the central persistence file is `packages/jar-core/src/session-store.ts`. That file owns path layout, metadata, transcript append, snapshot load/write, event append, audit append, and session listing. Recovery currently works like this: `openSession(...)` loads `session.json`, then replays later `messages.jsonl` records, and returns a `messages` array that becomes `agent.state.messages`. This makes the snapshot-backed message array the product's real current state.

The compaction subsystem lives under `packages/jar-core/src/compaction/`. It is already a staged subsystem with separate modules, but its persistence contract still assumes that compaction rewrites the authoritative message state by persisting a fresh compacted snapshot. `packages/jar-core/src/thread-executor.ts` is where prompt execution, event recording, final assistant message append, post-turn compaction, and snapshot persistence join together.

This plan uses plain-language terms with strict meanings. A `thread` is the stable identity of one conversation scope, such as a Slack thread or a Telegram chat/topic. A `lane` is a resumable execution lineage within that thread. In this first implementation, every thread has one active `main` lane only. A `tape` is the append-only sequence of immutable facts recorded for a lane. A `checkpoint` is a tape record that captures a materialized head after a compaction or other reconstruction boundary. A `view` is the message array assembled from tape and checkpoints for a specific execution need. A `cache` is an optional derived file written for performance only; it is never the source of truth.

The key files that will change are:

- `packages/jar-core/src/session-store.ts`: the old snapshot-backed store to be replaced or reduced.
- `packages/jar-core/src/thread-executor.ts`: execution seam to move from session snapshot semantics to lane-backed handles.
- `packages/jar-core/src/thread-execution.ts`: audit model to remain, but be driven by tape-backed execution.
- `packages/jar-core/src/runtime.ts`: context assembly and compaction integration to use materialized lane views.
- `packages/jar-core/src/compaction/*`: persistence expectations must shift from rewriting state to appending checkpoints.
- `packages/jar-core/src/entity-routing.ts`: route to threads/lanes rather than encoding persistence identity into session ids.
- `apps/jar-slack/src/slack-runtime.ts` and `apps/jar-telegram/src/telegram-runtime.ts`: adapt to thread/lane execution without understanding tape internals.
- `docs/sessions.md`, `docs/agent-runtime.md`, and `docs/compaction-architecture.md`: rewrite repository truth from snapshot-backed sessions to tape-backed lanes.

## Plan of Work

Begin by creating a new `packages/jar-core/src/lanes/` subtree inside `jar-core`. This keeps the redesign close to existing runtime code while avoiding premature package extraction. The new subtree should define the new domain types and append-only storage primitives before any runtime behavior is rewired. The first milestone is not to make adapters work; it is to make the tape model real and testable in isolation.

Once the lane substrate exists, shrink the execution contract. `thread-executor.ts` must stop depending on whole-snapshot semantics such as `writeSnapshot(...)`. Replace the current session handle shape with a narrower lane-backed conversation handle that can load a materialized message view, append tape records, append audit records, and append checkpoints. Removing snapshot-write authority from the execution seam is the architectural hinge of the whole refactor.

After that seam is narrowed, move normal prompt execution to the lane substrate. Normal user turns should open the current thread, resolve the active `main` lane, materialize the lane view, execute the turn, append message and audit facts to the lane tape, and append a checkpoint when post-turn compaction runs. This plan does not implement side ask and does not create additional lane kinds, but the lane model must carry the lineage concepts needed for future forks.

Finally, update routing and documentation. Routing should stop treating encoded session ids as the persistence identity and should instead resolve a stable thread id plus its active lane. Documentation must explicitly say that canonical truth is the tape, not a mutable snapshot. Tests must prove that compaction appends a checkpoint instead of rewriting authoritative state and that reopening a conversation reconstructs the correct view from tape.

## Concrete Steps

All commands run from `/Users/wibus/dev/HiJarvis`.

1. Add failing substrate tests before major production edits.

   Create or update tests under:

   - `packages/jar-core/src/lanes/tape-store.test.ts`
   - `packages/jar-core/src/lanes/materializer.test.ts`
   - `packages/jar-core/src/session-executor.test.ts` or the nearest existing executor integration test file

   Then run:

       pnpm --filter @hijarvis/jar-core test -- --test-name-pattern "lane|tape|materialize|checkpoint"

   Expectation before implementation: new tests fail because there is no lane substrate and normal execution still assumes snapshot-backed sessions.

2. Create the lane substrate inside `jar-core`.

   Add these files:

   - `packages/jar-core/src/lanes/types.ts`
   - `packages/jar-core/src/lanes/path-layout.ts`
   - `packages/jar-core/src/lanes/tape-store.ts`
   - `packages/jar-core/src/lanes/thread-store.ts`
   - `packages/jar-core/src/lanes/lane-store.ts`
   - `packages/jar-core/src/lanes/materializer.ts`
   - `packages/jar-core/src/lanes/handle.ts`
   - `packages/jar-core/src/lanes/index.ts`

   Then run:

       pnpm --filter @hijarvis/jar-core check

   Expected outcome: the new subtree compiles independently with tests still failing at integration points.

3. Refactor execution off snapshot authority.

   Edit:

   - `packages/jar-core/src/thread-executor.ts`
   - `packages/jar-core/src/thread-execution.ts`
   - `packages/jar-core/src/runtime.ts`

   Remove snapshot-write assumptions from the executor-facing contract. Replace them with lane-backed load/append/checkpoint operations.

   Then run:

       pnpm --filter @hijarvis/jar-core test -- --test-name-pattern "lane|tape|materialize|checkpoint|compaction"
       pnpm --filter @hijarvis/jar-core check

4. Move normal conversation execution onto threads and lanes.

   Edit:

   - `packages/jar-core/src/entity-routing.ts`
   - `apps/jar-slack/src/slack-runtime.ts`
   - `apps/jar-telegram/src/telegram-runtime.ts`
   - other `jar-core` files as required by the new thread/lane seam

   Important: keep side-query code out of scope. If it breaks because the old session path disappears, stub or delete that path for now rather than designing side-ask support in this refactor.

   Then run:

       pnpm --filter @hijarvis/jar-core check
       pnpm --filter @hijarvis/jar-slack check
       pnpm --filter @hijarvis/jar-telegram check

5. Remove snapshot-backed authority and rewrite docs.

   Edit:

   - `packages/jar-core/src/session-store.ts` (delete or reduce to a removed/deprecated shell if no longer needed)
   - `docs/sessions.md`
   - `docs/agent-runtime.md`
   - `docs/compaction-architecture.md`
   - `docs/README.md` if the doc index needs to mention a new architecture emphasis

6. Run final focused validation.

   Run:

       pnpm --filter @hijarvis/jar-core test
       pnpm --filter @hijarvis/jar-core check
       pnpm --filter @hijarvis/jar-slack check
       pnpm --filter @hijarvis/jar-telegram check
       pnpm -r tsc --noEmit

   Record the actual outputs and any environment-dependent failures in this document.

## Validation and Acceptance

Acceptance is behavioral.

First, normal execution must no longer depend on `session.json.messages` as the source of truth. A reader of the code and docs should be able to see that canonical state is read from a tape-backed lane and that any materialized head file is explicitly derived.

Second, post-turn compaction must append a checkpoint or compaction record into the lane tape instead of rewriting authoritative conversation history in place. A focused test should prove that reopening a conversation after compaction reconstructs the same usable message view from checkpoint plus later entries.

Third, two normal turns in the same logical Slack or Telegram scope must still continue the same conversation. The difference is that continuity should now be routed through thread/lane identity rather than an encoded session id backed by snapshot authority.

Fourth, the lane substrate must make future live forks possible without implementing them now. Acceptance for this point is architectural: the code must expose a first-class lane abstraction and must not require a mutable global snapshot file to recover current context.

Fifth, repository docs must tell the new truth. A novice reading `docs/sessions.md`, `docs/agent-runtime.md`, and `docs/compaction-architecture.md` should understand that HiJarvis now uses a tape-backed lane model and that snapshots, if present, are caches rather than authoritative state.

## Idempotence and Recovery

This refactor is intentionally destructive and assumes there is no old data to preserve. That makes the coding process simpler, but individual development steps must still be safe to retry. The recommended recovery pattern is to keep the lane substrate additive until the executor compiles against it, then remove snapshot-backed authority once focused tests prove the new path. If a partially migrated state leaves the repository uncompilable, restore the last good compile point by completing the current seam rather than reintroducing snapshot authority.

During this work, it is acceptable for side-query codepaths to be disabled or temporarily removed if they depend on the old session substrate. This plan explicitly excludes side ask functionality, and preserving those paths would risk dragging the old architecture back into the core runtime.

## Artifacts and Notes

Current proof artifacts:

- `pnpm --filter @hijarvis/jar-core check` passed after introducing the lane substrate and moving the normal executor path onto `openConversationHandle(...)`.
- Focused `jar-core` tests for `lane|tape|materialize|checkpoint|startSessionExecutionTracker` pass, except for unrelated OpenAI-backed `web_search` tests that still require `OPENAI_API_KEY` in this environment.

Expected proof artifacts after implementation include:

- test output showing lane tape append/read and checkpoint-based materialization
- typecheck output for `jar-core`, `jar-slack`, and `jar-telegram`
- a file tree under `.jar/` or the equivalent sessions root that shows thread/lane/tape layout instead of the old session-centric layout

Expected new storage shape after implementation, conceptually:

    .jar/
      threads/
        <threadId>/
          meta.json
          thread.json
          lanes/
            <laneId>/
              meta.json
              tape.jsonl
              head.json   # optional derived cache only

Expected lane-oriented conceptual APIs after implementation:

    openThread(...)
    openMainLane(...)
    materializeLaneView(...)
    appendTapeRecord(...)
    appendLaneCheckpoint(...)

## Interfaces and Dependencies

Use only existing project dependencies such as `zod`, `@mariozechner/pi-agent-core`, and the existing TypeScript/node runtime. Do not add a new package extraction in this refactor. The new lane substrate should remain inside `packages/jar-core` until the domain model stabilizes.

At the end of this rewrite, the codebase should expose interfaces equivalent to the following:

In `packages/jar-core/src/lanes/types.ts`, define stable domain types equivalent to:

    type ThreadMeta = {
      threadId: string;
      activeLaneId: string;
      provider: string;
      model: string;
      routing: {
        identityId: string;
        platform: "slack" | "telegram";
        scope: string;
      };
    };

    type LaneMeta = {
      laneId: string;
      threadId: string;
      kind: "main";
      status: "active" | "sealed";
      startOffset: number;
      endOffset?: number;
    };

    type TapeRecord =
      | { type: "message.user"; ... }
      | { type: "message.assistant"; ... }
      | { type: "tool.call"; ... }
      | { type: "tool.result"; ... }
      | { type: "turn.started"; ... }
      | { type: "turn.completed"; ... }
      | { type: "run.started"; ... }
      | { type: "run.completed"; ... }
      | { type: "compaction.applied"; ... }
      | { type: "lane.checkpoint"; ... };

In `packages/jar-core/src/lanes/materializer.ts`, define functions equivalent to:

    materializeLaneView(...)
    materializeLaneViewFromCheckpoint(...)

In `packages/jar-core/src/lanes/handle.ts`, define an executor-facing contract equivalent to:

    loadMessages()
    appendTapeRecord(...)
    appendAuditRecord(...)
    appendLaneCheckpoint(...)
    flush()

In `packages/jar-core/src/thread-executor.ts`, normal prompt execution must consume the lane-backed handle and must not require a whole-snapshot `writeSnapshot(...)` call to remain correct.

Revision note: Updated after the first implementation slice to record that the new `lanes/` substrate exists, the normal executor path now uses a lane-backed conversation handle, and focused lane/tracker tests pass apart from unrelated OpenAI-backed environment-dependent tests.
