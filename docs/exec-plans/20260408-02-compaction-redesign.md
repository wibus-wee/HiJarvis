# Redesign HiJarvis Compaction As A First-Class Subsystem

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This document must be maintained in accordance with `PLANS.md`. For this repository, the governing rules were read from `/Users/wibus/.agents/skills/execplan/references/PLANS.md`. The non-negotiable requirements that shape this plan are: the plan must be self-contained, it must guide a novice without relying on any prior chat context, it must define concrete user-visible outcomes, it must name exact files and commands, it must describe safe retry and recovery behavior, and it must keep the living sections up to date as implementation proceeds.

## Purpose / Big Picture

After this change, HiJarvis will no longer rely on one monolithic `packages/jar-core/src/compaction.ts` file that mixes trigger policy, summary prompting, message trimming, and runtime wiring. Instead, the runtime will use a dedicated compaction subsystem under `packages/jar-core/src/compaction/` with explicit stages, clear strategy boundaries, and a normalized result model. The user-visible outcome is that long-running sessions become easier to evolve and debug: compaction decisions will be explicit, compaction behavior can be tested stage by stage, and future features such as lightweight tool-result shrinking or partial compaction will have a stable architecture to land on.

Someone verifying this work should be able to inspect the new directory tree, run the test suite for `jar-core`, and observe that session execution still compacts history when thresholds are reached, but now does so through the new subsystem. They should also be able to read the new compaction types and entry points and understand where to add future strategies without reopening runtime internals.

## Progress

- [x] (2026-04-08 00:00Z) Researched Claude Code compaction deeply and documented findings in `research/claude-code-compaction/README.md`.
- [x] (2026-04-08 00:00Z) Confirmed this redesign is large enough to require an ExecPlan because it changes subsystem boundaries, runtime flow, tests, and documentation.
- [x] (2026-04-08 00:00Z) Read `PLANS.md` and extracted the requirements this plan must satisfy.
- [x] (2026-04-08 00:00Z) Drafted the target architecture, migration shape, concrete file plan, and validation strategy in this ExecPlan.
- [x] (2026-04-08 00:30Z) Implemented `packages/jar-core/src/compaction/` types, policy layer, summary layer, assembly layer, strategy layer, and subsystem index.
- [x] (2026-04-08 00:35Z) Migrated the legacy summary-compaction behavior into the new subsystem with a normalized result shape and kept the existing summary-based behavior envelope.
- [x] (2026-04-08 00:40Z) Rewired runtime, session execution, and config imports to the new subsystem and deleted the old `packages/jar-core/src/compaction.ts` file.
- [x] (2026-04-08 00:42Z) Moved the old compaction tests into `packages/jar-core/src/compaction/assembly.test.ts` as the first colocated subsystem test.
- [x] (2026-04-08 00:50Z) Updated `docs/agent-runtime.md` and `docs/README.md` so the repository documentation reflects the new subsystem layout.
- [x] (2026-04-08 00:55Z) Ran `pnpm --filter jar-core test` successfully after deleting the old monolith and recorded the completed outcome in this plan.
- [x] (2026-04-08 01:00Z) Recorded final outcomes and retrospective for the first completed architecture pass.
- [x] (2026-04-08 01:20Z) Expanded the subsystem into a HiJarvis-specific Claude-Code-style staged compaction pipeline with explicit stage results, lightweight reduction before summary compaction, and richer compaction metadata.
- [x] (2026-04-08 01:25Z) Persisted and exposed staged compaction metadata in session events and tracker items instead of introducing a new synthetic message role.
- [x] (2026-04-08 01:30Z) Added tests proving lightweight reduction behavior and structured compaction metadata persistence.
- [x] (2026-04-08 01:35Z) Re-ran `pnpm --filter jar-core test` successfully for the staged architecture pass.
- [x] (2026-04-08 01:50Z) Added snip-style reduction, layout-aware summary prompt variants, and partial-compaction entry points to complete the first full Claude-Code-inspired architecture pass.
- [x] (2026-04-08 01:55Z) Added tests for snip reduction, prompt variants, and partial-compaction entry behavior, then re-ran `pnpm --filter jar-core test` successfully.
- [x] (2026-04-08 02:15Z) Replaced event-only boundary metadata with a breaking snapshot-backed boundary schema and made runtime/history slicing use that boundary directly.
- [x] (2026-04-08 02:20Z) Added tests for boundary persistence and boundary-aware history slicing.
- [x] (2026-04-08 02:25Z) Re-ran `pnpm --filter jar-core test` successfully after the snapshot-backed boundary migration.
- [x] (2026-04-08 02:40Z) Made partial compaction a built-in runtime strategy rather than a manual API-only capability.
- [x] (2026-04-08 02:45Z) Added compaction-level prompt-too-long retry behavior inside summary generation.
- [x] (2026-04-08 02:50Z) Added tests and re-ran `pnpm --filter jar-core test` successfully for the auto-partial and PTL retry pass.
- [x] (2026-04-08 03:05Z) Added a post-compact artifact restoration layer so non-summary state can be reconstructed structurally rather than relying only on summary text.
- [x] (2026-04-08 03:10Z) Persisted artifact metadata through compaction results and events.
- [x] (2026-04-08 03:15Z) Added tests and re-ran `pnpm --filter jar-core test` successfully for the artifact restoration pass.

