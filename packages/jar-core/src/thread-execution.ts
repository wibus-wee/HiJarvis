import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

import type { ExecutionAuditStore } from "./persistence.js";
import type { Logger } from "./logger.js";
import {
  generateThreadItemId,
  generateThreadRunId,
  generateThreadTurnId,
  type CompactionEvent,
  type ThreadItem,
  type ThreadRun,
  type ThreadRunKind,
  type ThreadTurn,
  type ThreadTurnTrigger,
} from "./execution-types.js";
import {
  getPromptTextInput,
  stripMemoryExcludedPromptContext,
} from "./prompt-context.js";
import type { PromptErrorCategory, PromptInput } from "./prompt-executor.js";

const promptPreviewLimit = 2_000;

export type ThreadExecutionTrackerOptions = {
  threadId: string;
  auditStore: ExecutionAuditStore;
  prompt: PromptInput;
  trigger: ThreadTurnTrigger;
  logger?: Logger;
  runKind?: ThreadRunKind;
  turnInputMetadata?: Record<string, unknown>;
};

export type ThreadExecutionTracker = {
  turn: ThreadTurn;
  run: ThreadRun;
  turnId: string;
  runId: string;
  recordEvent: (event: AgentEvent) => Promise<void>;
  recordCompaction: (event: CompactionEvent) => Promise<void>;
  recordRetryNotice: (payload: {
    attempt: number;
    totalAttempts: number;
    category: PromptErrorCategory;
    retryable?: boolean;
    message?: string;
    nextAttempt?: number;
    delayMs?: number;
  }) => Promise<void>;
  recordNote: (payload: Record<string, unknown>) => Promise<void>;
  complete: (outputText: string) => Promise<void>;
  fail: (message: string) => Promise<void>;
};

export const startThreadExecutionTracker = async (
  options: ThreadExecutionTrackerOptions,
): Promise<ThreadExecutionTracker> => {
  const now = Date.now();
  const turn: ThreadTurn = {
    turnId: generateThreadTurnId(),
    threadId: options.threadId,
    trigger: options.trigger,
    status: "running",
    input: buildTurnInput(options.prompt, options.turnInputMetadata),
    createdAt: now,
    startedAt: now,
  };
  const run: ThreadRun = {
    runId: generateThreadRunId(),
    turnId: turn.turnId,
    kind: options.runKind ?? "act",
    sequence: 1,
    status: "running",
    startedAt: now,
  };

  await options.auditStore.appendTurn(options.threadId, turn);
  await options.auditStore.appendRun(options.threadId, run);
  await options.auditStore.appendItem(options.threadId, {
    itemId: generateThreadItemId(),
    runId: run.runId,
    type: "user_input",
    status: "completed",
    payload: {
      promptPreview: turn.input.promptPreview,
      promptChars: turn.input.promptChars,
      promptMessageCount: turn.input.promptMessageCount,
      metadata: turn.input.metadata,
    },
    createdAt: now,
  });

  let settled = false;

  const accumulatedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
  const accumulatedCost = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  let usageTurnCount = 0;

  const appendItem = async (item: Omit<ThreadItem, "itemId" | "runId" | "createdAt">) => {
    await options.auditStore.appendItem(options.threadId, {
      itemId: generateThreadItemId(),
      runId: run.runId,
      ...item,
      createdAt: Date.now(),
    });
  };

  const complete = async (outputText: string): Promise<void> => {
    if (settled) {
      return;
    }
    settled = true;
    const completedAt = Date.now();

    await options.auditStore.appendRun(options.threadId, {
      ...run,
      status: "completed",
      completedAt,
    });

    if (usageTurnCount > 0) {
      await appendItem({
        type: "usage_summary",
        status: "completed",
        payload: {
          usage: { ...accumulatedUsage },
          cost: { ...accumulatedCost },
          llmTurnCount: usageTurnCount,
        },
      });
    }

    await options.auditStore.appendTurn(options.threadId, {
      ...turn,
      status: "completed",
      completedAt,
      output: {
        outputText,
        outputChars: outputText.trim().length,
      },
    });
  };

  const fail = async (message: string): Promise<void> => {
    if (settled) {
      return;
    }
    settled = true;
    const completedAt = Date.now();

    await options.auditStore.appendRun(options.threadId, {
      ...run,
      status: "failed",
      completedAt,
      error: message,
    });
    await options.auditStore.appendTurn(options.threadId, {
      ...turn,
      status: "failed",
      completedAt,
    });
  };

  return {
    turn,
    run,
    turnId: turn.turnId,
    runId: run.runId,
    recordEvent: async (event) => {
      switch (event.type) {
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            await appendItem({
              type: "assistant_message",
              status: "delta",
              payload: {
                text: event.assistantMessageEvent.delta,
              },
            });
          }
          return;
        case "message_end":
          if ("role" in event.message && event.message.role === "assistant" && event.message.usage) {
            const u = event.message.usage;
            accumulatedUsage.inputTokens += u.input;
            accumulatedUsage.outputTokens += u.output;
            accumulatedUsage.cacheReadTokens += u.cacheRead;
            accumulatedUsage.cacheWriteTokens += u.cacheWrite;
            accumulatedUsage.totalTokens += u.totalTokens;
            accumulatedCost.input += u.cost.input;
            accumulatedCost.output += u.cost.output;
            accumulatedCost.cacheRead += u.cost.cacheRead;
            accumulatedCost.cacheWrite += u.cost.cacheWrite;
            accumulatedCost.total += u.cost.total;
            usageTurnCount += 1;
          }

          if (!("role" in event.message) || event.message.role !== "assistant") {
            return;
          }

          for (const segment of getAssistantThinkingSegments(event.message)) {
            await appendItem({
              type: "thinking",
              status: "completed",
              payload: {
                text: segment,
              },
            });
          }

          await appendItem({
            type: "assistant_message",
            status: "completed",
            payload: {
              text: extractAssistantText(event.message),
            },
          });
          return;
        case "tool_execution_start":
          await appendItem({
            type: "tool_call",
            status: "completed",
            payload: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
            },
          });
          return;
        case "tool_execution_end":
          await appendItem({
            type: "tool_result",
            status: "completed",
            payload: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              isError: event.isError,
              result: event.result,
            },
          });
          return;
        default:
          return;
      }
    },
    recordCompaction: async (event) => {
      await appendItem({
        type: "compaction",
        status: "completed",
        payload: {
          kind: event.kind,
          tokenEstimateBefore: event.tokenEstimateBefore,
          tokenEstimateAfter: event.tokenEstimateAfter,
          summaryTokens: event.summaryTokens,
          summaryError: event.summaryError,
          stageCount: event.stageCount,
          stages: event.stages,
          appliedStages: event.appliedStages,
        },
      });
    },
    recordRetryNotice: async (payload) => {
      await appendItem({
        type: "retry_notice",
        status: "completed",
        payload,
      });
    },
    recordNote: async (payload) => {
      await appendItem({
        type: "note",
        status: "completed",
        payload,
      });
    },
    complete,
    fail,
  };
};

