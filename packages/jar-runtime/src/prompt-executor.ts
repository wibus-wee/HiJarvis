import { setTimeout as sleep } from "node:timers/promises";

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
  prompt: (input: string) => Promise<void>;
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

export const executePromptWithPolicy = async (
  agent: PromptAgent,
  prompt: string,
  policy: PromptExecutionPolicy,
  writers: PromptExecutionWriters,
): Promise<void> => {
  const totalAttempts = policy.retryAttempts + 1;

  for (let attemptIndex = 0; attemptIndex < totalAttempts; attemptIndex += 1) {
    const attemptNumber = attemptIndex + 1;
    const failure = await runPromptAttempt(agent, prompt, policy.requestTimeoutMs);
    if (failure === null) {
      return;
    }

    writers.stderr.write(
      `[prompt:error] attempt=${attemptNumber}/${totalAttempts} category=${failure.category} retryable=${failure.retryable} message=${failure.message}\n`,
    );

    const hasRetryBudget = attemptNumber < totalAttempts;
    if (!failure.retryable || !hasRetryBudget) {
      throw new Error(`[${failure.category}] ${failure.message}`);
    }

    const delayMs = getRetryDelayMs(policy, attemptIndex);
    const nextAttempt = attemptNumber + 1;
    writers.stderr.write(
      `[prompt:retry] waiting=${delayMs}ms next_attempt=${nextAttempt}/${totalAttempts}\n`,
    );
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
    ])
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

const runPromptAttempt = async (
  agent: PromptAgent,
  prompt: string,
  requestTimeoutMs: number,
): Promise<PromptFailure | null> => {
  let timeoutTriggered = false;
  let thrownError: unknown;

  const timeoutHandle = setTimeout(() => {
    timeoutTriggered = true;
    agent.abort();
  }, requestTimeoutMs);
  timeoutHandle.unref?.();

  try {
    await agent.prompt(prompt);
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
