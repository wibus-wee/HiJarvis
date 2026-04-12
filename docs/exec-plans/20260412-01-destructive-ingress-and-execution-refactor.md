# Destructive Ingress And Execution Refactor

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This document must be maintained in accordance with `/Users/wibus/.agents/skills/execplan/references/PLANS.md`. The non-negotiable requirements that shape this plan are: the plan must be fully self-contained for a novice, it must describe observable behavior rather than internal intent alone, it must name exact files and commands, it must remain safe to retry, and it must keep the living sections accurate as implementation proceeds.

## Purpose / Big Picture

After this refactor, Jar will stop exposing the old prompt-first execution seam built around `threadId + prompt + metadata bag`. All primary runtime surfaces will instead enter `jar-core` through one normalized ingress command shape that carries routing, actor, content, and audit semantics explicitly. The user-visible result is that CLI, Slack, Telegram, and side-question execution all flow through one core command model and one application-layer execution path, which is the architectural base needed for future lane-native evolution.

Someone verifying this work should be able to run the `jar-core` tests, then inspect the apps and see that they no longer call `executePromptInSession(...)`, `maybeExecuteSideQuestionCommand(...)`, or `resolveIdentityThread(...)`. They should also be able to see that conversation state, audit projection, and cache refresh responsibilities are separated in code rather than hidden behind one broad session handle.

## Progress

- [x] (2026-04-12 15:42Z) Audited the current runtime, adapter, persistence, and side-question seams and confirmed the refactor target: unify ingress, thin the execution service, split persistence ports, and remove old convenience entrypoints.
- [ ] Introduce a normalized ingress command model plus a single core execution entrypoint.
- [ ] Split persistence concerns into conversation state, audit projection, and raw event sinks while keeping the current filesystem-backed lane substrate.
- [ ] Migrate CLI, Slack, Telegram, and side-question paths onto the new ingress command entrypoint.
- [ ] Remove obsolete `executePromptInSession(...)`, `maybeExecuteSideQuestionCommand(...)`, and session-id-centric routing helpers.
- [ ] Update runtime, sessions, and architecture documentation to describe the new ingress and execution layering.
- [ ] Run focused tests and typechecks, fix regressions, and record actual outcomes.

## Surprises & Discoveries

- Observation: the current CLI REPL path bypasses the shared threaded execution seam and re-implements event persistence, tracker wiring, and side-question handling inline.
  Evidence: `apps/jar-cli/src/main.ts` directly opens `openConversationHandle(...)`, builds an agent, subscribes to events, starts `startThreadExecutionTracker(...)`, and calls `maybeExecuteSideQuestionCommand(...)`.

- Observation: `flush()` on the current conversation handle still appends a semantic `lane.checkpoint`, which blurs ordinary cache refresh with authoritative state transitions.
  Evidence: `packages/jar-core/src/lanes/handle.ts` appends a `lane.checkpoint` inside `flush()` before writing `head.json`.

## Decision Log

- Decision: This refactor is intentionally destructive and will remove old convenience APIs instead of preserving compatibility wrappers.
  Rationale: The user explicitly confirmed there is no history or external data to preserve and asked to remove everything that does not fit the target architecture.
  Date/Author: 2026-04-12 / OpenCode

- Decision: The first migration step keeps the current filesystem-backed lane substrate but inserts application-layer and persistence-port seams above it.
  Rationale: This removes architectural debt immediately without paying the risk of swapping the storage backend during the same change.
  Date/Author: 2026-04-12 / OpenCode

## Outcomes & Retrospective

Current state: planning and initial implementation setup are complete. The main remaining work is to land the new ingress command path, migrate adapters, and remove the obsolete convenience layer.

## Context and Orientation

The current execution seam lives in `packages/jar-core/src/thread-executor.ts`. It opens a lane-backed conversation, creates the runtime agent, injects skills, subscribes to agent events, records audit projections, persists events, triggers compaction, and returns output. Slack and Telegram call this seam after separately computing a thread id using `packages/jar-core/src/entity-routing.ts`. Side questions use a separate runtime-only path under `packages/jar-core/src/side-question/`. CLI one-shot and REPL use yet another mix of direct runtime calls and ad hoc persistence wiring in `apps/jar-cli/src/main.ts`.

