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
  strategy?: "full" | "partial";
  partialDirection?: PartialCompactionDirection;
  partialSplitIndex?: number;
  stageCount?: number;
  stages?: CompactionStageEvent[];
  appliedStages?: CompactionStageName[];
  boundary?: CompactionBoundary;
  artifacts?: CompactionArtifact[];
};

export type CompactionStageName =
  | "snip"
  | "lightweight"
  | "summary"
  | "assembly";

export type CompactionStageEvent = {
  stage: CompactionStageName;
  applied: boolean;
  tokenEstimateBefore: number;
  tokenEstimateAfter: number;
  notes?: string;
};

export type CompactionBoundary = {
  kind: CompactionKind;
  summaryIncluded: boolean;
  summaryMessageCount: number;
  preservedTailMessageCount: number;
  preservedUserMessageCount: number;
};

export type CompactionArtifact =
  | {
      kind: "tool_state";
      label: string;
      content: string;
    }
  | {
      kind: "skill_state";
      label: string;
      content: string;
    };

export type CompactionRuntime = {
  model: Model<any>;
  systemPrompt: string;
  settings: CompactionSettings;
  apiKey?: string;
  logger?: Logger;
  recentSkillNames?: string[];
  onCompaction?: (event: CompactionEvent, messages: Message[]) => void;
};

export type CompactionNowResult = {
  messages: Message[];
  summaryTokens: number;
  summaryError?: string;
  tokenEstimateAfter: number;
  strategy?: "full" | "partial";
  partialDirection?: PartialCompactionDirection;
  partialSplitIndex?: number;
  stageCount?: number;
  stages?: CompactionStageEvent[];
  appliedStages?: CompactionStageName[];
  boundary?: CompactionBoundary;
  artifacts?: CompactionArtifact[];
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
  retryCount?: number;
};

export type SummaryPromptVariant = "full" | "partial_from" | "partial_up_to";

export type CompactionResult = {
  messages: Message[];
  summaryText: string | null;
  summaryTokens: number;
  summaryError?: string;
  retryCount?: number;
  stages: CompactionStageEvent[];
  appliedStages: CompactionStageName[];
  boundary: CompactionBoundary;
  strategy: "full" | "partial";
  partialDirection?: PartialCompactionDirection;
  partialSplitIndex?: number;
  artifacts: CompactionArtifact[];
};

export type SummaryCompactionResult = {
  messages: Message[];
  summaryText: string | null;
  summaryTokens: number;
  summaryError?: string;
  retryCount?: number;
};

export type LightweightReductionResult = {
  messages: Message[];
  tokenEstimateBefore: number;
  tokenEstimateAfter: number;
  applied: boolean;
  notes?: string;
};

export type BuildCompactedMessagesInput = {
  kind: CompactionKind;
  messages: Message[];
  summaryText: string | null;
  settings: CompactionSettings;
  contextWindow: number;
  systemPromptTokens: number;
};

export type PartialCompactionDirection = "from" | "up_to";

export type PartialCompactionResult = {
  messages: Message[];
  summaryText: string | null;
  summaryTokens: number;
  direction: PartialCompactionDirection;
  splitIndex: number;
  stageCount: number;
  stages: CompactionStageEvent[];
  appliedStages: CompactionStageName[];
  boundary: CompactionBoundary;
  summaryError?: string;
  retryCount?: number;
  artifacts: CompactionArtifact[];
};

export type CompactionTransform = (
  messages: AgentMessage[],
  signal?: AbortSignal,
) => Promise<AgentMessage[]>;