export const countPromptMessages = (prompt: PromptInput): number => {
  if (typeof prompt === "string") {
    return 1;
  }

  return Array.isArray(prompt) ? prompt.length : 1;
};

export const estimatePromptChars = (prompt: PromptInput): number => {
  if (typeof prompt === "string") {
    return prompt.length;
  }

  const messages = Array.isArray(prompt) ? prompt : [prompt];
  return messages.reduce((sum, message) => sum + estimateMessageChars(message), 0);
};

const buildTurnInput = (
  prompt: PromptInput,
  metadata?: Record<string, unknown>,
): ThreadTurn["input"] => {
  const preview = stripMemoryExcludedPromptContext(
    getPromptTextInput(prompt),
  );

  return {
    promptPreview: truncateText(preview, promptPreviewLimit),
    promptChars: estimatePromptChars(prompt),
    promptMessageCount: countPromptMessages(prompt),
    metadata,
  };
};

const extractAssistantText = (
  message: Extract<AgentMessage, { role: "assistant" }>,
): string => {
  return message.content
    .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("");
};

const getAssistantThinkingSegments = (
  message: Extract<AgentMessage, { role: "assistant" }>,
): string[] => {
  return message.content
    .filter((item): item is Extract<typeof item, { type: "thinking" }> => item.type === "thinking")
    .map((item) => item.thinking)
    .filter((value) => value.trim().length > 0);
};

const estimateMessageChars = (message: AgentMessage): number => {
  if (!("role" in message)) {
    return 0;
  }

  if (message.role === "user") {
    if (typeof message.content === "string") {
      return message.content.length;
    }

    return message.content.reduce((sum, item) => {
      if (item.type === "text") {
        return sum + item.text.length;
      }

      if (item.type === "image") {
        return sum + item.data.length;
      }

      return sum;
    }, 0);
  }

  if (message.role === "assistant") {
    return message.content.reduce((sum, item) => {
      if (item.type === "text") {
        return sum + item.text.length;
      }

      if (item.type === "thinking") {
        return sum + item.thinking.length;
      }

      if (item.type === "toolCall") {
        return sum + item.name.length + JSON.stringify(item.arguments ?? {}).length;
      }

      return sum;
    }, 0);
  }

  if (message.role === "toolResult") {
    return message.content.reduce((sum, item) => {
      if (item.type === "text") {
        return sum + item.text.length;
      }

      if (item.type === "image") {
        return sum + item.data.length;
      }

      return sum;
    }, 0);
  }

  return 0;
};

const truncateText = (value: string, limit: number): string => {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(0, limit - 1))}…`;
};
