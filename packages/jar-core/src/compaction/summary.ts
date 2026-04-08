import { completeSimple, type Message } from "@mariozechner/pi-ai";

import { SUMMARY_PROMPT } from "./prompt.js";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  extractAssistantText,
  normalizeSummaryText,
} from "./assembly.js";
import type { CompactionRuntime, SummaryGenerationResult } from "./types.js";

export const summarizeHistory = async (
  messages: Message[],
  runtime: CompactionRuntime,
  systemPromptTokens: number,
  signal?: AbortSignal,
): Promise<SummaryGenerationResult> => {
  const contextWindow = runtime.model.contextWindow;
  const maxInputTokens = Math.max(
    1,
    Math.floor(contextWindow * 0.9) - systemPromptTokens,
  );
  const summaryPromptMessage: Message = {
    role: "user",
    content: SUMMARY_PROMPT,
    timestamp: Date.now(),
  };

  const summaryMessages = trimMessagesToBudget(
    messages,
    maxInputTokens,
    summaryPromptMessage,
  );

  const streamOptions = {
    maxTokens: runtime.settings.summaryMaxTokens,
    ...(runtime.apiKey ? { apiKey: runtime.apiKey } : {}),
    ...(signal ? { signal } : {}),
  };

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
  };
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