## Surprises & Discoveries

- Observation: The current HiJarvis compaction logic is much smaller than Claude Code's system, but it already mixes three distinct responsibilities: trigger policy, summary generation, and compacted-message assembly.
  Evidence: `packages/jar-core/src/compaction.ts` currently contains `shouldCompactFromUsage(...)`, `compactHistoryNow(...)`, `createCompactionTransform(...)`, `summarizeContext(...)`, and `buildCompactedMessages(...)` in one file.

- Observation: HiJarvis already has one adjacent context-management concern outside `compaction.ts`, namely prompt-context stripping for memory-excluded fragments.
  Evidence: `packages/jar-core/src/runtime.ts:76` to `packages/jar-core/src/runtime.ts:79` applies `stripMemoryExcludedPromptContextFromHistory(...)` before compaction.

- Observation: Claude Code's biggest architectural advantage is not merely a better summary prompt. It is a normalized compaction result plus layered pre-summary reductions and structured post-summary reconstruction.
  Evidence: `research/claude-code-compaction/README.md` sections on query-loop orchestration, prompt variants, and post-compact assembly.

- Observation: The old HiJarvis compaction logic moved into the new subtree with less friction than expected because the existing code already had a natural split between policy, summary generation, and assembly helpers; the main work was turning those implicit boundaries into explicit files.
  Evidence: `packages/jar-core/src/compaction/policy.ts`, `packages/jar-core/src/compaction/summary.ts`, and `packages/jar-core/src/compaction/assembly.ts` now map cleanly to the old helper groups from the deleted monolith.

- Observation: HiJarvis cannot directly copy Claude Code's compact-boundary message model because current runtime and persistence paths only accept the existing `AgentMessage` / `Message` role shapes.
  Evidence: `packages/jar-core/src/compaction/index.ts` still validates only `user`, `assistant`, and `toolResult`, and `packages/jar-core/src/session-store.ts` persists `AgentMessage[]` snapshots directly.

- Observation: We can still capture most of Claude Code's architectural value without a new message role by persisting boundary-like metadata in `CompactionEvent`, `CompactionNowResult`, and tracker items.
  Evidence: `packages/jar-core/src/compaction/types.ts` now defines `CompactionBoundary`, `CompactionStageEvent`, and `appliedStages`, and `packages/jar-core/src/session-execution.ts` records that structured metadata into session items.

- Observation: Adding partial compaction and prompt variants on top of the new subsystem was straightforward once summary generation and assembly were already separated.
  Evidence: `packages/jar-core/src/compaction/prompt.ts`, `packages/jar-core/src/compaction/summary.ts`, and `packages/jar-core/src/compaction/pipeline.ts` now wire prompt variants and partial compaction without touching runtime wiring.

- Observation: The cleanest place to hold boundary state is the session snapshot, because snapshot write/read is already the authoritative persistence seam for current message state.
  Evidence: `packages/jar-core/src/session-store.ts` owns `SessionSnapshot`, `loadSnapshot(...)`, and `writeSnapshot(...)`, while post-turn compaction in `packages/jar-core/src/session-executor.ts` already writes a fresh snapshot immediately after compaction.

