import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";

import type { Logger } from "../logger.js";

export type CompactionSettings = {
  enabled: boolean;
  triggerRatio: number;
  budgetRatio: number;
  summaryMaxTokens: number;
};

export type CompactionKind = "pre_turn" | "mid_turn" | "post_turn";

export type CompactionEvent = {
  type: "compaction";
  kind: CompactionKind;
  tokenEstimateBefore: number;
  tokenEstimateAfter: number;
  summaryTokens: number;
  summaryError?: string;
};

export type CompactionRuntime = {
  model: Model<any>;
  systemPrompt: string;
  settings: CompactionSettings;
  apiKey?: string;
  logger?: Logger;
  onCompaction?: (event: CompactionEvent, messages: Message[]) => void;
};

export type CompactionNowResult = {
  messages: Message[];
  summaryTokens: number;
  summaryError?: string;
  tokenEstimateAfter: number;
};

export type CompactionPolicyDecision = {
  shouldCompact: boolean;
  triggerTokens: number;
  inputTokens: number;
  reason: "disabled" | "no_usage" | "below_threshold" | "above_threshold";
};

export type SummaryGenerationResult = {
  summaryText: string;
  summaryTokens: number;
  summaryError?: string;
};

export type CompactionResult = {
  messages: Message[];
  summaryText: string | null;
  summaryTokens: number;
  summaryError?: string;
};

export type BuildCompactedMessagesInput = {
  kind: CompactionKind;
  messages: Message[];
  summaryText: string | null;
  settings: CompactionSettings;
  contextWindow: number;
  systemPromptTokens: number;
};

export type CompactionTransform = (
  messages: AgentMessage[],
  signal?: AbortSignal,
) => Promise<AgentMessage[]>;
