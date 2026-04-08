# Compaction Architecture

HiJarvis compaction is a runtime context-reduction layer in `packages/jar-core/src/compaction` that rewrites the in-memory message history into a smaller, resumable form while preserving enough state for the next model call to continue coherently.

The implementation is not just "summarize old messages". It combines boundary-aware history slicing, a staged reduction pipeline, optional automatic partial compaction, summary-prompt variants, artifact restoration, and session persistence hooks.

The main entry points are:

- `packages/jar-core/src/compaction/index.ts:42` - `compactHistoryNow(...)`
- `packages/jar-core/src/compaction/index.ts:167` - `partialCompactHistoryNow(...)`
- `packages/jar-core/src/compaction/index.ts:92` - `createCompactionTransform(...)`

## High-Level Shape

Compaction settings live in `CompactionSettings` in `packages/jar-core/src/compaction/types.ts:6`.

The system currently supports these compaction kinds:

- `pre_turn`
- `mid_turn`
- `post_turn`

See `packages/jar-core/src/compaction/types.ts:13`.

Runtime compaction reports a rich event payload that can include:

- strategy
- partial metadata
- stage telemetry
- artifacts
- logical boundary data

See `packages/jar-core/src/compaction/types.ts:15`.

Default settings are defined in `packages/jar-core/src/compaction/index.ts:35`:

- `triggerRatio: 0.9`
- `budgetRatio: 0.9`
- `summaryMaxTokens: 1024`

### System Map

```text
                         HiJarvis Compaction System

    runtime.ts                compaction/                    session-store.ts
        |                         |                                 |
        | transformContext        |                                 |
        v                         v                                 v
  +-------------+         +------------------+             +------------------+
  | boundary    | ----->  | pipeline         | ----->      | session.json     |
  | slicing     |         | snip             |             | compactionBoundary|
  +-------------+         | lightweight      |             +------------------+
        |                 | summary          |
        v                 | assembly         |                    events/items
  +-------------+         +------------------+                        |
  | prompt      |                  |                                  v
  | sanitizing  |                  v                          +----------------+
  +-------------+         +------------------+                | compaction     |
        |                 | compacted        |                | audit trail    |
        v                 | messages         |                +----------------+
  +-------------+         | restored         |
  | model call   |        | artifacts        |
  +-------------+         +------------------+
```

## When Compaction Runs

There are three practical execution points.

### Pre-turn compaction

In `packages/jar-core/src/compaction/index.ts:109`, when the last message is a `user` message and the earlier history is already near threshold, HiJarvis compacts the earlier history first and then appends the pending user message unchanged.

### Mid-turn compaction

In `packages/jar-core/src/compaction/index.ts:139`, when the live history is already over threshold and there is no pending trailing user message, HiJarvis compacts the active history before the next model call.

### Post-turn compaction

In `packages/jar-core/src/session-executor.ts:170`, after an assistant message completes successfully, the executor checks model-reported usage and may compact immediately after the turn finishes.

Two trigger styles are therefore used:

- estimate-based trigger inside `transformContext`
- usage-based trigger after a completed assistant response

Usage-based checks come from `packages/jar-core/src/compaction/policy.ts:5` and are used in `packages/jar-core/src/session-executor.ts:183`.

## Snapshot-Backed Boundary

The current architecture relies on a persisted compaction boundary so future runs do not repeatedly reprocess already-compacted history.

### Boundary creation

`createSnapshotBoundary(kind, messages)` in `packages/jar-core/src/compaction/boundary.ts:8` records:

- compaction kind
- last message index in the compacted snapshot
- summary message index if one exists
- timestamp

### Boundary use

`getMessagesAfterBoundary(messages, boundary)` in `packages/jar-core/src/compaction/boundary.ts:21` slices the recovered message array from `summaryMessageIndex` if present, otherwise from `messageIndex`.

`createAgent(...)` applies this boundary before prompt-context sanitization or fresh compaction in `packages/jar-core/src/runtime.ts:76`.

### Boundary persistence

The session snapshot format includes `compactionBoundary` in `packages/jar-core/src/session-store.ts:49`.

`openSession(...)` restores that boundary and exposes it on `SessionHandle` in `packages/jar-core/src/session-store.ts:206` and `packages/jar-core/src/session-store.ts:411`.

After `post_turn` compaction, the executor writes both compacted messages and the new boundary back into the snapshot in `packages/jar-core/src/session-executor.ts:194`.

### Operational meaning

- `messages.jsonl` remains the append-only audit log of final messages
- `session.json` is the fast-path current state containing compacted messages and boundary
- on reload, the runtime only resumes from the current compacted era instead of replaying all historical summarized state

### Boundary and Snapshot Model