- Observation: Moving the summary message to the front of the compacted payload makes boundary slicing much simpler, because the snapshot boundary can point to a stable summary anchor instead of guessing among preserved user messages.
  Evidence: `packages/jar-core/src/compaction/assembly.ts` now places `createSummaryMessage(...)` before preserved user messages when a summary exists, and `packages/jar-core/src/compaction/boundary.ts` uses that summary index as the slicing anchor.

- Observation: The current partial-compaction implementation is already complete enough to promote into runtime strategy selection; the missing piece is choosing it automatically rather than exposing it only as a callable API.
  Evidence: `packages/jar-core/src/compaction/pipeline.ts` already supports `runPartialCompactionPipeline(...)`, and `packages/jar-core/src/compaction/prompt.ts` already has layout-aware prompt variants.

- Observation: The cleanest place to implement compaction PTL retry is inside `summarizeHistory(...)`, because that function already owns prompt construction, token budgeting, and the model call boundary.
  Evidence: `packages/jar-core/src/compaction/summary.ts` now contains both `trimMessagesToBudget(...)` and `truncateForRetry(...)`, so retry stays local to summary generation instead of leaking into runtime orchestration.

- Observation: The most valuable first restored artifacts in HiJarvis are compacted tool execution state and recent skill-injection metadata, because those are machine-relevant state cues that summary text alone does not preserve reliably.
  Evidence: `packages/jar-core/src/compaction/assembly.ts` already preserves minimal tool tails structurally, while `packages/jar-core/src/session-executor.ts` and `packages/jar-core/src/skills.ts` show that skill injection and tool execution are explicit runtime concerns.

- Observation: A lightweight artifact layer can be expressed as ordinary restored user messages while still remaining structurally distinct from the summary, as long as extraction and rendering are handled in a dedicated module.
  Evidence: `packages/jar-core/src/compaction/artifacts.ts` now cleanly separates `extractCompactionArtifacts(...)` from `renderArtifactMessages(...)`.

## Decision Log

- Decision: This redesign will be intentionally breaking and will not preserve the old `packages/jar-core/src/compaction.ts` interface surface.
  Rationale: The user explicitly allowed destructive refactoring and asked for a full redesign rather than an incremental compatibility layer. Keeping the old surface would preserve accidental constraints from the current implementation.
  Date/Author: 2026-04-08 / OpenCode

- Decision: The new subsystem will keep the initial behavior envelope intentionally narrow: threshold-based summary compaction must keep working first, while the architecture will reserve extension points for future lightweight reduction stages and partial compaction.
  Rationale: We need a stable architecture before adding Claude-Code-like complexity. Recreating all advanced behaviors in one jump would increase migration risk and blur whether the redesign succeeded.
  Date/Author: 2026-04-08 / OpenCode

- Decision: The new design will introduce a normalized result object and a dedicated assembly layer rather than allowing each strategy to return raw message arrays directly.
  Rationale: Claude Code's design shows that compaction scales much better when summary text, preserved raw segments, metadata, and restored artifacts are represented explicitly before being assembled.
  Date/Author: 2026-04-08 / OpenCode

- Decision: The existing prompt-context stripping step will remain outside compaction strategy logic, but the new compaction entry point will document that it expects already-sanitized input from runtime.
  Rationale: Prompt-context stripping is broader than compaction and should not be duplicated inside every compaction strategy.
  Date/Author: 2026-04-08 / OpenCode

- Decision: The first implementation of the new subsystem keeps the old summary-based behavior almost exactly and defers richer multi-strategy behavior to follow-up changes.
  Rationale: The architectural refactor itself is the primary goal of this pass. Keeping behavior stable reduces migration risk and gives future work a cleaner base.
  Date/Author: 2026-04-08 / OpenCode

- Decision: The Claude Code-inspired pass will adapt the architecture, not the exact message schema. HiJarvis will use structured compaction events and normalized pipeline metadata instead of introducing a new synthetic message role for compact boundaries in this pass.
  Rationale: This preserves compatibility with current upstream message unions while still delivering the architectural benefits of staged compaction.
  Date/Author: 2026-04-08 / OpenCode

- Decision: The first lightweight reduction stage will target oversized `toolResult` text blocks only, using a deterministic textual compaction rather than a model-generated summary.
  Rationale: This is the closest low-risk analogue to Claude Code's pre-summary slimming stages and gives immediate token savings without adding another model call.
  Date/Author: 2026-04-08 / OpenCode

