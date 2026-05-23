# Compaction Architecture

HiJarvis compaction is a small runtime context-reduction layer in `packages/jar-core/src/compaction`.

The current design intentionally favors one predictable path over multiple strategies. The system does not do partial compaction, boundary slicing, or artifact restoration anymore. It rewrites the current materialized message head into a smaller resumable payload and persists that payload as a lane checkpoint rather than as authoritative snapshot truth.

The main entry points are:

- `packages/jar-core/src/compaction/index.ts` - runtime-facing APIs such as `compactHistoryNow(...)` and `createCompactionTransform(...)`
- `packages/jar-core/src/compaction/pipeline.ts` - staged orchestration
- `packages/jar-core/src/compaction/summary.ts` - summary generation and retry logic

## High-Level Shape

Compaction settings live in `CompactionSettings` in `packages/jar-core/src/compaction/types.ts`.

The system supports these compaction kinds:

- `pre_turn`
- `mid_turn`
- `post_turn`

Runtime compaction events now carry only the fields needed for audit:

- `kind`
- before and after token estimates
- summary token count
- optional summary error
- stage count
- stage list
- applied stage names

## When Compaction Runs

There are three execution points.

### Pre-turn compaction

When the last message is a `user` message and the earlier history is already near threshold, HiJarvis compacts the earlier history first and then appends the pending user message unchanged.

### Mid-turn compaction

When the live history is already over threshold and there is no pending trailing user message, HiJarvis compacts the active history before the next model call.

### Post-turn compaction

After an assistant message completes successfully, the executor checks model-reported usage and may compact immediately after the turn finishes.

Two trigger styles are therefore used:

- estimate-based trigger inside `transformContext`
- usage-based trigger after a completed assistant response

## Staged Pipeline

The main orchestration lives in `packages/jar-core/src/compaction/pipeline.ts`.

The pipeline is explicitly staged and emits per-stage telemetry.

### Stages

- `snip`
  - implemented in `packages/jar-core/src/compaction/snip.ts`
  - drops oldest messages until the candidate segment falls below a coarse threshold

- `lightweight`
  - implemented in `packages/jar-core/src/compaction/lightweight.ts`
  - shortens oversized `toolResult` payloads to a capped preview

- `summary`
  - implemented through `compactWithSummaryStrategy(...)` in `packages/jar-core/src/compaction/strategy-summary.ts`
  - uses one summary prompt for every compaction shape

- `assembly`
  - records the final compacted payload that becomes the new agent state

### Pipeline Shape

```text
input history
    |
    v
+---------+
| snip    |
+---------+
    |
    v
+-------------+
| lightweight |
+-------------+
    |
    v
+---------+
| summary |
+---------+
    |
    v
+----------+
| assembly |
+----------+
    |
    v
final compacted messages
```

## Summary Strategy

The summary strategy lives in `packages/jar-core/src/compaction/strategy-summary.ts`.

It does the following:

- strips prior summary messages from input
- attempts to reuse an existing summary
- only calls the model if no summary already exists
- builds the final compacted payload with `buildCompactedMessages(...)`

If summarization throws, the strategy records `summaryError` and falls back to `(summary unavailable)`.

## Summary Prompt

Prompt text lives in `packages/jar-core/src/compaction/prompt.ts`.

There is now one prompt variant only. It asks the summarizer to preserve:

- current progress and decisions
- constraints and user preferences
- next steps
- critical examples, references, tool results, or active skill context that still matter

This keeps the prompt surface small and avoids split-specific prompt behavior.

## Final Payload Assembly

`buildCompactedMessages(...)` in `packages/jar-core/src/compaction/assembly.ts` is the core shape function.

It computes a budget from:

- `floor(contextWindow * budgetRatio) - systemPromptTokens`

It then assembles:

- optional summary message first
- selected user messages that still fit
- optional preserved tool tail for `mid_turn`