```text
Before compaction:

  messages.jsonl
  ---------------------------------------------------------->
  [m0][m1][m2][m3][m4][m5][m6][m7]

After compaction snapshot:

  session.json
  messages = [summary][kept-user][kept-user][artifact][artifact]
              ^
              |
              summaryMessageIndex = 0

  compactionBoundary = {
    kind: post_turn,
    messageIndex: 4,
    summaryMessageIndex: 0,
    recordedAt: ...
  }

On next runtime load:

  full snapshot messages
      |
      v
  getMessagesAfterBoundary(...)
      |
      v
  active compacted era only
```

## Staged Pipeline

The main orchestration lives in `packages/jar-core/src/compaction/pipeline.ts:22`.

The pipeline is explicitly staged and emits per-stage telemetry.

### Stages

- `snip`
  - implemented in `packages/jar-core/src/compaction/snip.ts:7`
  - drops oldest messages until the candidate segment falls below about 75 percent of the model context window

- `lightweight`
  - implemented in `packages/jar-core/src/compaction/lightweight.ts:12`
  - shortens oversized `toolResult` payloads to a capped preview

- `summary`
  - implemented through `compactWithSummaryStrategy(...)` in `packages/jar-core/src/compaction/strategy-summary.ts:13`

- `assembly`
  - recorded in `packages/jar-core/src/compaction/pipeline.ts:87`
  - represents the final compacted payload that becomes the new agent state

### Stage telemetry

Each stage records:

- `applied`
- token estimate before
- token estimate after
- optional notes

See `packages/jar-core/src/compaction/types.ts:37`.

This matters because summary is not the only reduction mechanism. Cheap structural reductions happen first, and the summarizer often receives a smaller input as a result.

### Pipeline Shape

```text
input history
    |
    v
+---------+
| snip    |  drop oldest messages if way over budget
+---------+
    |
    v
+-------------+
| lightweight |  shrink oversized toolResult blocks
+-------------+
    |
    v
+------------------------------+
| strategy selection           |
| - full summary              |
| - or automatic partial      |
+------------------------------+
    |
    v
+---------+
| summary |  call model / reuse summary / retry if needed
+---------+
    |
    v
+----------+
| assembly |  build compacted payload
+----------+
    |
    v
+------------------+
| artifact restore |  append tool_state / skill_state
+------------------+
    |
    v
final compacted messages
```

## Full Summary Strategy

The summary strategy lives in `packages/jar-core/src/compaction/strategy-summary.ts:13`.

It does the following:

- strips prior summary messages from input with `stripSummaryMessages(...)` in `packages/jar-core/src/compaction/assembly.ts:41`
- attempts to reuse an existing summary with `extractSummaryFromMessages(...)` in `packages/jar-core/src/compaction/assembly.ts:44`
- only calls the model if no summary already exists
- builds the final compacted payload with `buildCompactedMessages(...)` in `packages/jar-core/src/compaction/assembly.ts:8`

If summarization throws, the strategy records `summaryError` and falls back to `(summary unavailable)` in `packages/jar-core/src/compaction/strategy-summary.ts:36`.

## How the Final Compacted Message Array Is Built

`buildCompactedMessages(...)` in `packages/jar-core/src/compaction/assembly.ts:8` is the core shape function.

It computes a budget as:

- `floor(contextWindow * budgetRatio) - systemPromptTokens`

See `packages/jar-core/src/compaction/assembly.ts:14`.

It then assembles:

- optional summary message first
- selected user messages that still fit
- optional preserved tool tail for `mid_turn`

Important details:

- the summary is materialized as a synthetic `user` message prefixed with `SUMMARY_PREFIX` in `packages/jar-core/src/compaction/assembly.ts:125` and `packages/jar-core/src/compaction/prompt.ts:11`
- otherwise only user messages are preserved raw via `collectUserMessages(...)` in `packages/jar-core/src/compaction/assembly.ts:155`
- `mid_turn` compaction can preserve a minimal trailing tool interaction chain via `collectMinimalToolTail(...)` in `packages/jar-core/src/compaction/assembly.ts:195`

So the compacted payload is intentionally asymmetric:

- summary = synthetic compressed memory
- raw user messages = selected anchor points
- raw tool tail = preserved only when actively relevant

### Final Payload Shape

```text
compacted payload

  [0] summary message
  [1] kept user message
  [2] kept user message
  [3] preserved assistant tool-call tail (mid_turn only, optional)
  [4] preserved toolResult tail      (mid_turn only, optional)
  [5] restored artifact: tool_state  (optional)
  [6] restored artifact: skill_state (optional)
```

## Automatic Partial Compaction

The pipeline can automatically switch from full compaction to partial compaction using `choosePartialPlan(...)` in `packages/jar-core/src/compaction/pipeline.ts:205`.