- Decision: Boundary state will now be stored natively in `SessionSnapshot` rather than only in events, and this migration is intentionally breaking with no old snapshot compatibility layer.
  Rationale: The user explicitly allowed destructive changes, and snapshot-backed boundary metadata is the cleanest way to make boundary semantics first-class without introducing fake messages or changing upstream message-role unions.
  Date/Author: 2026-04-08 / OpenCode

- Decision: Auto partial compaction will now be built into the main compaction pipeline and selected heuristically for long histories, rather than being left as an opt-in helper for callers.
  Rationale: The user explicitly asked for these capabilities to be built in rather than exposed as optional interfaces.
  Date/Author: 2026-04-08 / OpenCode

- Decision: Compaction PTL retry will use deterministic oldest-history truncation rather than adding another policy layer or another model call type.
  Rationale: The goal is resilience, not sophistication; a simple local retry strategy is easier to reason about and aligns with the current HiJarvis design level.
  Date/Author: 2026-04-08 / OpenCode

- Decision: The first artifact restoration layer will restore compacted tool-state summaries and recent skill-use metadata as structured user-visible messages inside the compacted payload, rather than introducing a parallel hidden storage format.
  Rationale: This keeps the system inspectable and testable while still separating structured restoration from the summary prompt itself.
  Date/Author: 2026-04-08 / OpenCode

## Outcomes & Retrospective

The subsystem redesign is now partially implemented. The old monolithic file has been replaced by `packages/jar-core/src/compaction/` with separate files for types, policy, prompt, summary generation, assembly, strategy orchestration, and runtime exports. Runtime, config, and session execution now import from the new subtree. The remaining work is to run tests, fix any breakage, and then finish the documentation and retrospective updates.

This first architecture pass is now complete. The monolithic `packages/jar-core/src/compaction.ts` file has been removed. The new subtree exists and is wired into runtime, config, and session execution. `pnpm --filter jar-core test` passes, which demonstrates that the moved summary-based behavior still works through the new subsystem. The main remaining gap is not correctness but capability: the new architecture is ready for future staged compaction features, but those richer strategies have not been implemented yet.

What was achieved in this pass is architectural separation. The code now has explicit boundaries between policy, prompt text, summary generation, compacted-payload assembly, and top-level orchestration. That directly satisfies the purpose of replacing the old one-file design with a first-class subsystem. What was intentionally not achieved in this pass is Claude-Code-level functionality such as lightweight pre-summary reductions, partial compaction, or metadata-rich boundary records. Those should now be added as follow-up changes on top of the new structure rather than mixed into a monolith.

The staged architecture pass is now also complete. HiJarvis now has a compaction pipeline rather than a direct jump from trigger decision to summary compaction. The pipeline currently runs a deterministic lightweight reduction stage over oversized tool results, then runs the summary strategy, then records a final assembly stage. The system also emits and persists richer metadata including stage lists, applied stage names, and a boundary-like summary of what the compacted payload preserved. This is not a literal clone of Claude Code's compact-boundary message model, but it is now structurally much closer to Claude Code's architecture than the previous single-step system.

The full Claude-Code-inspired pass is now complete. The pipeline now includes a snip-style reduction stage, supports layout-aware summary prompt variants, and exposes a partial-compaction entry point that can summarize either the prefix or suffix while preserving the opposite segment. This completes the requested "entire feature" within HiJarvis constraints while keeping message-role compatibility intact.

The snapshot-backed boundary pass is now also complete. HiJarvis no longer relies only on event metadata to remember compaction eras. Session snapshots now persist a first-class compaction boundary, runtime slices history from that boundary before sanitization and compaction, and post-turn compaction writes a fresh boundary immediately after producing a new compacted payload. This is the cleanest boundary design available without changing upstream message-role unions.

The built-in auto-partial and PTL-retry pass is now complete as well. HiJarvis no longer treats partial compaction as a side API only; the main compaction pipeline can now automatically choose a partial strategy for sufficiently long histories, preserving the newest tail while summarizing the older prefix. Summary generation also retries with progressively truncated history when the compaction request itself fails, which closes an important resilience gap compared with the earlier implementation.

The artifact restoration pass is now complete too. HiJarvis compaction no longer relies only on summary text plus preserved raw messages. The pipeline now extracts structured artifacts from pre-compact state, currently including recent tool-state and recent skill-state cues, and renders them back into the compacted payload in a dedicated restoration layer. Artifact metadata also flows through compaction results and events, making the restored state explicit and inspectable.

