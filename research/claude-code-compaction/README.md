# Claude Code Compaction Research

This document is a deep research note about Claude Code's compaction system.
The goal is to understand Claude Code's compaction architecture well enough to redesign HiJarvis compaction as a first-class subsystem.
The focus is not on copying Claude Code line-for-line.
The focus is on reconstructing the actual data flow, trigger model, prompt strategy, post-compaction assembly, and supporting state transitions.

All file references are to `/Users/wibus/dev/claude-code-source` unless noted otherwise.

## Why this document exists

Claude Code's compaction system is not a single helper that summarizes history when token usage gets too high.
It is a layered context-management stack.

At a high level, Claude Code does all of the following:

1. applies lightweight context reduction before full summarization
2. separates multiple compaction modes with different ownership and suppression rules
3. treats the compacted output as a new structured context state
4. restores non-summary state after compaction with attachments and metadata
5. tracks compaction operationally with telemetry, cache interactions, and retry handling

This is materially different from the current HiJarvis implementation, which is much closer to a summary-based checkpoint reducer.

## Primary files

These are the most important files for understanding Claude Code compaction.

- `query.ts:365` to `query.ts:549`: main runtime orchestration seam
- `services/compact/autoCompact.ts:1` to `services/compact/autoCompact.ts:351`: thresholds, eligibility checks, autocompact wrapper
- `services/compact/compact.ts:299` to `services/compact/compact.ts:769`: full compaction result structure, request flow, post-compaction assembly
- `services/compact/prompt.ts:1` to `services/compact/prompt.ts:374`: compaction prompt templates and prompt variants
- `services/compact/microCompact.ts:1` to `services/compact/microCompact.ts:530`: lightweight tool-result-oriented compaction
- `services/compact/sessionMemoryCompact.ts`: alternate compaction path using session memory
- `services/compact/postCompactCleanup.ts`: cleanup after successful compaction
- `commands/compact/compact.ts`: manual `/compact` entry point
- `remote/sdkMessageAdapter.ts:97` to `remote/sdkMessageAdapter.ts:138`: UI/SDK mapping of compact status and compact boundary messages
- `services/SessionMemory/sessionMemory.ts`: upstream memory condensation that influences compaction strategy

## Executive summary

The shortest accurate description is this:

Claude Code manages context pressure with a staged pipeline, not a single summarization step.

Before it summarizes, it tries multiple cheaper or narrower reductions.
After it summarizes, it rebuilds a new structured context state instead of merely replacing history with one summary block.

The main query loop makes this visible.
In `query.ts:365` to `query.ts:467`, the runtime performs the following sequence:

1. start from messages after the latest compact boundary
2. apply tool-result budget trimming
3. apply `snip` if needed
4. apply `microcompact`
5. apply context collapse projection
6. apply full autocompact if still needed

If a full compaction succeeds, `query.ts:470` to `query.ts:535` logs analytics, rebuilds the compacted message array with `buildPostCompactMessages(...)`, yields the new messages, and continues the current query using that new payload.

That last point matters a lot.
Compaction is not merely a post-turn archival step.
It can happen inside the current request path and then the system continues with the compacted state.

## Terminology

This document uses a few phrases repeatedly.

- `full compaction`: a summary-generating operation that creates a compact boundary and summary messages
- `light compaction`: local shrinking passes like `snip` or `microcompact`
- `boundary`: the synthetic compact-boundary system message inserted after successful full compaction
- `post-compact payload`: the rebuilt message array that the next model invocation sees after compaction
- `session-memory compaction`: the alternate path that derives compacted state from the session-memory subsystem
- `partial compaction`: summarizing only one region while preserving another raw region
- `collapse`: the context-collapse subsystem, which is related to compaction but is not the same thing

## 1. Query-loop orchestration

The runtime orchestration lives in `query.ts`, especially `query.ts:365` to `query.ts:549`.

### 1.1 Start from the latest compact boundary

At `query.ts:365`, the loop initializes with:

- `let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]`

This means the active query does not blindly replay the entire persisted transcript every turn.
It starts from the region after the latest compact boundary.

So the compact boundary is not just a visible marker.
It is an execution seam.

### 1.2 Tool-result budgeting runs first

At `query.ts:379` to `query.ts:394`, the system applies `applyToolResultBudget(...)`.

This pass enforces per-message budget controls on aggregate tool result size.
The comments explain why it runs before microcompact:

- cached microcompact works by `tool_use_id`
- it does not inspect full content
- replacing tool content earlier does not break its logic

