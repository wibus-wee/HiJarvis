import type { Message } from "@mariozechner/pi-ai";
import {
  estimateMessagesTokens,
  normalizeSummaryText,
} from "./assembly.js";
import { applyLightweightReduction } from "./lightweight.js";
import { applySnipReduction } from "./snip.js";
import { compactWithSummaryStrategy } from "./strategy-summary.js";
import type {
  CompactionKind,
  CompactionResult,
  CompactionRuntime,
  CompactionStageEvent,
  SummaryCompactionResult,
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
    notes: snip.notes,
  });

  const lightweight = applyLightweightReduction(snip.messages);
  stages.push({
    stage: "lightweight",
    applied: lightweight.applied,
    tokenEstimateBefore: lightweight.tokenEstimateBefore,
    tokenEstimateAfter: lightweight.tokenEstimateAfter,
    notes: lightweight.notes,
  });

  const summaryResult: SummaryCompactionResult = await compactWithSummaryStrategy(
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
    notes: summaryResult.summaryError,
  });

  stages.push({
    stage: "assembly",
    applied: true,
    tokenEstimateBefore: estimateMessagesTokens(lightweight.messages),
    tokenEstimateAfter: estimateMessagesTokens(summaryResult.messages),
    notes: "assembled compacted payload for agent state",
  });

  return {
    ...summaryResult,
    stages,
    appliedStages: stages.filter((stage) => stage.applied).map((stage) => stage.stage),
  };
};
