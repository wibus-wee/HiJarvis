import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  completeSimple,
  type Message,
  type Model,
  type UserMessage,
} from "@mariozechner/pi-ai";

import type { Logger } from "./logger.js";

const SUMMARY_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. " +
  "You also have access to the state of the tools that were used by that language model. " +
  "Use this to build on the work that has already been done and avoid duplicating work. " +
  "Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export type CompactionSettings = {
  enabled: boolean;
  triggerRatio: number;
  budgetRatio: number;
  summaryMaxTokens: number;
};

export const defaultCompactionSettings: CompactionSettings = {
  enabled: true,
  triggerRatio: 0.9,
  budgetRatio: 0.9,
  summaryMaxTokens: 1024,
};

const MID_TURN_TOOL_TAIL_MAX_TOKENS = 4096;

export type CompactionRuntime = {
  model: Model<any>;
  systemPrompt: string;
  settings: CompactionSettings;
  apiKey?: string;
  logger?: Logger;
  onCompaction?: (event: CompactionEvent, messages: Message[]) => void;
};

export type CompactionKind = "pre_turn" | "mid_turn";

export type CompactionEvent = {
  type: "compaction";
  kind: CompactionKind;
  tokenEstimateBefore: number;
  tokenEstimateAfter: number;
  summaryTokens: number;
  summaryError?: string;
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
    if (!lastMessage) {
      return llmMessages;
    }

    if (lastMessage.role === "assistant") {
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

      const result = await compactHistory(
        baseHistory,
        "pre_turn",
        runtime,
        systemPromptTokens,
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
      }, llmMessages);
      return llmMessages;
    }

    const totalTokens = estimateMessagesTokens(llmMessages) + systemPromptTokens;
    if (totalTokens < triggerTokens) {
      return llmMessages;
    }

    const result = await compactHistory(
      llmMessages,
      "mid_turn",
      runtime,
      systemPromptTokens,
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
    }, llmMessages);
    return llmMessages;
  };
};

const compactHistory = async (
  history: Message[],
  kind: CompactionKind,
  runtime: CompactionRuntime,
  systemPromptTokens: number,
  signal?: AbortSignal,
): Promise<{ messages: Message[]; summaryTokens: number; summaryError?: string }> => {
  const strippedHistory = stripSummaryMessages(history);
  const existingSummary = extractSummaryFromMessages(history);
  let summaryText: string | null = existingSummary;
  let summaryError: string | undefined;

  if (!summaryText) {
    try {
      summaryText = await summarizeContext(
        strippedHistory,
        runtime,
        systemPromptTokens,
        signal,
      );
    } catch (error) {
      summaryError = error instanceof Error ? error.message : String(error);
      summaryText = "(summary unavailable)";
    }
  }

  const compacted = buildCompactedMessages({
    kind,
    messages: strippedHistory,
    summaryText,
    settings: runtime.settings,
    contextWindow: runtime.model.contextWindow,
    systemPromptTokens,
  });

  const summaryTokens = summaryText ? estimateTextTokens(summaryText) : 0;
  runtime.logger?.info("session.compaction_applied", {
    contextWindow: runtime.model.contextWindow,
    triggerRatio: runtime.settings.triggerRatio,
    budgetRatio: runtime.settings.budgetRatio,
    summaryTokens,
    tokenEstimateBefore: estimateMessagesTokens(history),
    tokenEstimateAfter: estimateMessagesTokens(compacted),
    summaryError,
  });

  return {
    messages: compacted,
    summaryTokens,
    ...(summaryError ? { summaryError } : {}),
  };
};

export type BuildCompactedMessagesInput = {
  kind: CompactionKind;
  messages: Message[];
  summaryText: string | null;
  settings: CompactionSettings;
  contextWindow: number;
  systemPromptTokens: number;
};

export const buildCompactedMessages = (
  input: BuildCompactedMessagesInput,
): Message[] => {
  const { kind, messages, settings, contextWindow, systemPromptTokens } = input;
  const summaryText = normalizeSummaryText(input.summaryText);

  const budgetTokens = Math.max(
    0,
    Math.floor(contextWindow * settings.budgetRatio) - systemPromptTokens,
  );

  const tailBudgetTokens =
    kind === "mid_turn"
      ? Math.min(
          budgetTokens,
          MID_TURN_TOOL_TAIL_MAX_TOKENS,
        )
      : 0;
  const { tailMessages, remainingMessages } =
    kind === "mid_turn"
      ? collectMinimalToolTail(messages, tailBudgetTokens)
      : { tailMessages: [], remainingMessages: messages };
  const tailTokens = estimateMessagesTokens(tailMessages);
  const summaryTokens = summaryText
    ? estimateTextTokens(`${SUMMARY_PREFIX}\n${summaryText}`)
    : 0;
  const remainingTokens = Math.max(0, budgetTokens - summaryTokens - tailTokens);

  const userMessages = collectUserMessages(remainingMessages, remainingTokens);
  if (summaryText) {
    return [...userMessages, createSummaryMessage(summaryText), ...tailMessages];
  }
  return [...userMessages, ...tailMessages];
};

const summarizeContext = async (
  messages: Message[],
  runtime: CompactionRuntime,
  systemPromptTokens: number,
  signal?: AbortSignal,
): Promise<string> => {
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
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : "(summary unavailable)";
};

