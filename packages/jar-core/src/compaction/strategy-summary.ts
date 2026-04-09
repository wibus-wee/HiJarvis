import type { Message } from "@mariozechner/pi-ai";

import {
  buildCompactedMessages,
  estimateMessagesTokens,
  estimateTextTokens,
  extractSummaryFromMessages,
  stripSummaryMessages,
} from "./assembly.js";
import { summarizeHistory } from "./summary.js";
import type { CompactionKind, CompactionRuntime, SummaryCompactionResult } from "./types.js";

export const compactWithSummaryStrategy = async (
  history: Message[],
  kind: CompactionKind,
  runtime: CompactionRuntime,
  promptVariant: import("./types.js").SummaryPromptVariant = "full",
  signal?: AbortSignal,
): Promise<SummaryCompactionResult> => {
  const systemPromptTokens = estimateTextTokens(runtime.systemPrompt);
  const strippedHistory = stripSummaryMessages(history);
  const existingSummary = extractSummaryFromMessages(history);
  let summaryText: string | null = existingSummary;
  let summaryError: string | undefined;
  let retryCount: number | undefined;

  if (!summaryText) {
    try {
      const generated = await summarizeHistory(
        strippedHistory,
        runtime,
        systemPromptTokens,
        promptVariant,
        signal,
      );
      summaryText = generated.summaryText;
      retryCount = generated.retryCount;
    } catch (error) {
      summaryError = error instanceof Error ? error.message : String(error);
      summaryText = "(summary unavailable)";
    }
  }

  const messages = buildCompactedMessages({
    kind,
    messages: strippedHistory,
    summaryText,
    settings: runtime.settings,
    contextWindow: runtime.model.contextWindow,
    systemPromptTokens,
  });

  const summaryTokens = summaryText ? estimateTextTokens(summaryText) : 0;
  runtime.logger?.info("session.compaction_applied", {
    contextWindow: runtime.model.contextWindow,
    triggerRatio: runtime.settings.triggerRatio,
    budgetRatio: runtime.settings.budgetRatio,
    summaryTokens,
    tokenEstimateBefore: estimateMessagesTokens(history),
    tokenEstimateAfter: estimateMessagesTokens(messages),
    summaryError,
  });

  return {
    messages,
    summaryText,
    summaryTokens,
    ...(summaryError ? { summaryError } : {}),
    ...(retryCount !== undefined ? { retryCount } : {}),
  };
};