This shows Claude Code explicitly optimizes heavy tool outputs before considering heavier compaction machinery.

### 1.3 Snip runs before microcompact and autocompact

At `query.ts:401` to `query.ts:409`, `snipCompactIfNeeded(...)` may reduce history further.

Important details from comments and code:

- both `snip` and `microcompact` may run in the same request
- `snip` computes `snipTokensFreed`
- `snipTokensFreed` is later passed into autocompact threshold checks

This exists because token counting from API usage can lag behind structural reductions.
The system does not trust a single token source blindly.

### 1.4 Microcompact runs before full autocompact

At `query.ts:412` to `query.ts:426`, the system calls `deps.microcompact(...)`.

The comments note a cached-microcompact path where boundary messages about cache edits are deferred until after the API response, so real `cache_deleted_input_tokens` can be known.

So microcompact is not only about shrinking message payloads.
It also coordinates with prompt-cache accounting.

### 1.5 Context collapse is a projection, not a summary rewrite

At `query.ts:428` to `query.ts:447`, context collapse may project a collapsed view.

The comments are unusually clear about semantics:

- nothing is yielded here
- the collapsed view is a read-time projection over full REPL history
- summary messages live in the collapse store, not in the REPL array

This is a key conceptual difference.

Context collapse is not the same as compaction.
Context collapse behaves like a view system over a commit log.
Full compaction behaves like a replacement of the working message array.

### 1.6 Autocompact runs only after lighter reductions

At `query.ts:453` to `query.ts:467`, the system calls `deps.autocompact(...)`.

This ordering is intentional.
The comments say collapse runs before autocompact so that if collapse gets the session back under threshold, autocompact becomes a no-op and the system preserves more granular context instead of flattening everything into a single summary.

This is one of the best high-level design lessons from Claude Code:

full summary is treated as lossy and expensive, so it is deferred until narrower reductions fail to create enough headroom.

### 1.7 If compaction succeeds, the current request continues with the compacted state

At `query.ts:470` to `query.ts:535`:

- analytics are logged
- task budget is updated
- tracking is reset to a new compact turn id
- `buildPostCompactMessages(compactionResult)` is called
- those messages are yielded
- `messagesForQuery` is replaced with the post-compact payload

This is crucial for redesign work.

If HiJarvis eventually wants an equally capable compaction subsystem, compaction cannot be modeled only as a persistence-time cleanup step.
It must be able to return a replacement context payload that the current request can continue using.

## 2. Thresholds and token windows

Threshold logic lives in `services/compact/autoCompact.ts`.

### 2.1 Effective context window

Claude Code does not directly use raw model context window as the compaction threshold base.

`getEffectiveContextWindowSize(model)` in `services/compact/autoCompact.ts:33` to `services/compact/autoCompact.ts:49` computes:

- model context window
- minus reserved output budget for the compaction summary

The reserve is capped by `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000` in `services/compact/autoCompact.ts:30`.

This is a subtle but important design choice.
The system reserves room for the summary-generating response itself.
Many simpler implementations forget that the compact request also needs output room.

### 2.2 Auto-compact threshold

`getAutoCompactThreshold(model)` in `services/compact/autoCompact.ts:72` to `services/compact/autoCompact.ts:91` computes:

- `effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS`

`AUTOCOMPACT_BUFFER_TOKENS` is `13_000` in `services/compact/autoCompact.ts:62`.

There are also env overrides:

- `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`

Those are useful for testing and operational tuning.

### 2.3 Warning, error, and blocking states are separate from compaction itself

`calculateTokenWarningState(...)` in `services/compact/autoCompact.ts:93` to `services/compact/autoCompact.ts:145` computes:

- `percentLeft`
- `isAboveWarningThreshold`
- `isAboveErrorThreshold`
- `isAboveAutoCompactThreshold`
- `isAtBlockingLimit`

This tells us Claude Code does not collapse all context-pressure policy into a single `shouldCompact` boolean.

There is a broader operational model:

- warn the user
- determine whether auto-compaction should run
- determine whether the system is hard-blocked

For HiJarvis, that suggests the future compaction subsystem should probably expose a richer status model than a single yes/no decision.

### 2.4 Threshold checks compensate for earlier reductions

`shouldAutoCompact(...)` in `services/compact/autoCompact.ts:160` to `services/compact/autoCompact.ts:239` estimates token count as:

- `tokenCountWithEstimation(messages) - snipTokensFreed`