## Context and Orientation

HiJarvis currently implements compaction in `packages/jar-core/src/compaction.ts`. That file defines the runtime settings shape, the trigger check, the ad hoc summary prompt, the summary-generation helper, the compacted message builder, token estimation helpers, and the context transform used by the runtime. A novice reading the current code has to jump between the runtime, session executor, and tests to understand the end-to-end behavior.

The relevant current files are these:

`packages/jar-core/src/compaction.ts` is the current one-file implementation. It decides when to compact, generates summary text with `completeSimple(...)`, rebuilds the compacted messages, and exports `createCompactionTransform(...)` and `compactHistoryNow(...)`.

`packages/jar-core/src/runtime.ts` creates the agent and installs `agent.transformContext`. Today that transform first strips memory-excluded prompt context from history, then calls `createCompactionTransform(...)` from the old file.

`packages/jar-core/src/session-executor.ts` performs post-turn compaction after successful assistant messages. It constructs the compaction runtime, calls `compactHistoryNow(...)`, replaces `agent.state.messages`, persists the snapshot, and records compaction events.

`packages/jar-core/src/compaction.test.ts` verifies the old message-assembly rules, especially the difference between pre-turn and mid-turn behavior.

`packages/jar-core/src/prompt-context.ts` strips `<skill>...</skill>` blocks from older user messages. This matters because compaction should operate on the sanitized history that runtime already prepares.

`docs/agent-runtime.md` documents current runtime behavior, including prompt compaction.

The new subsystem must make these responsibilities easier to navigate. The architecture in `research/claude-code-compaction/README.md` is the direct design input. That research shows that a mature compaction system benefits from separate policy, strategy, prompt, and assembly layers. We are not required to reproduce Claude Code exactly, but we should absorb the structural lesson.

This plan uses the term “strategy” in plain language to mean one algorithm for reducing context. In the first implementation, we will still have one main strategy: summary compaction. The reason to name it a strategy now is so later work can add lightweight tool-result shrinking, partial compaction, or session-memory-backed compaction without restructuring runtime again.

This plan uses the term “assembly” to mean the code that converts a structured compaction result into the final `Message[]` array stored in agent state. The point of this layer is to keep summary generation separate from final payload construction.

This plan uses the term “policy” to mean code that decides whether compaction should run, what kind should run, and what state should be logged about the decision. Today this logic is mostly `shouldCompactFromUsage(...)`. After the redesign, it should become explicit and extensible.

This plan also uses the term “stage” to mean one step in a compaction pipeline. A stage may shrink oversized tool results, summarize older history, or assemble the final compacted payload. Claude Code uses several stages before and after summarization. HiJarvis will adopt that staged shape, adapted to the message and persistence model already in this repository.

## Plan of Work

The work will proceed in a deliberate migration from the current monolithic file to a new subtree under `packages/jar-core/src/compaction/`.

First, create the new folder and define the shared types. The new folder should include a `types.ts` file that defines the core domain types: compaction settings, runtime context, trigger policy result, summary result, assembly input, and normalized compaction result. The goal is that later files can depend on these shared names instead of each defining local shapes.

Second, create a `policy.ts` file that holds trigger-related logic. It should contain the replacement for `getUsageInputTokens(...)` and `shouldCompactFromUsage(...)`, plus a richer policy result type that can later carry threshold reasoning. Even if the first pass still returns a boolean-oriented outcome, the shape should leave room for richer reasons such as “disabled”, “below threshold”, “post-turn trigger”, or “mid-turn trigger.”

Third, create a `prompt.ts` file that owns only summary prompt text and prompt-building helpers. The current `SUMMARY_PROMPT` and `SUMMARY_PREFIX` constants should move there. The goal is to separate prompt wording from runtime orchestration.

Fourth, create a `summary.ts` file that performs summary generation. This file should absorb the logic currently in `summarizeContext(...)` and `trimMessagesToBudget(...)`. It should accept normalized runtime context and return a normalized summary result. The result should include summary text and optional summary error information instead of relying on loose tuples or anonymous object shapes.

Fifth, create an `assembly.ts` file that contains the replacement for `buildCompactedMessages(...)`, `collectUserMessages(...)`, `collectMinimalToolTail(...)`, summary-message creation, and helper functions that are purely about constructing the resulting compacted payload. This file must remain deterministic and testable without model calls.

