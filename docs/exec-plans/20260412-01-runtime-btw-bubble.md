# Align Runtime `/btw` With Claude Code One-Shot Side Question Semantics

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This document must be maintained in accordance with `/Users/wibus/.agents/skills/execplan/references/PLANS.md`. The non-negotiable requirements that shape this plan are: the plan must be fully self-contained for a novice, it must describe observable behavior rather than internal intent alone, it must name exact files and commands, it must remain safe to retry, and it must keep the living sections accurate as implementation proceeds.

## Purpose / Big Picture

After this change, HiJarvis `/btw` will match Claude Code's core product semantics: a one-shot side question that reads from the current live in-memory state of an actively running parent thread without interrupting that parent thread and without writing any new persisted thread truth. `/btw` will not open a multi-turn bubble, will not require `/exitbtw`, will not create a child lane, and will not preserve any follow-up side-question state after the answer returns.

Someone verifying this change should be able to start a long-running parent thread, trigger `/btw`, observe that the answer reflects the parent's live in-memory context rather than only persisted tape recovery, and then confirm that the side question itself did not append to tape, checkpoints, turn/run/item audit files, or any runtime-only bubble store because no bubble store exists anymore.

## Progress

- [x] (2026-04-12 11:40Z) Re-read Claude Code's `/btw` implementation and confirmed that it is a one-shot side question rather than a multi-turn runtime bubble.
- [x] (2026-04-12 11:45Z) Audited the just-added `runtime-btw` substrate and confirmed that it had already drifted into multi-turn bubble semantics.
- [x] (2026-04-12 11:55Z) Replaced the public `runtime-btw` API surface with a one-shot side-question execution path and removed the bubble store implementation.
- [x] (2026-04-12 12:20Z) Renamed the surviving runtime pieces from `runtime-btw` and `bubble-*` names to `side-question/*` names so the code surface matches the corrected product semantics.
- [ ] Update and expand tests so the new one-shot side-question semantics are the locked contract.
- [ ] Re-check docs and runtime exports for any remaining bubble-language leakage.
- [ ] Run focused tests and typechecks, record actual outcomes, and fix regressions.

## Surprises & Discoveries

- Observation: The previous plan was no longer describing Claude Code semantics, even though it used the same `/btw` name.
  Evidence: Claude Code `utils/sideQuestion.ts` explicitly constrains `/btw` to a single response with no follow-up turns, while the removed HiJarvis plan required a multi-turn detached bubble with `/exitbtw`.

- Observation: The live-thread capture work was still useful and survived the semantic correction.
  Evidence: `packages/jar-core/src/thread-executor.ts` already exposes detached runtime snapshots of current in-memory parent state, which is still the correct source for one-shot side questions.

- Observation: The main overreach was the bubble lifecycle, not the live capture substrate itself.
  Evidence: the removed `packages/jar-core/src/runtime-btw/bubble-store.ts` and related exports introduced `open/continue/get/exit` semantics that Claude Code does not have.

## Decision Log

- Decision: `/btw` in HiJarvis will align with Claude Code as a one-shot side question.
  Rationale: Matching the upstream product semantic is more valuable than continuing a custom multi-turn design under the same name.
  Date/Author: 2026-04-12 / OpenCode

- Decision: Keep live-thread capture, delete bubble lifecycle.
  Rationale: Live capture is still the right runtime primitive for answering from the parent's current in-memory state, but the bubble registry and `/exitbtw` model were product drift.
  Date/Author: 2026-04-12 / OpenCode

- Decision: `/btw` remains runtime-only, no persistence, and deny-by-default on tools.
  Rationale: This still matches both the user's requirement and Claude Code's side-question safety profile.
  Date/Author: 2026-04-12 / OpenCode

## Outcomes & Retrospective

The runtime has been pulled back toward the correct concept boundary. HiJarvis now keeps the useful part of the prior work, namely live capture from parent runtime state, while removing the incorrect multi-turn bubble lifecycle. The remaining work is to finish re-locking tests and docs around one-shot side-question behavior.

## Context and Orientation

HiJarvis is a TypeScript monorepo. Shared runtime code lives in `packages/jar-core/src/`. The current persisted truth model remains thread/lane/tape-based. The relevant files now are:

- `packages/jar-core/src/thread-executor.ts`: runs a prompt against the current thread and refreshes runtime live-thread capture while the parent is executing.
- `packages/jar-core/src/side-question/live-thread-registry.ts`: holds detached snapshots of current live parent thread state for active threads only.
- `packages/jar-core/src/side-question/execute-side-question.ts`: the one-shot `/btw` execution entry point.
- `packages/jar-core/src/lanes/handle.ts` and `packages/jar-core/src/lanes/materializer.ts`: define persisted lane truth and recovery boundaries.

The phrase `/btw` in this corrected plan has a precise meaning. It is a one-shot side question answered from the parent's current live state. It is not a persisted lane, not a tape branch, not a child checkpoint chain, not a replayable sub-conversation, and not a multi-turn bubble. After the answer returns, there is no `/btw` session state left to continue.

## Plan of Work

