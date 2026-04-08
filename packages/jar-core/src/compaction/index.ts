import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

import {
  estimateMessagesTokens,
  estimateTextTokens,
} from "./assembly.js";
import { createSnapshotBoundary, getMessagesAfterBoundary } from "./boundary.js";
import { runCompactionPipeline, runPartialCompactionPipeline } from "./pipeline.js";
import type {
  CompactionKind,
  CompactionNowResult,
  CompactionRuntime,
  CompactionSettings,
} from "./types.js";

export type {
  BuildCompactedMessagesInput,
  CompactionEvent,
  CompactionKind,
  CompactionNowResult,
  CompactionPolicyDecision,
  CompactionResult,
  CompactionRuntime,
  CompactionSettings,
  SummaryGenerationResult,
  PartialCompactionDirection,
  PartialCompactionResult,
} from "./types.js";
export { buildCompactedMessages, findSummaryMessageIndex } from "./assembly.js";
export { extractCompactionArtifacts, renderArtifactMessages } from "./artifacts.js";
export { createSnapshotBoundary, getMessagesAfterBoundary } from "./boundary.js";
export { getUsageInputTokens, shouldCompactFromUsage, decideCompactionFromUsage } from "./policy.js";
export { getSummaryPrompt } from "./prompt.js";

export const defaultCompactionSettings: CompactionSettings = {
  enabled: true,
  triggerRatio: 0.9,
  budgetRatio: 0.9,
  summaryMaxTokens: 1024,
};

export const compactHistoryNow = async (
  messages: AgentMessage[],
  kind: CompactionKind,
  runtime: CompactionRuntime,
  signal?: AbortSignal,
): Promise<CompactionNowResult> => {
  if (!runtime.settings.enabled) {
    const tokenEstimateAfter = messages.some((message) => !isLlmMessage(message))
      ? 0
      : estimateMessagesTokens(messages as Message[]);
    return {
      messages: messages as Message[],
      summaryTokens: 0,
      tokenEstimateAfter,
    };
  }

  if (messages.some((message) => !isLlmMessage(message))) {
    return {
      messages: messages as Message[],
      summaryTokens: 0,
      tokenEstimateAfter: 0,
    };
  }

  const llmMessages = messages as Message[];
  const result = await runCompactionPipeline(
    llmMessages,
    kind,
    runtime,
    signal,
  );
  return {
    messages: result.messages,
    summaryTokens: result.summaryTokens,
    tokenEstimateAfter: estimateMessagesTokens(result.messages),
    ...(result.summaryError ? { summaryError: result.summaryError } : {}),
    strategy: result.strategy,
    ...(result.partialDirection ? { partialDirection: result.partialDirection } : {}),
    ...(result.partialSplitIndex !== undefined
      ? { partialSplitIndex: result.partialSplitIndex }
      : {}),
    artifacts: result.artifacts,
    stageCount: result.stages.length,
    stages: result.stages,
    appliedStages: result.appliedStages,
    boundary: result.boundary,
  };
};