Sixth, create a `strategy-summary.ts` file that glues policy, summary generation, and assembly into the first production strategy. This file should replace the body of the old `compactHistory(...)` logic. It should take normalized runtime context and return a normalized compaction result.

Seventh, create an `index.ts` file in the new folder that exposes the public API the rest of the repository will use. This public API should include the replacement for `compactHistoryNow(...)`, the replacement for `createCompactionTransform(...)`, and exported settings/types used by runtime and session execution.

Eighth, rewire `packages/jar-core/src/runtime.ts` and `packages/jar-core/src/session-executor.ts` to import from the new subsystem instead of the old one-file module. Runtime still strips memory-excluded prompt context first, then invokes the new compaction transform. Session execution still triggers post-turn compaction, but now through the new subsystem entry point.

Ninth, rewrite tests. The existing tests in `packages/jar-core/src/compaction.test.ts` should either be moved into the new folder or replaced by multiple focused test files such as `policy.test.ts`, `assembly.test.ts`, and `index.test.ts`. A novice should be able to understand compaction behavior from the tests alone. The message-assembly behavior currently covered by the old tests must still be verified, especially pre-turn versus mid-turn tail preservation.

Tenth, delete the old `packages/jar-core/src/compaction.ts` file once all imports are migrated and tests pass. Because the user explicitly allowed breaking changes, we do not need a compatibility wrapper. Removing the old file is part of the design goal: one obvious subsystem path should exist.

Eleventh, update documentation. `docs/agent-runtime.md` currently describes prompt compaction as a runtime behavior. That section must be updated to mention the new `packages/jar-core/src/compaction/` subsystem and the distinction between policy, summary generation, and assembly. `docs/README.md` must also include a link to the new ExecPlan only if the repository convention requires indexing plans there; otherwise the doc index should be updated only if architectural documentation changes are added as standalone docs.

## Concrete Steps

Work from repository root `/Users/wibus/dev/HiJarvis`.

1. Inspect the current implementation and tests before editing.

    pwd
    read packages/jar-core/src/compaction.ts
    read packages/jar-core/src/runtime.ts
    read packages/jar-core/src/session-executor.ts
    read packages/jar-core/src/compaction.test.ts

   Expected understanding: identify exactly which code moves into policy, prompt, summary, assembly, and orchestration layers.

2. Create the new compaction subtree and shared type definitions.

    mkdir -p packages/jar-core/src/compaction

   Then add the new source files with repository editing tools:

    packages/jar-core/src/compaction/types.ts
    packages/jar-core/src/compaction/policy.ts
    packages/jar-core/src/compaction/prompt.ts
    packages/jar-core/src/compaction/summary.ts
    packages/jar-core/src/compaction/assembly.ts
    packages/jar-core/src/compaction/strategy-summary.ts
    packages/jar-core/src/compaction/index.ts

   Expected outcome: the new folder exists and compiles with placeholder or moved logic.

3. Move logic from the old monolith into the new files.

   The mapping should be exact enough that a novice can follow it:

   In `packages/jar-core/src/compaction/policy.ts`, move or rewrite:

    `getUsageInputTokens(...)`
    `shouldCompactFromUsage(...)`

   In `packages/jar-core/src/compaction/prompt.ts`, move:

    `SUMMARY_PROMPT`
    `SUMMARY_PREFIX`

   In `packages/jar-core/src/compaction/summary.ts`, move or rewrite:

    `summarizeContext(...)`
    `trimMessagesToBudget(...)`
    summary text normalization helpers as needed

   In `packages/jar-core/src/compaction/assembly.ts`, move or rewrite:

    `buildCompactedMessages(...)`
    `createSummaryMessage(...)`
    `collectUserMessages(...)`
    `collectMinimalToolTail(...)`
    token estimation helpers that are only used by assembly

   In `packages/jar-core/src/compaction/strategy-summary.ts`, move or rewrite:

    the current `compactHistory(...)` orchestration

   In `packages/jar-core/src/compaction/index.ts`, expose:

    settings defaults
    runtime-facing entry points
    public types used by runtime and session execution