The work now focuses on removing the semantic leftovers of the abandoned bubble design while preserving the live capture substrate. The runtime should expose one public execution path that: capture the current parent state, append the side question only to an ephemeral in-memory prompt, run the answer with no tools and no persistence, return the answer, and then discard all side-question-local state.

Tests and docs must make the corrected contract obvious. Any test, export, or documentation that still implies `openBtwBubble(...)`, `continueBtwBubble(...)`, `/exitbtw`, or multi-turn continuity must be rewritten or removed.

## Concrete Steps

All commands run from `/Users/wibus/dev/HiJarvis`.

1. Rewrite side-question tests so they define one-shot side-question behavior.

   Update tests under:

   - `packages/jar-core/src/side-question/execute-side-question.test.ts`
   - `packages/jar-core/src/side-question/live-thread-registry.test.ts`
   - `packages/jar-core/src/thread-executor.test.ts`

   The tests must prove all of the following:

   - a running parent thread exposes a live capture that reflects in-memory state newer than the last persisted checkpoint
   - `/btw` reads from a detached snapshot of that live capture
   - `/btw` is one-shot only; there is no open/continue/exit lifecycle
   - opening a side question does not append any tape/event/checkpoint/turn/run/item records
   - tools remain unavailable to the side-question execution path

2. Remove bubble lifecycle APIs and old naming from the runtime side-question substrate.

   Expected file changes:

   - delete `packages/jar-core/src/runtime-btw/bubble-store.ts`
   - replace `packages/jar-core/src/runtime-btw/` with `packages/jar-core/src/side-question/`
   - update `packages/jar-core/src/index.ts`

3. Keep live capture integrated into the parent executor.

   `packages/jar-core/src/thread-executor.ts` should continue to:

   - register a parent thread as live before execution
   - refresh the latest immutable capture when the current in-memory state changes
   - unregister the parent on completion or failure

4. Update docs for the corrected truth.

   Update:

   - `docs/sessions.md`
   - `docs/agent-runtime.md`
   - `docs/README.md` if needed

   The docs must explicitly state:

   - `/btw` is a one-shot side question
   - `/btw` does not create child lanes
   - `/btw` does not create a multi-turn bubble
   - `/btw` does not write tape truth

5. Run final focused validation.

       pnpm --filter @hijarvis/jar-core test -- --test-name-pattern "btw|bubble|live capture|parent continues|thread-executor"
       pnpm --filter @hijarvis/jar-core check

## Validation and Acceptance

Acceptance is behavioral.

First, a parent thread that is actively running must expose a live capture newer than persisted tape-only recovery. A focused test must show that `/btw` reads current in-memory state rather than only the last flushed checkpoint.

Second, `/btw` must be one-shot. There must be no runtime object to continue, no `/exitbtw`, and no multi-turn continuity guarantee.

Third, `/btw` must not write any new tape records, checkpoints, turn records, run records, item records, or events for the parent thread. A test should compare the parent's on-disk files before and after side-question interaction and observe no changes attributable to `/btw`.

Fourth, the parent must continue independently while `/btw` runs. This is an execution-ownership guarantee, not a promise about any one specific concurrency primitive.

Fifth, docs must make it difficult for a future contributor to mistake `/btw` for either a persisted fork or a multi-turn runtime bubble.

## Idempotence and Recovery

This work is safe to retry because `/btw` itself remains runtime-only and one-shot. If the process exits, there is no recovery obligation for side-question state. The parent thread's persisted truth remains in tape and checkpoints.

## Artifacts and Notes

Expected proof artifacts after implementation include:

- a focused test showing that parent live capture is detached from later parent mutation
- a focused test showing that `/btw` fails clearly when no live parent thread exists
- typecheck output for `@hijarvis/jar-core`

Expected conceptual runtime APIs after implementation:

    registerLiveThreadForSideQuestion(...)
    updateLiveThreadCaptureForSideQuestion(...)
    captureLiveThreadForSideQuestion(...)
    executeSideQuestion(...)

## Interfaces and Dependencies

Use only existing project dependencies such as `zod`, `@mariozechner/pi-agent-core`, and the existing TypeScript/node runtime. Keep the implementation inside `packages/jar-core`.

At the end of this work, the codebase should expose interfaces equivalent to the following:

In `packages/jar-core/src/side-question/live-thread-registry.ts`, define types equivalent to:

    type SideQuestionLiveThreadCapture = {
      threadId: string;
      laneId: string;
      capturedAt: number;
      messages: AgentMessage[];
    };

In `packages/jar-core/src/side-question/execute-side-question.ts`, define functions equivalent to:

    executeSideQuestion(...)
    normalizeSideQuestionPromptToMessages(...)

In `packages/jar-core/src/thread-executor.ts`, normal parent execution must register and refresh live capture state while running so that `/btw` can answer from current in-memory context without touching persisted thread truth.

Revision note: Replaced the earlier multi-turn runtime-bubble direction after re-reading Claude Code's `/btw` implementation and confirming that the intended product semantic is a one-shot side question rather than an ephemeral side conversation.