const trimMessagesToBudget = (
  messages: Message[],
  budgetTokens: number,
  suffix: Message,
): Message[] => {
  const history = [...messages];
  const suffixTokens = estimateMessageTokens(suffix);
  let remaining = Math.max(0, budgetTokens - suffixTokens);

  while (history.length > 0) {
    const tokens = estimateMessagesTokens(history);
    if (tokens <= remaining) {
      break;
    }
    history.shift();
  }

  return [...history, suffix];
};

const stripSummaryMessages = (messages: Message[]): Message[] =>
  messages.filter((message) => !isSummaryMessage(message));

const extractSummaryFromMessages = (messages: Message[]): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (!isSummaryMessage(message)) {
      continue;
    }
    const rawText = extractUserText(message);
    const trimmed = rawText.trim();
    const withoutPrefix = trimmed.slice(SUMMARY_PREFIX.length).trimStart();
    if (withoutPrefix.length > 0) {
      return withoutPrefix;
    }
  }
  return null;
};

const isSummaryMessage = (message: Message): boolean => {
  if (message.role !== "user") {
    return false;
  }

  const text = extractUserText(message);
  return text.trim().startsWith(SUMMARY_PREFIX);
};

const normalizeSummaryText = (summaryText: string | null): string | null => {
  if (summaryText === null) {
    return null;
  }
  const trimmed = summaryText.trim();
  return trimmed.length > 0 ? trimmed : "(summary unavailable)";
};

const createSummaryMessage = (summaryText: string): Message => ({
  role: "user",
  content: `${SUMMARY_PREFIX}\n${summaryText}`,
  timestamp: Date.now(),
});

const collectUserMessages = (
  messages: Message[],
  budgetTokens: number,
): UserMessage[] => {
  if (budgetTokens <= 0) {
    return [];
  }

  const userTexts = messages
    .filter((message) => message.role === "user" && !isSummaryMessage(message))
    .map((message) => extractUserText(message));

  let remaining = budgetTokens;
  const selected: string[] = [];

  for (let index = userTexts.length - 1; index >= 0; index -= 1) {
    const text = userTexts[index];
    if (!text) {
      continue;
    }
    const tokens = estimateTextTokens(text);
    if (tokens <= remaining) {
      selected.unshift(text);
      remaining -= tokens;
      continue;
    }

    if (remaining > 0) {
      selected.unshift(truncateText(text, remaining));
    }
    break;
  }

  return selected.map((text) => ({
    role: "user",
    content: text,
    timestamp: Date.now(),
  }));
};

const collectMinimalToolTail = (
  messages: Message[],
  budgetTokens: number,
): { tailMessages: Message[]; remainingMessages: Message[] } => {
  if (budgetTokens <= 0) {
    return {
      tailMessages: [],
      remainingMessages: messages,
    };
  }

  let remaining = budgetTokens;
  let tailStartIndex = messages.length;
  let index = messages.length - 1;

  while (index >= 0) {
    const message = messages[index];
    if (!message || message.role !== "toolResult") {
      break;
    }

    const tokens = estimateMessageTokens(message);
    if (tokens > remaining) {
      break;
    }

    remaining -= tokens;
    tailStartIndex = index;
    index -= 1;
  }

  const assistantCandidate = messages[index];
  if (
    assistantCandidate &&
    assistantCandidate.role === "assistant" &&
    hasToolCallContent(assistantCandidate)
  ) {
    const tokens = estimateMessageTokens(assistantCandidate);
    if (tokens <= remaining) {
      tailStartIndex = index;
    }
  }

  return {
    tailMessages: messages.slice(tailStartIndex),
    remainingMessages: messages.slice(0, tailStartIndex),
  };
};

const hasToolCallContent = (message: Message): boolean => {
  if (message.role !== "assistant") {
    return false;
  }

  return message.content.some((item) => item.type === "toolCall");
};

const estimateMessagesTokens = (messages: Message[]): number =>
  messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

const estimateMessageTokens = (message: Message): number => {
  if (message.role === "user") {
    return estimateTextTokens(extractUserText(message));
  }

  if (message.role === "assistant") {
    const text = message.content
      .map((item) => {
        if (item.type === "text") {
          return item.text;
        }
        if (item.type === "thinking") {
          return item.thinking;
        }
        if (item.type === "toolCall") {
          const payload = JSON.stringify(item.arguments ?? {});
          return `${item.name} ${payload}`;
        }
        return "";
      })
      .join("\n");
    return estimateTextTokens(text);
  }

  return estimateTextTokens(extractToolResultText(message));
};

const estimateTextTokens = (value: string): number => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return Math.ceil(trimmed.length / 4);
};

const extractUserText = (message: Message): string => {
  if (message.role !== "user") {
    return "";
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
};

const extractAssistantText = (message: Message): string => {
  if (message.role !== "assistant") {
    return "";
  }

  return message.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
};

const extractToolResultText = (message: Message): string => {
  if (message.role !== "toolResult") {
    return "";
  }

  return message.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
};

const truncateText = (value: string, maxTokens: number): string => {
  const maxChars = Math.max(0, maxTokens * 4);
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars).trimEnd();
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