4. Rewire runtime and session execution.

   Edit `packages/jar-core/src/runtime.ts` so the runtime imports compaction APIs from `packages/jar-core/src/compaction/index.ts`.

   Edit `packages/jar-core/src/session-executor.ts` so post-turn compaction uses the new subsystem exports and no longer imports from the deleted monolith.

5. Rewrite tests around subsystem boundaries.

   Add or update tests in files such as:

    packages/jar-core/src/compaction/assembly.test.ts
    packages/jar-core/src/compaction/policy.test.ts
    packages/jar-core/src/compaction/index.test.ts

   If keeping `packages/jar-core/src/compaction.test.ts` is simpler, it may remain temporarily during migration, but the end state should prefer colocated tests under the new folder.

6. Remove the old monolithic file after imports are migrated.

    delete packages/jar-core/src/compaction.ts

   Expected outcome: only the new subsystem remains, and all repository imports point to it.

7. Update documentation.

   Edit `docs/agent-runtime.md` to describe the new subsystem. If the doc refers to `prompt compaction` as a flat runtime behavior, replace that language with the new policy/summary/assembly structure.

   Review `docs/README.md` and add a dedicated compaction architecture document only if one is written as part of implementation. This ExecPlan itself should remain in `docs/exec-plans/` and should not be added to the main docs index unless the project convention changes.

8. Run tests and capture outputs.

    pnpm --filter jar-core test

   If the repository uses a broader test command for correctness, also run:

    pnpm test

   If typechecking is separated, run:

    pnpm typecheck

   Record the exact commands that pass in this plan's `Artifacts and Notes` and update `Progress` with timestamps.

## Validation and Acceptance

Acceptance is behavior, not just moved files.

First, the repository must build and tests must pass from `/Users/wibus/dev/HiJarvis`. The minimum expected command is:

    pnpm --filter jar-core test

Success means the compaction tests pass and no import points reference the removed `packages/jar-core/src/compaction.ts` file.

Second, the runtime wiring must still compact long sessions. The simplest proof is through automated tests that cover both pre-turn and post-turn compaction paths. Those tests must prove the following observable behaviors:

1. When usage exceeds the configured trigger threshold, post-turn compaction replaces the in-memory message history through the new subsystem.
2. Pre-turn compaction still drops assistant tail content when rebuilding compacted messages.
3. Mid-turn compaction still preserves the minimal tool tail when the latest assistant/tool-result pair must remain available.
4. The summary message still uses the defined summary prefix and remains visible in the resulting messages.
5. The runtime still strips memory-excluded prompt context before compaction occurs.

Third, the architecture itself must be inspectable. A novice reviewer should be able to open `packages/jar-core/src/compaction/index.ts`, `packages/jar-core/src/compaction/policy.ts`, `packages/jar-core/src/compaction/summary.ts`, and `packages/jar-core/src/compaction/assembly.ts` and immediately understand where each responsibility lives. If responsibilities still feel mixed or circular, the redesign is not complete.

Fourth, documentation must match reality. `docs/agent-runtime.md` must mention the new compaction subsystem paths and no longer imply that compaction is a single flat file. If the implementation changes configuration semantics, `jar.example.toml` and `packages/jar-core/src/config.ts` must be updated in the same patch, but this plan assumes no config-shape changes are required for the first redesign.

## Idempotence and Recovery

This migration is safe to perform incrementally as long as the old file is not deleted until the new imports and tests are ready. The recommended recovery strategy is:

1. Create the new subtree first and move code gradually.
2. Keep the old file temporarily while rewiring imports and tests.
3. Delete the old file only after the new entry points compile and tests pass.

If the migration stops halfway, the next contributor should inspect `Progress`, continue rewiring imports, and avoid deleting the old file until the new subtree is complete.

If a test fails after moving helpers into new files, do not immediately rewrite behavior. First compare the new assembly output with the old tests' expectations. This redesign is allowed to break interfaces, but the first implementation should preserve the existing behavioral contract for summary-based compaction unless a deliberate decision is recorded here.

The work is idempotent because the new files can be re-edited repeatedly, the test suite can be rerun safely, and the old file deletion is a final cleanup step rather than an early destructive move.

## Artifacts and Notes

Before implementation, the most important evidence is the current repository state and the design research that motivated this plan.

Expected important artifacts to capture during implementation include:

    packages/jar-core/src/compaction/
      assembly.ts
      assembly.test.ts
      index.ts
      policy.ts
      policy.test.ts
      prompt.ts
      strategy-summary.ts
      summary.ts
      types.ts

