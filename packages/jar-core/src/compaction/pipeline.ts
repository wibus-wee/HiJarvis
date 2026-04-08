import {
  collectMinimalToolTail,
  collectUserMessages,
  estimateMessagesTokens,
  normalizeSummaryText,
} from "./assembly.js";
import { applyLightweightReduction } from "./lightweight.js";
import { compactWithSummaryStrategy } from "./strategy-summary.js";
import type {
  CompactionBoundary,
  CompactionKind,
  CompactionResult,
  CompactionRuntime,
  CompactionStageEvent,
} from "./types.js";

export const runCompactionPipeline = async (
  history: import("@mariozechner/pi-ai").Message[],
  kind: CompactionKind,
  runtime: CompactionRuntime,
  signal?: AbortSignal,
): Promise<CompactionResult> => {
  const stages: CompactionStageEvent[] = [];

  const lightweight = applyLightweightReduction(history);
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

const buildBoundary = (
  kind: CompactionKind,
  compactedMessages: import("@mariozechner/pi-ai").Message[],
  originalMessages: import("@mariozechner/pi-ai").Message[],
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
