# HiJarvis vs Claude Code Compaction Gap Audit

This document captures the remaining differences between the current HiJarvis compaction system and the researched Claude Code compaction implementation.

Reference material:

- Claude Code research: `research/claude-code-compaction/README.md`
- Current HiJarvis implementation: `packages/jar-core/src/compaction/`

The focus here is on current-state gaps only.

## Bottom Line

HiJarvis has closed most of the original structural gaps inside its own current constraints.

It now has:

- staged compaction
- partial compaction
- PTL retry
- artifact restoration
- snapshot-backed boundary slicing
- structured persistence and telemetry

The remaining differences are mostly about runtime sophistication and state-model richness, not subsystem shape.

The largest remaining parity gaps are:

- active-query compaction and continuation
- autocompact operational wrapper with failure memory
- alternate session-memory and collapse strategies
- richer post-compact state channels such as hooks and attachments

## Major Gaps

### 1. No in-request compaction continuation

Claude Code can compact inside the active query and continue the same request with the rebuilt payload:

- `claude-code-source/query.ts:453`
- `claude-code-source/query.ts:470`
- `claude-code-source/query.ts:534`

HiJarvis still compacts only:

- before a request through `transformContext` in `packages/jar-core/src/runtime.ts:76`
- or after a completed turn in `packages/jar-core/src/session-executor.ts:170`

It never detects prompt-too-long mid-flight and resumes the same turn with compacted state.

### 2. No autocompact wrapper with operational state

Claude Code wraps full compaction in `claude-code-source/services/compact/autoCompact.ts:241`, including:

- failure circuit breaking
- recompaction metadata
- alternate path selection

HiJarvis only has threshold checks in `packages/jar-core/src/compaction/policy.ts:12` and direct pipeline invocation in `packages/jar-core/src/compaction/index.ts:42` and `packages/jar-core/src/session-executor.ts:187`.

It does not track:

- consecutive failures
- same-chain recompactions
- suppression of repeated doomed attempts

### 3. No session-memory compaction path

Claude Code tries session-memory compaction before legacy full summarization:

- `claude-code-source/services/compact/autoCompact.ts:287`
- `claude-code-source/services/compact/sessionMemoryCompact.ts`

HiJarvis has no equivalent alternate strategy under `packages/jar-core/src/compaction/`.

Built-in strategies today are only:

- full summary pipeline
- partial summary pipeline

See `packages/jar-core/src/compaction/pipeline.ts:22` and `packages/jar-core/src/compaction/pipeline.ts:113`.

### 4. No context-collapse subsystem

Claude Code explicitly coordinates:

- snip
- microcompact
- context collapse
- autocompact
- reactive compact

See:

- `claude-code-source/query.ts:396`
- `claude-code-source/query.ts:428`
- `claude-code-source/services/compact/autoCompact.ts:201`

HiJarvis has a single compaction subsystem plus prompt-context sanitization in `packages/jar-core/src/runtime.ts:78`.

There is no second context-management subsystem with ownership and suppression rules.

### 5. Post-compact payload is still less expressive

Claude Code’s canonical result includes:

- boundary marker
- summary messages
- attachments
- hook results
- optional preserved messages
- display text
- token and usage telemetry

See:

- `claude-code-source/services/compact/compact.ts:299`
- `claude-code-source/services/compact/compact.ts:330`

HiJarvis returns:

- compacted messages
- metadata/events
- restored artifact messages

See `packages/jar-core/src/compaction/types.ts:92` and `packages/jar-core/src/compaction/pipeline.ts:102`.

That is much stronger than before, but still less expressive than Claude Code’s attachment/hook/display model.

## Moderate Gaps

### 6. Boundary semantics are still weaker than a transcript-level boundary message

Claude Code inserts a real compact-boundary message and uses it as an execution seam:

- `claude-code-source/services/compact/compact.ts:598`
- `claude-code-source/query.ts:365`

HiJarvis stores boundary metadata in snapshots only:

- `packages/jar-core/src/session-store.ts:7`
- `packages/jar-core/src/compaction/boundary.ts:21`