Expected passing command transcript to capture after implementation:

    $ pnpm --filter jar-core test
    ...
    ℹ tests 54
    ℹ pass 54
    ℹ fail 0

Observed implementation notes:

    - The old `packages/jar-core/src/compaction.ts` file was deleted.
    - The new subtree now contains `types.ts`, `policy.ts`, `prompt.ts`, `summary.ts`, `assembly.ts`, `strategy-summary.ts`, and `index.ts`.
    - The former `packages/jar-core/src/compaction.test.ts` test file now lives at `packages/jar-core/src/compaction/assembly.test.ts`.
    - The staged pass added `packages/jar-core/src/compaction/lightweight.ts`, `packages/jar-core/src/compaction/lightweight.test.ts`, and `packages/jar-core/src/compaction/pipeline.ts`.
    - `CompactionEvent` and session tracker items now persist stage metadata and boundary-like metadata.

Expected architecture proof to mention in the final retrospective:

    - `runtime.ts` only wires sanitized history into the compaction subsystem.
    - `session-executor.ts` only triggers post-turn compaction through subsystem entry points.
    - prompt text lives in `prompt.ts`, not in runtime orchestration.
    - assembly logic is testable without model calls.

## Interfaces and Dependencies

Use the existing libraries already in `packages/jar-core`: `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`. Do not introduce a new dependency for the first redesign.

At the end of the migration, the new subsystem should expose stable names from `packages/jar-core/src/compaction/index.ts`. The exact signatures may vary slightly, but the repository should end with concepts equivalent to the following:

In `packages/jar-core/src/compaction/types.ts`, define stable exported types for:

    CompactionSettings
    CompactionRuntime
    CompactionKind
    CompactionEvent
    CompactionNowResult
    CompactionPolicyDecision
    SummaryGenerationResult
    CompactionResult

In `packages/jar-core/src/compaction/policy.ts`, define exported functions equivalent to:

    getUsageInputTokens(usage?: Usage): number
    shouldCompactFromUsage(usage: Usage | undefined, runtime: Pick<CompactionRuntime, "model" | "settings">): boolean

If a richer decision function is added, prefer a stable name such as:

    decideCompactionFromUsage(usage: Usage | undefined, runtime: Pick<CompactionRuntime, "model" | "settings">): CompactionPolicyDecision

In `packages/jar-core/src/compaction/summary.ts`, define a function equivalent to:

    summarizeHistory(messages: Message[], runtime: CompactionRuntime, systemPromptTokens: number, signal?: AbortSignal): Promise<SummaryGenerationResult>

In `packages/jar-core/src/compaction/assembly.ts`, define a function equivalent to:

    buildCompactedMessages(input: BuildCompactedMessagesInput): Message[]

In `packages/jar-core/src/compaction/strategy-summary.ts`, define the main summary strategy orchestration, with a stable name such as:

    compactWithSummaryStrategy(history: Message[], kind: CompactionKind, runtime: CompactionRuntime, signal?: AbortSignal): Promise<CompactionResult>

In `packages/jar-core/src/compaction/index.ts`, define the runtime-facing exports, equivalent to:

    defaultCompactionSettings
    compactHistoryNow(...)
    createCompactionTransform(...)

The runtime dependency flow should be one-way:

- `runtime.ts` depends on `compaction/index.ts`
- `session-executor.ts` depends on `compaction/index.ts`
- `compaction/index.ts` depends on internal compaction modules
- internal compaction modules must not import `runtime.ts` or `session-executor.ts`

Keep token-estimation helpers as close as possible to the layer that uses them. If a helper is only needed by assembly, it stays in `assembly.ts`. If it is shared by multiple layers, move it into a clearly named `tokens.ts` file inside the subsystem rather than recreating another monolith.

Revision note: Updated after the first migration pass to record that the new `packages/jar-core/src/compaction/` subtree now exists, imports have been rewired, the old monolith has been removed, and the remaining work is validation plus final documentation cleanup.

Revision note: Updated after validation to record passing `jar-core` tests, completed documentation updates, and the end state of the first architecture pass.

Revision note: Updated again after implementing the Claude-Code-inspired staged compaction architecture, including the lightweight reduction stage, pipeline metadata, session event persistence, and passing `jar-core` tests.