The comments explain why:

- `snip` may have removed content
- the surviving assistant usage may still reflect pre-snip context size
- raw usage data alone would mislead threshold checks

Again, this shows the system is careful not to rely on one token source mechanically.

## 3. Auto-compaction eligibility and suppression rules

One of the strongest architectural lessons from Claude Code is that multiple context-management subsystems are not allowed to fight each other.

`shouldAutoCompact(...)` contains a sequence of suppression rules before it even compares token usage to thresholds.

### 3.1 Recursion guards

The function returns false for query sources:

- `session_memory`
- `compact`

See `services/compact/autoCompact.ts:169` to `services/compact/autoCompact.ts:173`.

The reason is straightforward.
Forked agents used for session memory or compaction should not recursively trigger autocompact.

### 3.2 Context-collapse-specific suppression

With the feature gate enabled, the function also suppresses auto-compaction for the collapse agent source `marble_origami` in `services/compact/autoCompact.ts:174` to `services/compact/autoCompact.ts:183`.

The comments explain that autocompact firing inside the collapse agent could destroy the main thread's committed collapse log because of shared module-level state.

So this suppression is not cosmetic.
It protects correctness of another subsystem.

### 3.3 Global config and env disables

`isAutoCompactEnabled()` in `services/compact/autoCompact.ts:147` to `services/compact/autoCompact.ts:158` checks:

- `DISABLE_COMPACT`
- `DISABLE_AUTO_COMPACT`
- user config `autoCompactEnabled`

This separates disabling all compaction from disabling only auto-compaction while still allowing manual compaction.

### 3.4 Reactive-only suppression

Under the `REACTIVE_COMPACT` feature gate, `shouldAutoCompact(...)` can return false in reactive-only mode.
See `services/compact/autoCompact.ts:189` to `services/compact/autoCompact.ts:199`.

That means Claude Code can operate in a mode where proactive threshold-based compaction is suppressed and prompt-too-long reactions are left to a separate reactive path.

### 3.5 Context-collapse ownership

One of the best comments in the file appears around `services/compact/autoCompact.ts:201` to `services/compact/autoCompact.ts:223`.

When context collapse is enabled, autocompact is suppressed because collapse becomes the main context-management system.
The comment explicitly says autocompact would otherwise race collapse and usually win, destroying granular context that collapse was about to save.

This is a very important design principle for HiJarvis.

If we add multiple compaction-like layers in our redesign, each layer needs clear ownership, priority, and suppression rules.
Otherwise they will undermine each other.

## 4. The autocompact wrapper

`autoCompactIfNeeded(...)` in `services/compact/autoCompact.ts:241` to `services/compact/autoCompact.ts:351` is more than a thin shell.
It is the operational wrapper around full compaction.

### 4.1 Circuit breaker for repeated failures

The wrapper checks `tracking?.consecutiveFailures` against `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`.
See `services/compact/autoCompact.ts:67` to `services/compact/autoCompact.ts:70` and `services/compact/autoCompact.ts:260` to `services/compact/autoCompact.ts:265`.

This is practical engineering.
Without it, an unrecoverable overlong session could keep attempting compaction every turn and just burn API calls.

### 4.2 Recompaction metadata

When compaction is warranted, the wrapper builds `recompactionInfo` in `services/compact/autoCompact.ts:279` to `services/compact/autoCompact.ts:285`.

This includes:

- whether this is a recompaction in the same chain
- turns since previous compact
- previous compact turn id
- current auto threshold
- query source

This metadata is later fed into `compactConversation(...)`.
It is useful for analytics and operational reasoning.

### 4.3 Session-memory path comes before legacy full summarization

One of the most important findings is here.

At `services/compact/autoCompact.ts:287` to `services/compact/autoCompact.ts:309`, the wrapper first tries `trySessionMemoryCompaction(...)`.

If it succeeds, the wrapper:

- resets summarized-message state
- runs post-compact cleanup
- notifies prompt-cache-break detection
- marks post-compaction state
- returns success without calling legacy full compaction

This means that even after the threshold is exceeded, Claude Code still has an alternate compaction path before it falls back to full conversation summarization.

### 4.4 Legacy full compaction path

Only if session-memory compaction does not succeed does the wrapper call `compactConversation(...)` at `services/compact/autoCompact.ts:313` to `services/compact/autoCompact.ts:321`.

On success, it resets summarized-message state and runs cleanup.
On failure, it increments `consecutiveFailures` and may eventually trip the circuit breaker.

