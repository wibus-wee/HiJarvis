import { setTimeout as sleep } from "node:timers/promises";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type { Logger } from "./logger.js";

export type PromptInput = string | AgentMessage | AgentMessage[];

export type PromptErrorCategory =
  | "timeout"
  | "rate_limit"
  | "network"
  | "auth"
  | "input"
  | "aborted"
  | "tool"
  | "unknown";

export type PromptExecutionPolicy = {
  requestTimeoutMs: number;
  retryAttempts: number;
  retryInitialDelayMs: number;
  retryBackoffMultiplier: number;
  retryMaxDelayMs: number;
};

export type PromptAgent = {
  prompt: {
    (input: string): Promise<void>;
    (input: AgentMessage | AgentMessage[]): Promise<void>;
  };
  abort: () => void;
  state: {
    errorMessage?: string;
  };
};

type PromptFailure = {
  category: PromptErrorCategory;
  retryable: boolean;
  message: string;
};

type PromptExecutionWriters = {
  stderr: Pick<NodeJS.WriteStream, "write">;
};

export type PromptExecutionObserver = {
  onAttemptFailed?: (failure: {
    attempt: number;
    totalAttempts: number;
    category: PromptErrorCategory;
    retryable: boolean;
    message: string;
  }) => Promise<void> | void;
  onRetryScheduled?: (event: {
    attempt: number;
    totalAttempts: number;
    nextAttempt: number;
    delayMs: number;
    category: PromptErrorCategory;
  }) => Promise<void> | void;
};

export const executePromptWithPolicy = async (
  agent: PromptAgent,
  prompt: PromptInput,
  policy: PromptExecutionPolicy,
  writers: PromptExecutionWriters,
  logger?: Logger,
  observer?: PromptExecutionObserver,
): Promise<void> => {
  const totalAttempts = policy.retryAttempts + 1;

  for (let attemptIndex = 0; attemptIndex < totalAttempts; attemptIndex += 1) {
    const attemptNumber = attemptIndex + 1;
    const failure = await runPromptAttempt(agent, prompt, policy.requestTimeoutMs);
    if (failure === null) {
      return;
    }

    if (!logger) {
      writers.stderr.write(
        `[prompt:error] attempt=${attemptNumber}/${totalAttempts} category=${failure.category} retryable=${failure.retryable} message=${failure.message}\n`,
      );
    }
    logger?.warn("prompt.attempt_failed", {
      attempt: attemptNumber,
      totalAttempts,
      category: failure.category,
      retryable: failure.retryable,
      message: failure.message,
    });
    await observer?.onAttemptFailed?.({
      attempt: attemptNumber,
      totalAttempts,
      category: failure.category,
      retryable: failure.retryable,
      message: failure.message,
    });

    const hasRetryBudget = attemptNumber < totalAttempts;
    if (!failure.retryable || !hasRetryBudget) {
      throw new Error(`[${failure.category}] ${failure.message}`);
    }

    const delayMs = getRetryDelayMs(policy, attemptIndex);
    const nextAttempt = attemptNumber + 1;
    if (!logger) {
      writers.stderr.write(
        `[prompt:retry] waiting=${delayMs}ms next_attempt=${nextAttempt}/${totalAttempts}\n`,
      );
    }
    logger?.info("prompt.retry_scheduled", {
      delayMs,
      nextAttempt,
      totalAttempts,
      category: failure.category,
    });
    await observer?.onRetryScheduled?.({
      attempt: attemptNumber,
      totalAttempts,
      nextAttempt,
      delayMs,
      category: failure.category,
    });
    await sleep(delayMs);
  }

  throw new Error("Prompt execution failed unexpectedly");
};

export const getRetryDelayMs = (
  policy: PromptExecutionPolicy,
  retryIndex: number,
): number => {
  const rawDelay =
    policy.retryInitialDelayMs * policy.retryBackoffMultiplier ** retryIndex;
  const boundedDelay = Math.min(policy.retryMaxDelayMs, rawDelay);
  return Math.max(1, Math.round(boundedDelay));
};

