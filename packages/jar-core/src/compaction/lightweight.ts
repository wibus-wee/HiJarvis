import type { Message } from "@mariozechner/pi-ai";

import {
  estimateMessagesTokens,
  estimateTextTokens,
  extractToolResultText,
} from "./assembly.js";
import type { LightweightReductionResult } from "./types.js";

const MAX_TOOL_RESULT_TOKENS = 512;

export const applyLightweightReduction = (
  messages: Message[],
): LightweightReductionResult => {
  const tokenEstimateBefore = estimateMessagesTokens(messages);
  let applied = false;

  const nextMessages = messages.map((message) => {
    if (message.role !== "toolResult") {
      return message;
    }

    const text = extractToolResultText(message);
    const tokens = estimateTextTokens(text);
    if (tokens <= MAX_TOOL_RESULT_TOKENS) {
      return message;
    }

    applied = true;
    return {
      ...message,
      content: [{
        type: "text" as const,
        text: summarizeToolResultText(text, tokens),
      }],
    };
  });

  const tokenEstimateAfter = estimateMessagesTokens(nextMessages);
  return {
    messages: nextMessages,
    tokenEstimateBefore,
    tokenEstimateAfter,
    applied,
    ...(applied
      ? { notes: `trimmed oversized tool results to <= ${MAX_TOOL_RESULT_TOKENS} tokens` }
      : {}),
  };
};

const summarizeToolResultText = (text: string, originalTokens: number): string => {
  const previewChars = Math.min(text.length, MAX_TOOL_RESULT_TOKENS * 4);
  const preview = text.slice(0, previewChars).trimEnd();
  return [
    `[tool result compacted: approx ${originalTokens} tokens before reduction]`,
    preview,
  ].join("\n");
};