This tells us the autocompact wrapper is stateful across turns.
It does not just inspect the current messages.
It also remembers the operational reliability of compaction itself.

## 5. Full compaction result shape

The return type from full compaction is defined in `services/compact/compact.ts:299` to `services/compact/compact.ts:310` as `CompactionResult`.

It contains:

- `boundaryMarker`
- `summaryMessages`
- `attachments`
- `hookResults`
- optional `messagesToKeep`
- optional `userDisplayMessage`
- optional token-count and usage fields

This is far richer than a shape like `{ summaryText, messages }`.

That tells us two things.

First, Claude Code expects compaction to preserve or restore non-summary artifacts.
Second, Claude Code separates what is needed by the model from what is needed by telemetry or the UI.

### 5.1 Canonical post-compact ordering

`buildPostCompactMessages(result)` in `services/compact/compact.ts:330` to `services/compact/compact.ts:338` defines the ordering:

1. `boundaryMarker`
2. `summaryMessages`
3. `messagesToKeep`
4. `attachments`
5. `hookResults`

This is a strong design pattern.
All compaction paths can converge on one normalized payload shape.

For HiJarvis, this argues in favor of designing a single normalized `CompactionResult` and one payload builder, instead of multiple ad hoc compacted-message constructors.

## 6. Compact boundary semantics

The compact boundary is one of the most important concepts in the system.

### 6.1 Boundary as execution seam

The boundary is created around `services/compact/compact.ts:598` to `services/compact/compact.ts:602`.
The query loop later slices history after the latest boundary with `getMessagesAfterCompactBoundary(...)` in `query.ts:365`.

So the boundary partitions the transcript into eras.
Everything before the latest boundary is treated as already semantically represented elsewhere.

### 6.2 Boundary as metadata carrier

At `services/compact/compact.ts:603` to `services/compact/compact.ts:611`, the boundary also stores pre-compact discovered-tool state.

The comment explains why:

- the summary does not preserve `tool_reference` blocks
- the post-compact schema filter still needs to know about already-loaded deferred tool schemas

This is a crucial lesson.
Summary text alone is not enough to preserve all execution state.
Some state has to live in structured metadata.

### 6.3 Boundary can describe preserved segments

`annotateBoundaryWithPreservedSegment(...)` in `services/compact/compact.ts:349` to `services/compact/compact.ts:367` adds `preservedSegment` metadata when a raw message segment is preserved.

That metadata includes:

- `headUuid`
- `anchorUuid`
- `tailUuid`

The comments explain that preserved messages keep original parent UUIDs on disk and the loader later uses this metadata to relink head, anchor, and tail correctly.

This is one of the deepest differences from HiJarvis.
Claude Code thinks about transcript graph correctness after compaction, not only about the visible message list.

### 6.4 Boundary is surfaced to UI/SDK layers

`remote/sdkMessageAdapter.ts:133` to `remote/sdkMessageAdapter.ts:138` maps a `compact_boundary` subtype with content `Conversation compacted` and attached metadata.

This means the compact boundary is a cross-layer concept, not only an internal implementation detail.

## 7. Full compaction prompt design

Prompt design lives in `services/compact/prompt.ts`.

The strongest overall impression is this:

Claude Code treats compact summaries as engineered handoff artifacts, not casual summaries.

### 7.1 The no-tools preamble

`NO_TOOLS_PREAMBLE` in `services/compact/prompt.ts:19` to `services/compact/prompt.ts:26` says:

- respond with text only
- do not call any tools
- tools will be rejected and waste the only turn
- the response must be `<analysis>` followed by `<summary>`

This suggests that the compaction worker shares enough environment with normal tool-capable agents that explicit suppression is necessary.

### 7.2 The prompt forces structured thinking before structured output

`DETAILED_ANALYSIS_INSTRUCTION_BASE` and `DETAILED_ANALYSIS_INSTRUCTION_PARTIAL` in `services/compact/prompt.ts:31` to `services/compact/prompt.ts:59` require the model to analyze chronologically and pay attention to:

- explicit user requests
- the assistant's approach
- key technical concepts and code patterns
- file names
- full code snippets
- function signatures
- file edits
- errors and fixes
- explicit user feedback about doing something differently

The prompt comments also note that the `<analysis>` block is a drafting scratchpad stripped before the summary enters retained context.

### 7.3 The main summary template is extremely detailed

