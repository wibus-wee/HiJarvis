import type { Message } from "@mariozechner/pi-ai";
import {
  collectMinimalToolTail,
  collectUserMessages,
  estimateMessagesTokens,
  normalizeSummaryText,
} from "./assembly.js";
import { extractCompactionArtifacts, renderArtifactMessages } from "./artifacts.js";
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
  SummaryCompactionResult,
} from "./types.js";

export const runCompactionPipeline = async (
  history: Message[],
  kind: CompactionKind,
  runtime: CompactionRuntime,
  signal?: AbortSignal,
): Promise<CompactionResult> => {
  const partialPlan = choosePartialPlan(history, runtime.model.contextWindow);
  if (partialPlan) {
    const partial = await runPartialCompactionPipeline(
      history,
      partialPlan.splitIndex,
      partialPlan.direction,
      runtime,
      signal,
    );
    return {
      messages: partial.messages,
      summaryText: partial.summaryText,
      summaryTokens: partial.summaryTokens,
      stages: partial.stages,
      appliedStages: partial.appliedStages,
      boundary: partial.boundary,
      strategy: "partial",
      partialDirection: partial.direction,
      partialSplitIndex: partial.splitIndex,
      artifacts: partial.artifacts,
      ...(partial.summaryError ? { summaryError: partial.summaryError } : {}),
    };
  }

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

  const summaryResult: SummaryCompactionResult = await compactWithSummaryStrategy(
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
  const artifacts = extractCompactionArtifacts(history, runtime);
  const messagesWithArtifacts = [
    ...summaryResult.messages,
    ...renderArtifactMessages(artifacts),
  ];

  return {
    ...summaryResult,
    messages: messagesWithArtifacts,
    stages,
    appliedStages: stages.filter((stage) => stage.applied).map((stage) => stage.stage),
    boundary,
    strategy: "full",
    artifacts,
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

  const summaryResult: SummaryCompactionResult = await compactWithSummaryStrategy(
    lightweight.messages,
    direction === "from" ? "post_turn" : "pre_turn",
    runtime,
    direction === "from" ? "partial_from" : "partial_up_to",
    signal,
  );

  const messages = direction === "from"
    ? [...preservedSegment, ...summaryResult.messages]
    : [...summaryResult.messages, ...preservedSegment];
  const artifacts = extractCompactionArtifacts(history, runtime);
  const restoredMessages = [
    ...messages,
    ...renderArtifactMessages(artifacts),
  ];

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
    tokenEstimateAfter: estimateMessagesTokens(restoredMessages),
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
    messages: restoredMessages,
    summaryText: summaryResult.summaryText,
    summaryTokens: summaryResult.summaryTokens,
    direction,
    splitIndex: clampedIndex,
    stageCount: stages.length,
    stages,
    appliedStages: stages.filter((stage) => stage.applied).map((stage) => stage.stage),
    boundary,
    artifacts,
    ...(summaryResult.retryCount !== undefined ? { retryCount: summaryResult.retryCount } : {}),
    ...(summaryResult.summaryError ? { summaryError: summaryResult.summaryError } : {}),
  };
};

export const choosePartialPlan = (
  history: Message[],
  contextWindow: number,
): { direction: PartialCompactionDirection; splitIndex: number } | null => {
  if (history.length < 8) {
    return null;
  }

  const totalTokens = estimateMessagesTokens(history);
  if (totalTokens < Math.floor(contextWindow * 0.8)) {
    return null;
  }

  const keepTailCount = Math.max(3, Math.floor(history.length * 0.3));
  const splitIndex = Math.max(1, history.length - keepTailCount);
  if (splitIndex >= history.length) {
    return null;
  }

  return {
    direction: "up_to",
    splitIndex,
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
