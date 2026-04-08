import type { Message } from "@mariozechner/pi-ai";
import {
  collectMinimalToolTail,
  collectUserMessages,
  estimateMessagesTokens,
  normalizeSummaryText,
} from "./assembly.js";
import { applyLightweightReduction } from "./lightweight.js";
import { applySnipReduction } from "./snip.js";
import { compactWithSummaryStrategy } from "./strategy-summary.js";
import type {
  CompactionBoundary,
  CompactionKind,
  CompactionResult,
  PartialCompactionDirection,
  CompactionRuntime,
  CompactionStageEvent,
  PartialCompactionResult,
} from "./types.js";

export const runCompactionPipeline = async (
  history: Message[],
  kind: CompactionKind,
  runtime: CompactionRuntime,
  signal?: AbortSignal,
): Promise<CompactionResult> => {
  const stages: CompactionStageEvent[] = [];

  const snip = applySnipReduction(history, runtime.model.contextWindow);
  stages.push({
    stage: "snip",
    applied: snip.applied,
    tokenEstimateBefore: snip.tokenEstimateBefore,
    tokenEstimateAfter: snip.tokenEstimateAfter,
    ...(snip.notes ? { notes: snip.notes } : {}),
  });

  const lightweight = applyLightweightReduction(snip.messages);
  stages.push({
    stage: "lightweight",
    applied: lightweight.applied,
    tokenEstimateBefore: lightweight.tokenEstimateBefore,
    tokenEstimateAfter: lightweight.tokenEstimateAfter,
    ...(lightweight.notes ? { notes: lightweight.notes } : {}),
  });

  const summaryResult = await compactWithSummaryStrategy(
    lightweight.messages,
    kind,
    runtime,
    "full",
    signal,
  );

  stages.push({
    stage: "summary",
    applied: normalizeSummaryText(summaryResult.summaryText) !== null,
    tokenEstimateBefore: estimateMessagesTokens(lightweight.messages),
    tokenEstimateAfter: estimateMessagesTokens(summaryResult.messages),
    ...(summaryResult.summaryError ? { notes: summaryResult.summaryError } : {}),
  });

  stages.push({
    stage: "assembly",
    applied: true,
    tokenEstimateBefore: estimateMessagesTokens(lightweight.messages),
    tokenEstimateAfter: estimateMessagesTokens(summaryResult.messages),
    notes: "assembled compacted payload for agent state",
  });

  const boundary = buildBoundary(kind, summaryResult.messages, history);

  return {
    ...summaryResult,
    stages,
    appliedStages: stages.filter((stage) => stage.applied).map((stage) => stage.stage),
    boundary,
  };
};

export const runPartialCompactionPipeline = async (
  history: import("@mariozechner/pi-ai").Message[],
  splitIndex: number,
  direction: PartialCompactionDirection,
  runtime: CompactionRuntime,
  signal?: AbortSignal,
): Promise<PartialCompactionResult> => {
  const stages: CompactionStageEvent[] = [];
  const clampedIndex = Math.max(0, Math.min(splitIndex, history.length));

  const segmentToCompact = direction === "from"
    ? history.slice(clampedIndex)
    : history.slice(0, clampedIndex);
  const preservedSegment = direction === "from"
    ? history.slice(0, clampedIndex)
    : history.slice(clampedIndex);

  const snip = applySnipReduction(segmentToCompact, runtime.model.contextWindow);
  stages.push({
    stage: "snip",
    applied: snip.applied,
    tokenEstimateBefore: snip.tokenEstimateBefore,
    tokenEstimateAfter: snip.tokenEstimateAfter,
    ...(snip.notes ? { notes: snip.notes } : {}),
  });

  const lightweight = applyLightweightReduction(snip.messages);
  stages.push({
    stage: "lightweight",
    applied: lightweight.applied,
    tokenEstimateBefore: lightweight.tokenEstimateBefore,
    tokenEstimateAfter: lightweight.tokenEstimateAfter,
    ...(lightweight.notes ? { notes: lightweight.notes } : {}),
  });

  const summaryResult = await compactWithSummaryStrategy(
    lightweight.messages,
    direction === "from" ? "post_turn" : "pre_turn",
    runtime,
    direction === "from" ? "partial_from" : "partial_up_to",
    signal,
  );

  const messages = direction === "from"
    ? [...preservedSegment, ...summaryResult.messages]
    : [...summaryResult.messages, ...preservedSegment];

  stages.push({
    stage: "summary",
    applied: normalizeSummaryText(summaryResult.summaryText) !== null,
    tokenEstimateBefore: estimateMessagesTokens(lightweight.messages),
    tokenEstimateAfter: estimateMessagesTokens(summaryResult.messages),
    ...(summaryResult.summaryError ? { notes: summaryResult.summaryError } : {}),
  });
  stages.push({
    stage: "assembly",
    applied: true,
    tokenEstimateBefore: estimateMessagesTokens(history),
    tokenEstimateAfter: estimateMessagesTokens(messages),
    notes: direction === "from"
      ? "preserved prefix and summarized suffix"
      : "summarized prefix and preserved suffix",
  });

  const boundary = buildBoundary(
    direction === "from" ? "post_turn" : "pre_turn",
    messages,
    history,
  );

  return {
    messages,
    summaryText: summaryResult.summaryText,
    summaryTokens: summaryResult.summaryTokens,
    direction,
    splitIndex: clampedIndex,
    stageCount: stages.length,
    stages,
    appliedStages: stages.filter((stage) => stage.applied).map((stage) => stage.stage),
    boundary,
    ...(summaryResult.summaryError ? { summaryError: summaryResult.summaryError } : {}),
  };
};

const buildBoundary = (
  kind: CompactionKind,
  compactedMessages: Message[],
  originalMessages: Message[],
): CompactionBoundary => {
  const summaryIncluded = compactedMessages.some((message) => {
    return message.role === "user" && typeof message.content === "string";
  });
  const preservedTailMessageCount =
    kind === "mid_turn"
      ? collectMinimalToolTail(originalMessages, Number.MAX_SAFE_INTEGER).tailMessages.length
      : 0;
  const preservedUserMessageCount = collectUserMessages(
    compactedMessages.filter((message) => message.role === "user"),
    Number.MAX_SAFE_INTEGER,
  ).length;

  return {
    kind,
    summaryIncluded,
    summaryMessageCount: summaryIncluded ? 1 : 0,
    preservedTailMessageCount,
    preservedUserMessageCount,
  };
};