`BASE_COMPACT_PROMPT` in `services/compact/prompt.ts:61` to `services/compact/prompt.ts:143` requires these sections:

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and fixes
5. Problem Solving
6. All user messages
7. Pending Tasks
8. Current Work
9. Optional Next Step

This is much heavier than HiJarvis's current summary prompt.

The inclusion of `All user messages` is especially revealing.
Claude Code is explicitly protecting against the failure mode where long sessions forget the user's evolving intent.

### 7.4 Additional summarization instructions can be injected

The prompt file allows additional compaction instructions to be present in context, with examples shown around `services/compact/prompt.ts:133` to `services/compact/prompt.ts:143`.

That suggests compaction is designed to be policy-extensible.

For HiJarvis, this points toward a future design where compaction policy can inject repository-specific or domain-specific emphasis instead of using one static summary prompt for every situation.

## 8. Prompt variants and partial-compaction modes

Claude Code does not use a single prompt for every compaction layout.

### 8.1 Base prompt for whole-conversation summarization

That is `BASE_COMPACT_PROMPT`.
It assumes the summary stands in for the whole older conversation.

### 8.2 Partial prompt for summarizing only recent messages

`PARTIAL_COMPACT_PROMPT` in `services/compact/prompt.ts:145` to `services/compact/prompt.ts:204` explicitly says earlier retained context is being kept intact and should not be redundantly summarized.

That is a layout-aware prompt.
It is chosen based on how the summary will sit inside the final payload.

### 8.3 Up-to prompt for summarizing an older prefix before newer raw messages

`PARTIAL_COMPACT_UP_TO_PROMPT` in `services/compact/prompt.ts:206` to `services/compact/prompt.ts:260` is for the case where the summary will appear before newer intact messages that the summarizer does not see.

This variant asks for `Context for Continuing Work` instead of `Current Work` because the preserved tail continues after the summarized prefix.

This is one of the clearest indications that Claude Code thinks of compaction as a context-layout problem, not merely a summarization problem.

## 9. Full compaction request flow

The body of `compactConversation(...)` starts at `services/compact/compact.ts:387`.

### 9.1 Setup and lifecycle signaling

The function first:

- rejects empty input
- computes `preCompactTokenCount`
- gets app state
- logs permission context
- emits compact-progress events
- sets SDK status to `compacting`

Relevant lines:

- `services/compact/compact.ts:397` to `services/compact/compact.ts:404`
- `services/compact/compact.ts:406` to `services/compact/compact.ts:429`

This shows full compaction is a managed protocol with UI and hook-visible lifecycle states.

### 9.2 Pre-compact hooks can modify instructions

At `services/compact/compact.ts:413` to `services/compact/compact.ts:424`, the function runs `executePreCompactHooks(...)`.

Hook-provided instructions are merged with explicit user instructions via `mergeHookInstructions(...)`.
Hooks may also produce a user-display message.

So the compaction request prompt is not purely static.
It can be influenced by hook policy.

### 9.3 Prompt-cache sharing is explicitly considered

At `services/compact/compact.ts:431` to `services/compact/compact.ts:438`, the code decides whether prompt-cache sharing is enabled.

This tells us the compaction request itself is performance-sensitive enough that cache-hit behavior matters.

### 9.4 Build request and enter summary loop

The prompt is built with `getCompactPrompt(customInstructions)` and wrapped in a user message at `services/compact/compact.ts:440` to `services/compact/compact.ts:443`.

Then the function enters a loop calling `streamCompactSummary(...)` at `services/compact/compact.ts:450` to `services/compact/compact.ts:491`.

The text is extracted with `getAssistantMessageText(summaryResponse)`.

### 9.5 Even compaction itself can hit prompt-too-long

If the summary response starts with the prompt-too-long error prefix, Claude Code does not give up immediately.
Instead, it truncates older history and retries.

This is a very mature implementation detail.

## 10. Prompt-too-long retry strategy

`truncateHeadForPTLRetry(...)` in `services/compact/compact.ts:243` and following lines is the fallback when the compaction request itself is too long.

Key details:

- it drops oldest API-round groups rather than arbitrary single messages
- if the token gap is not parseable, it falls back to dropping about 20 percent of groups
- it strips its own synthetic retry marker before regrouping so repeated retries still make progress
- it limits attempts with `MAX_PTL_RETRIES = 3`

The retry loop logs `tengu_compact_ptl_retry` around `services/compact/compact.ts:479` to `services/compact/compact.ts:483`.
If recovery fails, it logs `tengu_compact_failed` and throws.

