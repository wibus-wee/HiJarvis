import type { Usage } from "@mariozechner/pi-ai";

import type { CompactionPolicyDecision, CompactionRuntime } from "./types.js";

export const getUsageInputTokens = (usage?: Usage): number => {
  if (!usage) {
    return 0;
  }
  return usage.input > 0 ? usage.input : usage.totalTokens;
};

export const decideCompactionFromUsage = (
  usage: Usage | undefined,
  runtime: Pick<CompactionRuntime, "model" | "settings">,
): CompactionPolicyDecision => {
  const triggerTokens = Math.floor(
    runtime.model.contextWindow * runtime.settings.triggerRatio,
  );

  if (!runtime.settings.enabled) {
    return {
      shouldCompact: false,
      triggerTokens,
      inputTokens: 0,
      reason: "disabled",
    };
  }

  const inputTokens = getUsageInputTokens(usage);
  if (inputTokens <= 0) {
    return {
      shouldCompact: false,
      triggerTokens,
      inputTokens,
      reason: "no_usage",
    };
  }

  if (inputTokens < triggerTokens) {
    return {
      shouldCompact: false,
      triggerTokens,
      inputTokens,
      reason: "below_threshold",
    };
  }

  return {
    shouldCompact: true,
    triggerTokens,
    inputTokens,
    reason: "above_threshold",
  };
};

export const shouldCompactFromUsage = (
  usage: Usage | undefined,
  runtime: Pick<CompactionRuntime, "model" | "settings">,
): boolean => decideCompactionFromUsage(usage, runtime).shouldCompact;