That works well, but it is still less semantically rich than a first-class transcript message.

### 7. No preserved-segment relinking metadata

Claude Code boundaries carry preserved segment metadata and discovered tool state:

- `claude-code-source/services/compact/compact.ts:349`
- `claude-code-source/services/compact/compact.ts:603`

HiJarvis boundary records only kind and coarse counts:

- `packages/jar-core/src/compaction/types.ts:45`
- `packages/jar-core/src/compaction/pipeline.ts:230`

### 8. Partial compaction is simpler

Claude Code partial compaction handles more transcript invariants around preserved ranges, tool pairings, and streaming segments.

HiJarvis partial compaction is currently heuristic and array-slice based in `packages/jar-core/src/compaction/pipeline.ts:113`.

It works, but it does not maintain transcript-invariant handling at Claude Code depth.

### 9. Prompt strategy is still lighter

Claude Code compaction prompts include:

- explicit no-tools instructions
- `<analysis>` plus `<summary>` formatting
- highly structured sections
- strong continuity instructions

See:

- `claude-code-source/services/compact/prompt.ts:19`
- `claude-code-source/services/compact/prompt.ts:61`
- `claude-code-source/services/compact/prompt.ts:145`

HiJarvis has prompt variants in `packages/jar-core/src/compaction/prompt.ts`, but they remain much lighter.

### 10. PTL retry is less precise

Claude Code retries only on explicit prompt-too-long behavior and truncates grouped API rounds.

HiJarvis retries summary generation generically and drops the oldest 20 percent of remaining messages in `packages/jar-core/src/compaction/summary.ts:46` and `packages/jar-core/src/compaction/summary.ts:93`.

That is simpler and useful, but less targeted.

### 11. Lightweight reduction is narrower

Claude Code has:

- tool-result budgeting
- microcompact
- cache-aware and time-aware reductions

HiJarvis currently has:

- `snip` in `packages/jar-core/src/compaction/snip.ts:7`
- oversized tool-result truncation in `packages/jar-core/src/compaction/lightweight.ts:12`

This is a real staged system, but still a narrower one.

### 12. Policy remains simple

Claude Code computes:

- warning state
- error state
- autocompact threshold
- blocking state

See `claude-code-source/services/compact/autoCompact.ts:93`.

HiJarvis policy still returns only:

- `shouldCompact`
- `triggerTokens`
- `inputTokens`
- simple reason

See `packages/jar-core/src/compaction/policy.ts:12`.

## Minor Gaps

### 13. Artifact restoration is still minimal

Claude Code restores a broad set of structured attachments and hook outputs.

HiJarvis currently restores only:

- last tool result as `tool_state`
- recent skills as `skill_state`

See `packages/jar-core/src/compaction/artifacts.ts:6`.

### 14. No compact hook lifecycle

Claude Code has:

- pre-compact hooks
- session-start hooks after compaction
- post-compact hooks

HiJarvis has no compaction-specific hook lifecycle under `packages/jar-core/src/compaction/`.

### 15. No user-facing compacting status channel

Claude Code exposes compacting state and optional user display text.

HiJarvis records compaction events and tracker items, but has no explicit “currently compacting” UI/runtime status channel.

### 16. No manual `/compact` entry point

Claude Code has a dedicated manual compact command.

HiJarvis exposes programmatic entry points like:

- `compactHistoryNow(...)`
- `partialCompactHistoryNow(...)`

but no user-facing command path in apps.

### 17. Telemetry depth is lower

Claude Code logs detailed compaction analytics, usage, cache effects, and retrigger prediction.

HiJarvis records stage events, strategy, boundary, and artifacts, but it still does not capture:

- compaction API usage
- cache token effects
- retrigger prediction
- chain-level analytics

## Summary

HiJarvis has already closed most of the original architectural gaps inside current repository constraints.

What remains is mostly:

- richer runtime sophistication
- richer operational policy
- richer post-compact state channels

The highest-value remaining parity items are:

1. active-query compaction continuation
2. autocompact wrapper with failure memory
3. session-memory and collapse-style alternate strategies
4. richer attachment/hook/display channels after compaction