This is worth carrying into HiJarvis design work.
Any serious compaction subsystem must consider the possibility that the compaction request itself becomes too large.

## 11. Message sanitization before summary generation

Claude Code does not summarize raw history blindly.

### 11.1 Strip images and documents

`stripImagesFromMessages(...)` in `services/compact/compact.ts:145` to `services/compact/compact.ts:200` replaces image and document blocks with markers like `[image]` and `[document]`.

The comments explain why:

- images are not needed to generate a conversation summary
- images can cause the compaction API call itself to hit prompt-too-long

### 11.2 Strip attachments that will be reintroduced anyway

`stripReinjectedAttachments(...)` in `services/compact/compact.ts:211` to `services/compact/compact.ts:223` filters some attachment types that are reintroduced after compaction anyway, such as skill discovery and skill listing attachments under a feature gate.

The rationale is that feeding those into the summarizer wastes tokens and pollutes the summary with stale suggestions.

This reveals a clean design pattern:

if some state will be restored structurally after compaction, there is no reason to make the summary carry it textually too.

## 12. Post-compact assembly

The most important assembly logic is around `services/compact/compact.ts:596` to `services/compact/compact.ts:748`.

### 12.1 Build the boundary marker first

The compact boundary marker is created at `services/compact/compact.ts:598` to `services/compact/compact.ts:602`.
It records trigger kind, pre-compact token count, and the last message UUID from the pre-compact slice.

### 12.2 Carry discovered-tool state through the boundary

At `services/compact/compact.ts:606` to `services/compact/compact.ts:610`, discovered tools from the pre-compact messages are copied onto `boundaryMarker.compactMetadata.preCompactDiscoveredTools`.

This exists because summary text does not preserve `tool_reference` state accurately enough for downstream schema handling.

### 12.3 Create compact summary messages as explicit user messages

At `services/compact/compact.ts:614` to `services/compact/compact.ts:624`, `summaryMessages` are built using `getCompactUserSummaryMessage(summary, suppressFollowUpQuestions, transcriptPath)`.

The summary message is marked:

- `isCompactSummary: true`
- `isVisibleInTranscriptOnly: true`

That indicates Claude Code distinguishes transcript semantics, UI semantics, and model-context semantics even within summary messages.

### 12.4 Estimate resulting compact payload size

At `services/compact/compact.ts:629` to `services/compact/compact.ts:642`, the code computes:

- `compactionCallTotalTokens` from the compaction API response
- `truePostCompactTokenCount` as a rough estimate over the actual rebuilt payload

The comments note that the next iteration still sees system prompt, tools, and user context too, so the resulting-context estimate is useful but not perfect.

### 12.5 Return structured artifacts, not just summary text

The final return at `services/compact/compact.ts:738` to `services/compact/compact.ts:748` includes:

- boundary marker
- summary messages
- attachments
- hook results
- usage data
- token metrics

This is the core signal that Claude Code treats compaction as rebuilding a new execution state, not just shortening a transcript.

## 13. What gets reintroduced after compaction

The post-compact payload can contain at least five categories of content:

1. boundary marker
2. compact summary messages
3. raw messages explicitly kept
4. attachments
5. hook result messages

The attachment imports at the top of `services/compact/compact.ts` are especially revealing.
The file imports helpers such as:

- `generateFileAttachment`
- `getAgentListingDeltaAttachment`
- `getDeferredToolsDeltaAttachment`
- `getMcpInstructionsDeltaAttachment`

See `services/compact/compact.ts:35` to `services/compact/compact.ts:40`.

That strongly suggests compaction must reintroduce multiple kinds of derived execution state, not only a textual summary of old conversation.

This is one of the most important architectural takeaways for HiJarvis.
We should separate:

- summarizable conversation history
- machine-meaningful execution state that should be reintroduced structurally

## 14. Hooks around compaction

Compaction is hook-aware before and after the summary operation.

### 14.1 Pre-compact hooks

Pre-compact hooks run at `services/compact/compact.ts:413` to `services/compact/compact.ts:419`.
They can inject or merge custom instructions and can emit user-display text.

### 14.2 Session-start hooks after successful compaction

At `services/compact/compact.ts:591` to `services/compact/compact.ts:595`, the system runs `processSessionStartHooks('compact', ...)` after successful compaction.
The resulting hook messages are appended into the post-compact payload.

### 14.3 Post-compact hooks

