import type { Message } from "@mariozechner/pi-ai";

import { estimateMessagesTokens } from "./assembly.js";

const SNIP_TARGET_RATIO = 0.75;

export const applySnipReduction = (
  messages: Message[],
  contextWindow: number,
): { messages: Message[]; applied: boolean; tokenEstimateBefore: number; tokenEstimateAfter: number; notes?: string } => {
  const tokenEstimateBefore = estimateMessagesTokens(messages);
  const targetTokens = Math.floor(contextWindow * SNIP_TARGET_RATIO);

  if (tokenEstimateBefore <= targetTokens || messages.length <= 2) {
    return {
      messages,
      applied: false,
      tokenEstimateBefore,
      tokenEstimateAfter: tokenEstimateBefore,
    };
  }

  const nextMessages = [...messages];
  while (nextMessages.length > 2 && estimateMessagesTokens(nextMessages) > targetTokens) {
    nextMessages.shift();
  }

  const tokenEstimateAfter = estimateMessagesTokens(nextMessages);
  return {
    messages: nextMessages,
    applied: true,
    tokenEstimateBefore,
    tokenEstimateAfter,
    notes: `dropped oldest messages until history fit under ~${SNIP_TARGET_RATIO * 100}% of context window`,
  };
};