export const classifyPromptFailure = (
  message: string,
  timedOut: boolean,
): PromptFailure => {
  if (timedOut) {
    return {
      category: "timeout",
      retryable: true,
      message,
    };
  }

  const normalized = message.toLowerCase();

  if (matches(normalized, ["rate limit", "too many requests", "429"])) {
    return {
      category: "rate_limit",
      retryable: true,
      message,
    };
  }

  if (
    matches(normalized, [
      "econnreset",
      "econnrefused",
      "etimedout",
      "enotfound",
      "network",
      "fetch failed",
      "socket hang up",
      "temporarily unavailable",
      "service unavailable",
      "gateway timeout",
      "bad gateway",
      "web server is down",
      "host error",
      "origin error",
      "cloudflare",
    ])
    || hasRetryableServerStatus(normalized)
  ) {
    return {
      category: "network",
      retryable: true,
      message,
    };
  }

  if (
    matches(normalized, [
      "unauthorized",
      "forbidden",
      "invalid api key",
      "authentication",
      "permission denied",
      "insufficient_quota",
      "401",
      "403",
    ])
  ) {
    return {
      category: "auth",
      retryable: false,
      message,
    };
  }

  if (
    matches(normalized, [
      "invalid request",
      "bad request",
      "context length",
      "maximum context",
      "token limit",
      "model does not exist",
      "unsupported",
      "400",
    ])
  ) {
    return {
      category: "input",
      retryable: false,
      message,
    };
  }

  if (matches(normalized, ["aborted", "abort"])) {
    return {
      category: "aborted",
      retryable: false,
      message,
    };
  }

  if (matches(normalized, ["tool", "patch", "workspace"])) {
    return {
      category: "tool",
      retryable: false,
      message,
    };
  }

  return {
    category: "unknown",
    retryable: true,
    message,
  };
};

const hasRetryableServerStatus = (normalizedMessage: string): boolean => {
  return /\b5\d{2}\b/.test(normalizedMessage);
};

const runPromptAttempt = async (
  agent: PromptAgent,
  prompt: PromptInput,
  requestTimeoutMs: number,
): Promise<PromptFailure | null> => {
  let timeoutTriggered = false;
  let thrownError: unknown;

  const timeoutHandle = setTimeout(() => {
    timeoutTriggered = true;
    agent.abort();
  }, requestTimeoutMs);
  timeoutHandle.unref?.();

  // Normalize single AgentMessage to array so callers never need to branch.
  const normalizedPrompt: string | AgentMessage[] =
    !Array.isArray(prompt) && typeof prompt !== "string"
      ? [prompt]
      : prompt;

  try {
    if (typeof normalizedPrompt === "string") {
      await agent.prompt(normalizedPrompt);
    } else {
      await agent.prompt(normalizedPrompt);
    }
  } catch (error) {
    thrownError = error;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (timeoutTriggered) {
    return classifyPromptFailure(
      `Request timed out after ${requestTimeoutMs}ms`,
      true,
    );
  }

  const message = getFailureMessage(thrownError, agent.state.errorMessage);
  if (message === null) {
    return null;
  }

  return classifyPromptFailure(message, false);
};

const getFailureMessage = (
  thrownError: unknown,
  runtimeErrorMessage?: string,
): string | null => {
  if (runtimeErrorMessage && runtimeErrorMessage.trim().length > 0) {
    return runtimeErrorMessage.trim();
  }

  if (thrownError instanceof Error) {
    const trimmed = thrownError.message.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  if (thrownError !== undefined && thrownError !== null) {
    return String(thrownError);
  }

  return null;
};

const matches = (message: string, patterns: string[]): boolean => {
  return patterns.some((pattern) => message.includes(pattern));
};