Post-compact hooks run at `services/compact/compact.ts:719` to `services/compact/compact.ts:729`.
Their user-display messages are combined with any pre-hook display messages at `services/compact/compact.ts:731` to `services/compact/compact.ts:736`.

This means compaction is a lifecycle with extension points, not a closed helper.

## 15. Telemetry and analytics

Claude Code instruments compaction heavily.

### 15.1 Query-loop success telemetry

In `query.ts:478` to `query.ts:499`, `tengu_auto_compact_succeeded` logs:

- original message count
- compacted message count
- pre- and post-compact token counts
- cache-read and cache-creation token counts
- total compaction token cost
- query chain id and depth

### 15.2 Full compaction telemetry

In `services/compact/compact.ts:650` to `services/compact/compact.ts:695`, `tengu_compact` logs:

- pre-compact token count
- compaction API call token usage
- estimated resulting compact payload size
- threshold and retrigger estimate
- auto/manual mode
- query source
- query chain id and depth
- recompaction metadata
- prompt-cache-sharing state
- context-analysis metrics

This tells us Claude Code treats compaction as a measured operational subsystem.
It wants to know not only whether compaction happened, but how much it cost and whether it really solved the headroom problem.

## 16. Prompt cache interactions

Prompt cache behavior is woven into the compaction system.

### 16.1 Cache sharing for compaction requests

At `services/compact/compact.ts:431` to `services/compact/compact.ts:438`, the compaction path decides whether prompt-cache sharing is enabled for the compaction request itself.

### 16.2 Notify compaction to reset cache-break detection

After compaction, `notifyCompaction(...)` is called in `services/compact/compact.ts:697` to `services/compact/compact.ts:703` and similarly in the session-memory path in `services/compact/autoCompact.ts:298` to `services/compact/autoCompact.ts:304`.

The comments explain that this prevents the post-compaction drop in cache reads from being misclassified as a prompt-cache break.

### 16.3 Cached microcompact state

`services/compact/microCompact.ts:52` onward defines cached-microcompact state, including:

- pending cache edits
- pinned cache edits
- marking tools sent to the API
- resetting microcompact state

The query-loop comments at `query.ts:420` to `query.ts:425` tie this back into response-time accounting of deleted cache tokens.

So compaction is not isolated from provider-performance concerns.
It is co-designed with prompt caching.

## 17. Microcompact overview

`services/compact/microCompact.ts` implements a lighter-weight reduction pass than full summary compaction.

### 17.1 Microcompact targets tool-heavy history

`COMPACTABLE_TOOLS` in `services/compact/microCompact.ts:40` to `services/compact/microCompact.ts:50` includes tools such as:

- file read
- shell
- grep
- glob
- web search
- web fetch
- file edit
- file write

That tells us microcompact is aimed at high-volume tool-result producers.

### 17.2 Token estimation is tool-aware

`services/compact/microCompact.ts:137` to `services/compact/microCompact.ts:205` contains explicit token-estimation logic for tool results, images, documents, tool calls, thinking blocks, and other structured blocks.

This suggests microcompact needs a rough but broad understanding of where tokens are really going inside mixed content arrays.

### 17.3 Microcompact is not just a textual summary system

The file structure and comments show that microcompact works partly by identifying tool use ids, replacing or clearing old tool-result content, and coordinating with cache state.
It is best thought of as targeted stateful cleanup for bulky tool artifacts.

For HiJarvis, a future compaction redesign should probably include a lightweight pre-summary layer specifically for large tool outputs.

## 18. Manual `/compact` path

The manual entry point lives in `commands/compact/compact.ts`.

Notable behavior from the orchestration in that file:

- it starts from `getMessagesAfterCompactBoundary(...)`, not full raw history
- it tries session-memory compaction first
- it may route through reactive compact depending on configuration
- otherwise it applies `microcompactMessages(...)` and then `compactConversation(...)`

This mirrors the general architectural pattern seen in the main query loop: even manual compaction is not modeled as a direct single-step summary operation.

## 19. Session-memory compaction relationship

The autocompact wrapper and manual compact path both try a session-memory-backed path first.

Even without reading every line of `services/compact/sessionMemoryCompact.ts`, the call sites tell us enough about the relationship:

- session memory is considered a first-class alternative compaction source
- it can prune or replace history without going through the legacy whole-conversation summary route
- successful session-memory compaction still participates in post-compact cleanup, cache-break handling, and post-compaction state marking