export const createCompactionTransform = (runtime: CompactionRuntime) => {
  return async (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> => {
    if (!runtime.settings.enabled) {
      return messages;
    }

    if (messages.some((message) => !isLlmMessage(message))) {
      return messages;
    }

    const llmMessages = messages as Message[];
    const lastMessage = llmMessages[llmMessages.length - 1];
    if (!lastMessage || lastMessage.role === "assistant") {
      return llmMessages;
    }

    const systemPromptTokens = estimateTextTokens(runtime.systemPrompt);
    const contextWindow = runtime.model.contextWindow;
    const triggerTokens = Math.floor(contextWindow * runtime.settings.triggerRatio);

    if (lastMessage.role === "user") {
      const baseHistory = llmMessages.slice(0, -1);
      const baseTokens = estimateMessagesTokens(baseHistory) + systemPromptTokens;
      if (baseTokens < triggerTokens) {
        return llmMessages;
      }

      const result = await runCompactionPipeline(
        baseHistory,
        "pre_turn",
        runtime,
        signal,
      );
      const nextMessages = [...result.messages, lastMessage];
      applyCompactionInPlace(llmMessages, nextMessages);
      runtime.onCompaction?.({
        type: "compaction",
        kind: "pre_turn",
        tokenEstimateBefore: baseTokens,
        tokenEstimateAfter: estimateMessagesTokens(llmMessages),
        summaryTokens: result.summaryTokens,
        ...(result.summaryError ? { summaryError: result.summaryError } : {}),
        strategy: result.strategy,
        ...(result.partialDirection ? { partialDirection: result.partialDirection } : {}),
        ...(result.partialSplitIndex !== undefined
          ? { partialSplitIndex: result.partialSplitIndex }
          : {}),
        artifacts: result.artifacts,
        stageCount: result.stages.length,
        stages: result.stages,
        appliedStages: result.appliedStages,
        boundary: result.boundary,
      }, llmMessages);
      return llmMessages;
    }

    const totalTokens = estimateMessagesTokens(llmMessages) + systemPromptTokens;
    if (totalTokens < triggerTokens) {
      return llmMessages;
    }

    const result = await runCompactionPipeline(
      llmMessages,
      "mid_turn",
      runtime,
      signal,
    );
    applyCompactionInPlace(llmMessages, result.messages);
    runtime.onCompaction?.({
      type: "compaction",
      kind: "mid_turn",
      tokenEstimateBefore: totalTokens,
      tokenEstimateAfter: estimateMessagesTokens(llmMessages),
      summaryTokens: result.summaryTokens,
      ...(result.summaryError ? { summaryError: result.summaryError } : {}),
      strategy: result.strategy,
      ...(result.partialDirection ? { partialDirection: result.partialDirection } : {}),
      ...(result.partialSplitIndex !== undefined
        ? { partialSplitIndex: result.partialSplitIndex }
        : {}),
      artifacts: result.artifacts,
      stageCount: result.stages.length,
      stages: result.stages,
      appliedStages: result.appliedStages,
      boundary: result.boundary,
    }, llmMessages);
    return llmMessages;
  };
};

export const partialCompactHistoryNow = async (
  messages: AgentMessage[],
  splitIndex: number,
  direction: import("./types.js").PartialCompactionDirection,
  runtime: CompactionRuntime,
  signal?: AbortSignal,
): Promise<import("./types.js").PartialCompactionResult> => {
  if (!runtime.settings.enabled) {
    return {
      messages: messages as Message[],
      summaryText: null,
      summaryTokens: 0,
      direction,
      splitIndex,
      stageCount: 0,
      stages: [],
      appliedStages: [],
      boundary: {
        kind: direction === "from" ? "post_turn" : "pre_turn",
        summaryIncluded: false,
        summaryMessageCount: 0,
        preservedTailMessageCount: 0,
        preservedUserMessageCount: 0,
      },
    };
  }

  if (messages.some((message) => !isLlmMessage(message))) {
    return {
      messages: messages as Message[],
      summaryText: null,
      summaryTokens: 0,
      direction,
      splitIndex,
      stageCount: 0,
      stages: [],
      appliedStages: [],
      boundary: {
        kind: direction === "from" ? "post_turn" : "pre_turn",
        summaryIncluded: false,
        summaryMessageCount: 0,
        preservedTailMessageCount: 0,
        preservedUserMessageCount: 0,
      },
    };
  }

  return runPartialCompactionPipeline(
    messages as Message[],
    splitIndex,
    direction,
    runtime,
    signal,
  );
};

const applyCompactionInPlace = (
  target: Message[],
  nextMessages: Message[],
): void => {
  target.length = 0;
  target.push(...nextMessages);
};

const isLlmMessage = (message: AgentMessage | Message): message is Message => {
  if (!message || typeof message !== "object") {
    return false;
  }
  if (!("role" in message)) {
    return false;
  }
  return (
    (message as Message).role === "user" ||
    (message as Message).role === "assistant" ||
    (message as Message).role === "toolResult"
  );
};