The compacted payload is intentionally asymmetric:

- summary = synthetic compressed memory
- raw user messages = selected anchor points
- raw tool tail = preserved only when actively relevant

## Summary Retry

HiJarvis has a compaction-local retry path in `packages/jar-core/src/compaction/summary.ts`.

How it works:

- up to `MAX_SUMMARY_RETRIES = 3`
- before each attempt, messages are trimmed to the available budget
- if summary still fails, the oldest 20 percent of the remaining messages are dropped
- `retryCount` is returned on success

## Runtime Integration

Compaction is wired into the agent through `createAgent(...)` in `packages/jar-core/src/runtime.ts`.

Flow:

- resolve provider and model
- build final system prompt
- construct `CompactionRuntime`
- build `compactContext = createCompactionTransform(...)`
- override `agent.transformContext`

Each prompt pass then does:

1. sanitize the current in-memory message history
2. apply compaction if needed

There is no extra boundary slicing step. The current message array is already the working set.

## Thread and Persistence Flow

Thread persistence now lives in the lane substrate under `packages/jar-core/src/lanes/`.

Important files:

- `tape.jsonl` - append-only lane facts and checkpoints
- `head.json` - optional derived materialized head cache
- `events.jsonl` - optional raw agent events and compaction events when `[sessions].record_events = true`
- `turns.jsonl`, `runs.jsonl`, `items.jsonl` - higher-level execution tracking

Recovery on the new path materializes the current lane view from tape plus the latest checkpoint. Any head file is derived cache only. The architecture target is that canonical truth lives in tape entries, not in a mutable snapshot file.

## Event Flow Through a Running Session

`packages/jar-core/src/execution/phase-subscribe.ts` is where compaction joins execution, persistence, and audit tracking.

Flow:

- open the current lane and materialize messages
- create agent with compaction integration
- start a tracker for turn/run/item records

During execution:

- every agent event is offered to the event log store; it appends to `events.jsonl` only when `[sessions].record_events = true`
- on `message_end`, the final assistant message is appended to the lane tape
- then `runPostTurnCompaction(...)` may compact the session history using usage-based policy

If `post_turn` compaction happens:

- `compactHistoryNow(..., "post_turn", ...)` returns compacted messages plus stage telemetry
- `agent.state.messages` is replaced
- the lane appends a checkpoint record that carries the new compacted head
- a compaction event is offered to the event log store and written to `events.jsonl` only when `[sessions].record_events = true`
- a structured compaction item is written into `items.jsonl`

## Developer Mental Model

The current system is best understood as:

- a context transform that can compact before prompting
- a post-turn cleanup pass that can compact using actual model usage
- a staged reducer that first prunes raw payloads, then summarizes
- a tape-backed lane model where compaction writes checkpoints and recovery materializes from tape
- an audit layer that records raw events and structured compaction items

## File Map

- public compaction entry points: `packages/jar-core/src/compaction/index.ts`
- core pipeline orchestration: `packages/jar-core/src/compaction/pipeline.ts`
- summary strategy: `packages/jar-core/src/compaction/strategy-summary.ts`
- summary generation and retry: `packages/jar-core/src/compaction/summary.ts`
- summary prompt: `packages/jar-core/src/compaction/prompt.ts`
- message assembly and token estimation: `packages/jar-core/src/compaction/assembly.ts`
- lightweight tool-result reduction: `packages/jar-core/src/compaction/lightweight.ts`
- oldest-message snip reduction: `packages/jar-core/src/compaction/snip.ts`
- usage-based compaction policy: `packages/jar-core/src/compaction/policy.ts`
- runtime integration: `packages/jar-core/src/runtime.ts`
- thread execution integration: `packages/jar-core/src/execution/phase-subscribe.ts`
- structured turn/run/item tracking: `packages/jar-core/src/thread-execution.ts`
- lane substrate and materialization: `packages/jar-core/src/lanes/`