The lane substrate under `packages/jar-core/src/lanes/` is the filesystem-backed persistence implementation. It stores `tape.jsonl`, `events.jsonl`, `turns.jsonl`, `runs.jsonl`, `items.jsonl`, and `head.json`. The architecture target for this refactor is not to replace that substrate. The target is to stop letting application code depend on it through one broad mutable handle and to stop letting adapters enter core through ad hoc prompt-plus-thread seams.

In this plan, “ingress command” means one structured object representing a user-visible execution request, including routing target, actor, content, and audit metadata. “Application service” means a module that orchestrates one use case such as a threaded turn or a side question without owning filesystem or model wiring details. “Persistence port” means a narrow interface such as “append conversation facts” or “append audit projections” rather than a broad handle that mixes those concerns.

## Plan of Work

First, add a normalized ingress model under `packages/jar-core/src/` and write tests that prove route resolution and execution can be driven from that structure. Then split the current broad conversation handle dependency into narrower state and audit interfaces while keeping the underlying lane files in place. Once the new entrypoint is real, migrate `apps/jar-cli`, `apps/jar-slack`, and `apps/jar-telegram` to construct ingress commands instead of calling the old convenience APIs. Finally, delete the old session-id-centric routing helpers and the prompt-first execution entrypoint, then update the docs to describe the new layering.

## Concrete Steps

All commands run from `/Users/wibus/dev/HiJarvis`.

1. Add failing `jar-core` tests that target the new ingress path and route resolution behavior.

       pnpm --filter @hijarvis/jar-core test -- --test-name-pattern "ingress|route|side question|thread execution"

2. Implement the ingress command types, new execution service, and persistence ports in `packages/jar-core/src/`.

       pnpm --filter @hijarvis/jar-core check

3. Migrate the adapters and CLI to the new execution entrypoint.

       pnpm --filter @hijarvis/jar-cli check
       pnpm --filter @hijarvis/jar-slack check
       pnpm --filter @hijarvis/jar-telegram check

4. Remove the old convenience APIs and update docs.

       pnpm --filter @hijarvis/jar-core test
       pnpm -r tsc --noEmit

## Validation and Acceptance

Acceptance is behavioral and architectural.

First, all runtime surfaces must compile against the new ingress command path rather than `executePromptInSession(...)` and `maybeExecuteSideQuestionCommand(...)`. Second, the core execution service must depend on narrow persistence ports rather than a single broad conversation handle. Third, the lane substrate must still restore and persist threaded conversations, but `flush()` must no longer append a semantic checkpoint as a normal end-of-run side effect. Fourth, focused tests for route resolution, side-question behavior, and execution tracking must pass.

## Idempotence and Recovery

This refactor is destructive but safe to retry because there is no historical runtime data to preserve. The implementation should proceed by adding new seams first, migrating callers, and then deleting the old APIs. If an intermediate compile break occurs, complete the migration of the current seam rather than reintroducing compatibility wrappers.

## Artifacts and Notes

Expected proof artifacts after implementation include:

    - `packages/jar-core/src/index.ts` exporting the new ingress and execution services instead of the old prompt-first executor
    - `apps/jar-cli/src/main.ts`, `apps/jar-slack/src/slack-runtime.ts`, and `apps/jar-telegram/src/telegram-runtime.ts` calling the new ingress path
    - `packages/jar-core/src/lanes/handle.ts` no longer appending a checkpoint from `flush()`

## Interfaces and Dependencies

The refactor should introduce or stabilize interfaces equivalent to the following:

    type IngressCommand = MessageIngressCommand | SideQuestionIngressCommand;

    interface ConversationStateStore {
      load(target: RoutedConversationTarget): Promise<MaterializedConversationState>;
      appendMessage(input: AppendConversationMessageInput): Promise<void>;
      applyCheckpoint(input: ApplyCheckpointInput): Promise<void>;
      flush(target: RoutedConversationTarget, messages: AgentMessage[]): Promise<void>;
    }

    interface ExecutionAuditStore {
      appendTurn(turn: ThreadTurn): Promise<void>;
      appendRun(run: ThreadRun): Promise<void>;
      appendItem(item: ThreadItem): Promise<void>;
    }

    interface EventLogStore {
      appendEvent(event: JarEvent): Promise<void>;
    }

    interface ThreadTurnService {
      execute(options: { config: LoadedRuntimeConfig; command: MessageIngressCommand }): Promise<MessageIngressResult>;
    }

Revision note (2026-04-12): Created this plan to guide the destructive ingress and execution refactor requested by the user.