Current heuristic:

- require at least 8 messages
- require estimated history tokens >= 80 percent of context window
- preserve the newest roughly 30 percent of messages, with at least 3 messages
- summarize the older prefix instead of compacting everything
- current auto-selected direction is always `up_to`

The result is a plan of the form:

- `{ direction: "up_to", splitIndex }`

This means the current built-in preference is:

- summarize older history
- keep the newest tail raw

### Automatic Partial Strategy

```text
full history

  [older.......................][newer tail]
   ^                            ^
   |                            |
   summarized prefix            preserved raw segment

current auto choice:

  direction = up_to
  splitIndex = history.length - keepTailCount

result:

  [summary of older prefix][preserved newer tail][restored artifacts]
```

### Manual partial API

`partialCompactHistoryNow(...)` still exists in `packages/jar-core/src/compaction/index.ts:167`, but partial compaction is no longer only a manual capability. The main pipeline can select it automatically.

## Partial Pipeline Behavior

`runPartialCompactionPipeline(...)` in `packages/jar-core/src/compaction/pipeline.ts:113` splits history into:

- `segmentToCompact`
- `preservedSegment`

based on direction:

- `from` => compact suffix, preserve prefix
- `up_to` => compact prefix, preserve suffix

It then runs the same reduction steps on only the compacted segment:

- `snip`
- `lightweight`
- `summary`

Finally it reassembles:

- `from` => `[preservedPrefix, summarizedSuffix]`
- `up_to` => `[summarizedPrefix, preservedSuffix]`

See `packages/jar-core/src/compaction/pipeline.ts:123`, `packages/jar-core/src/compaction/pipeline.ts:148`, and `packages/jar-core/src/compaction/pipeline.ts:156`.

## Summary Prompt Variants

Prompt variants are defined in `packages/jar-core/src/compaction/prompt.ts` and selected through `getSummaryPrompt(...)` in `packages/jar-core/src/compaction/prompt.ts:41`.

Variants:

- `full`
- `partial_from`
- `partial_up_to`

Selection:

- full compaction => `full`
- partial `from` => `partial_from`
- partial `up_to` => `partial_up_to`

See `packages/jar-core/src/compaction/pipeline.ts:71` and `packages/jar-core/src/compaction/pipeline.ts:148`.

This keeps the summarizer aware of whether it is summarizing:

- an entire recoverable history
- only one side of a preserved split

## PTL Retry Behavior

HiJarvis now has a compaction-local retry path in `packages/jar-core/src/compaction/summary.ts:16`.

How it works:

- up to `MAX_SUMMARY_RETRIES = 3`
- before each attempt, messages are trimmed with `trimMessagesToBudget(...)` in `packages/jar-core/src/compaction/summary.ts:79`
- if summary still fails, the oldest 20 percent of the remaining messages are dropped via `truncateForRetry(...)` in `packages/jar-core/src/compaction/summary.ts:93`
- `retryCount` is returned on success

This is the current compaction-level resilience path for overlong or failing summary requests.

## Restored Artifacts

Compaction now restores a minimal amount of structured state after summarization so the next model can resume with some non-conversational context.

Artifact extraction is implemented in `packages/jar-core/src/compaction/artifacts.ts:6`.

Currently restored artifacts:

- last `toolResult`, as `tool_state`
- recently injected skills, as `skill_state`

Artifact restoration is rendered by `renderArtifactMessages(...)` in `packages/jar-core/src/compaction/artifacts.ts:35`.

These are converted into synthetic `user` messages beginning with:

- `Structured restoration state from the previous compaction:`

Where they are injected:

- full compaction appends artifact messages after the summary-assembled payload in `packages/jar-core/src/compaction/pipeline.ts:97`
- partial compaction appends artifact messages after the recombined payload in `packages/jar-core/src/compaction/pipeline.ts:159`

This keeps restored artifacts structurally separate from the summary itself.

## Boundary Metadata in Events

In addition to persisted snapshot boundary state, compaction emits a logical boundary summary in the event payload using `CompactionBoundary` from `packages/jar-core/src/compaction/types.ts:45`.

`buildBoundary(...)` in `packages/jar-core/src/compaction/pipeline.ts:230` reports:

- `kind`
- whether a summary is included
- summary message count
- preserved tail message count
- preserved user message count

This is best understood as operational metadata, not the authoritative snapshot boundary itself.

## Runtime Integration

Compaction is wired into the agent through `createAgent(...)` in `packages/jar-core/src/runtime.ts:35`.

Flow:

- resolve provider/model
- build final system prompt
- construct `CompactionRuntime`
- build `compactContext = createCompactionTransform(...)`
- override `agent.transformContext`

Each prompt pass then does:

1. slice history after the persisted snapshot boundary
2. strip prompt-context entries excluded from memory
3. apply compaction if needed

See `packages/jar-core/src/runtime.ts:69` to `packages/jar-core/src/runtime.ts:82`.

When compaction fires inside `transformContext`, `onCompaction` writes compacted messages back to `agent.state.messages` and emits the event sink.

## Session and Persistence Flow

Session persistence is implemented in `packages/jar-core/src/session-store.ts`.

Important files:

- `messages.jsonl` - append-only final messages
- `events.jsonl` - agent events and compaction events
- `session.json` - current snapshot, compacted messages, and `compactionBoundary`
- `turns.jsonl`, `runs.jsonl`, `items.jsonl` - higher-level execution tracking

Recovery:

- `openSession(...)` loads the snapshot first
- then replays only transcript messages with `sequence > lastSequence`

See `packages/jar-core/src/session-store.ts:282` to `packages/jar-core/src/session-store.ts:297`.

This means compacted snapshot state is authoritative, while transcript replay fills in anything written after the snapshot.

## Event Flow Through a Running Session

`executePromptInSession(...)` in `packages/jar-core/src/session-executor.ts:77` is where compaction joins execution, persistence, and audit tracking.

Flow:

- open session and restore messages + boundary
- create agent with boundary-aware compaction integration
- start a tracker for turn/run/item records

During execution:

- every agent event is appended to `events.jsonl`
- on `message_end`, the final assistant message is appended to `messages.jsonl`
- then `runPostTurnCompaction(...)` may compact the session history using usage-based policy

If `post_turn` compaction happens:

- `compactHistoryNow(..., "post_turn", ...)` returns compacted messages + telemetry
- `agent.state.messages` is replaced
- a new snapshot boundary is created
- `session.writeSnapshot(...)` persists both compacted messages and boundary
- a compaction event is appended to `events.jsonl`
- a structured compaction item is written into `items.jsonl`

See `packages/jar-core/src/session-executor.ts:170` to `packages/jar-core/src/session-executor.ts:224`.

### Post-Turn Flow

```text
assistant message_end
      |
      v
check usage-based threshold
      |
      +---- no ----> keep history unchanged
      |
      +---- yes ---> compactHistoryNow(..., post_turn)
                        |
                        v
                  staged compaction pipeline
                        |
                        v
                  agent.state.messages = compacted messages
                        |
                        v
                  createSnapshotBoundary(...)
                        |
                        v
                  write session.json snapshot
                        |
                        v
                  append compaction event
                        |
                        v
                  append compaction tracker item
```

## Structured Audit Trail

`recordCompaction(...)` in `packages/jar-core/src/session-execution.ts:214` writes an `item.type = "compaction"` entry containing:

- kind
- before/after token estimates
- summary token count
- summary error if any
- strategy
- partial metadata
- artifacts
- stage count
- stage list
- applied stages
- boundary info

This is the best developer-facing per-turn compaction audit trail, while `events.jsonl` remains the lower-level stream.

## Developer Mental Model

The current system is best understood as:

- a boundary-aware context transform that can compact before prompting
- a post-turn cleanup pass that can compact using actual model usage
- a staged reducer that first prunes raw payloads, then summarizes
- an auto-partial heuristic that currently prefers summarizing older history while preserving the newest tail
- a resumability layer that persists both compacted state and boundary into session snapshots
- a restoration layer that re-injects limited tool/skill state as synthetic user messages
- an audit layer that records raw events and structured compaction items

## File Map

- public compaction entry points: `packages/jar-core/src/compaction/index.ts`
- core pipeline orchestration: `packages/jar-core/src/compaction/pipeline.ts`
- summary strategy: `packages/jar-core/src/compaction/strategy-summary.ts`
- summary generation and retry: `packages/jar-core/src/compaction/summary.ts`
- summary prompt variants: `packages/jar-core/src/compaction/prompt.ts`
- message assembly and token estimation: `packages/jar-core/src/compaction/assembly.ts`
- snapshot boundary logic: `packages/jar-core/src/compaction/boundary.ts`
- artifact extraction/restoration: `packages/jar-core/src/compaction/artifacts.ts`
- lightweight tool-result reduction: `packages/jar-core/src/compaction/lightweight.ts`
- oldest-message snip reduction: `packages/jar-core/src/compaction/snip.ts`
- usage-based compaction policy: `packages/jar-core/src/compaction/policy.ts`
- runtime integration: `packages/jar-core/src/runtime.ts`
- session execution integration: `packages/jar-core/src/session-executor.ts`
- structured turn/run/item tracking: `packages/jar-core/src/session-execution.ts`
- session persistence and snapshot format: `packages/jar-core/src/session-store.ts`