This matters for HiJarvis because it suggests a future architecture where compaction is not one algorithm.
It is a coordinator choosing between multiple compaction strategies.

## 20. Partial compaction

`services/compact/compact.ts` also contains a partial compaction path beginning around `services/compact/compact.ts:766`.

The comments describe two directions:

- `from`: summarize messages after a selected index and keep earlier messages intact
- `up_to`: summarize messages before a selected index and keep later messages intact

This is a sophisticated capability.
It means Claude Code can compact only part of the transcript rather than collapsing everything before “now” into one summary.

The prompt variants in `services/compact/prompt.ts` exist specifically to support this kind of context layout.

This is a major design difference from HiJarvis, which currently treats compaction as a single whole-history checkpointing move.

## 21. Failure handling beyond prompt-too-long

Failure handling in Claude Code compaction is multi-layered.

The notable mechanisms are:

- user-abort special-casing via `ERROR_MESSAGE_USER_ABORT`
- prompt-too-long retry loop inside full compaction
- autocompact consecutive-failure circuit breaker
- cleanup and cache-baseline resets after successful compaction paths
- suppression rules to prevent context-management subsystems from recursively breaking each other

Taken together, this is the profile of a subsystem that has been operated at enough scale to accumulate defensive engineering.

## 22. Core architectural takeaways for HiJarvis

The most important lessons are not “copy this exact prompt” or “copy this exact threshold.”
The important lessons are structural.

### 22.1 Compaction should be a subsystem, not one helper file

Claude Code clearly treats compaction as a subsystem with:

- orchestration
- thresholds
- lightweight reductions
- full summarization
- alternate strategies
- payload rebuilding
- metadata carriers
- lifecycle hooks
- telemetry
- cache coordination

That strongly supports your instinct to move HiJarvis compaction into its own `compaction/` folder and redesign it as a coherent module tree.

### 22.2 Summary should not carry all responsibility

Claude Code does not try to force one summary blob to preserve every kind of state.
It uses:

- summary messages for handoff semantics
- boundary metadata for execution-state continuity
- attachments for restored context artifacts
- hook messages for reintroduced policy or startup state

HiJarvis should likely adopt the same separation of concerns.

### 22.3 Introduce lightweight pre-summary reductions

The current HiJarvis model goes from threshold directly to summary compaction.
Claude Code demonstrates the value of first trying:

- tool-result shrinking
- snip-like pruning
- maybe future collapse-style view projection

That preserves more granular conversational context when heavy tool outputs are the real problem.

### 22.4 Introduce normalized compaction results

A future HiJarvis `CompactionResult` should probably be something like:

- boundary/meta record
- summary messages
- preserved raw segment
- restored context artifacts
- token accounting
- telemetry-ready metadata

That will scale much better than having one function directly return a replacement `Message[]`.

### 22.5 Compaction prompts should become layout-aware

If HiJarvis later adds partial compaction or multiple retention modes, it should not use one fixed summary prompt in every case.
Claude Code's base/partial/up_to split is a good model for prompt specialization by payload layout.

### 22.6 Add explicit subsystem ownership rules

If HiJarvis adds multiple context-management layers, it should also add clear suppression rules so they do not race each other.
Claude Code's handling of collapse versus autocompact is a strong example.

## 23. Suggested next design work for HiJarvis

This research document stops at understanding Claude Code rather than proposing final HiJarvis implementation details, but the natural next step is clear.

The next design package for HiJarvis should likely define a `packages/jar-core/src/compaction/` subtree with at least these concerns split out:

- `policy.ts`: thresholds, warning state, trigger policy
- `lightweight.ts`: tool-result trimming, snip-like logic
- `summary.ts`: prompt building, summary invocation, output parsing
- `assembly.ts`: post-compact payload construction
- `boundary.ts`: compact-boundary metadata structures and helpers
- `strategies/`: full-summary, session-memory-like, future partial compaction
- `telemetry.ts`: compaction metrics and event emission
- `types.ts`: normalized compaction result and policy result types

If we do that, we will be much closer to a true compaction system rather than a single summarization transform.

## Closing note

The single most important conclusion is this:

Claude Code's compaction mechanism is not fundamentally “a better summary prompt.”
It is fundamentally a better context-state architecture.

The prompt matters.
The thresholds matter.
The retries matter.
But the real leap is that compaction is treated as structured context reconstruction with explicit lifecycle, metadata, and strategy layering.

That is the level we should target if we are going to refactor HiJarvis compaction seriously.
