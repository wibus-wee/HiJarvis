import { completeSimple, type Message } from "@mariozechner/pi-ai";

import { getSummaryPrompt } from "./prompt.js";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  extractAssistantText,
  normalizeSummaryText,
} from "./assembly.js";
import type {
  CompactionRuntime,
  SummaryGenerationResult,
  SummaryPromptVariant,
} from "./types.js";

const MAX_SUMMARY_RETRIES = 3;

export const summarizeHistory = async (
  messages: Message[],
  runtime: CompactionRuntime,
  systemPromptTokens: number,
  variant: SummaryPromptVariant = "full",
  signal?: AbortSignal,
): Promise<SummaryGenerationResult> => {
  const contextWindow = runtime.model.contextWindow;
  const maxInputTokens = Math.max(
    1,
    Math.floor(contextWindow * 0.9) - systemPromptTokens,
  );
  const summaryPromptMessage: Message = {
    role: "user",
    content: getSummaryPrompt(variant),
    timestamp: Date.now(),
  };

  const streamOptions = {
    maxTokens: runtime.settings.summaryMaxTokens,
    ...(runtime.apiKey ? { apiKey: runtime.apiKey } : {}),
    ...(signal ? { signal } : {}),
  };

  let attempt = 0;
  let workingMessages = messages;
  let lastError: unknown;

  while (attempt < MAX_SUMMARY_RETRIES) {
    const summaryMessages = trimMessagesToBudget(
      workingMessages,
      maxInputTokens,
      summaryPromptMessage,
    );

    try {
      const summaryResponse = await completeSimple(
        runtime.model,
        {
          systemPrompt: runtime.systemPrompt,
          messages: summaryMessages,
        },
        streamOptions,
      );

      const text = extractAssistantText(summaryResponse);
      const summaryText = normalizeSummaryText(text) ?? "(summary unavailable)";
      return {
        summaryText,
        summaryTokens: estimateMessageTokens({
          role: "user",
          content: summaryText,
          timestamp: Date.now(),
        }),
        retryCount: attempt,
      };
    } catch (error) {
      lastError = error;
      if (workingMessages.length <= 1) {
        break;
      }
      workingMessages = truncateForRetry(workingMessages);
      attempt += 1;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

export const trimMessagesToBudget = (
  messages: Message[],
  budgetTokens: number,
  suffix: Message,
): Message[] => {
  const history = [...messages];
  const suffixTokens = estimateMessageTokens(suffix);
  const remaining = Math.max(0, budgetTokens - suffixTokens);

  while (history.length > 0) {
    const tokens = estimateMessagesTokens(history);
    if (tokens <= remaining) {
      break;
    }
    history.shift();
  }

  return [...history, suffix];
};

export const truncateForRetry = (messages: Message[]): Message[] => {
  if (messages.length <= 1) {
    return messages;
  }
  const dropCount = Math.max(1, Math.floor(messages.length * 0.2));
  return messages.slice(dropCount);
};
