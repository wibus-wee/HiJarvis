import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { completeSimple, type Message, type Model } from "@mariozechner/pi-ai";

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
  tailRatio: number;
  summaryMaxTokens: number;
};

export const defaultCompactionSettings: CompactionSettings = {
  enabled: true,
  triggerRatio: 0.9,
  budgetRatio: 0.9,
  tailRatio: 0.1,
  summaryMaxTokens: 1024,
};

export type CompactionRuntime = {
  model: Model<any>;
  systemPrompt: string;
  apiKey?: string;
  logger?: Logger;
  settings: CompactionSettings;
};

export const createCompactionTransform = (runtime: CompactionRuntime) => {
  const settings = runtime.settings;
  return async (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> => {
    if (!settings.enabled) {
      return messages;
    }

    if (messages.some((message) => !isLlmMessage(message))) {
      return messages;
    }

    const llmMessages = messages as Message[];
    const systemPromptTokens = estimateTextTokens(runtime.systemPrompt);
    const contextWindow = runtime.model.contextWindow;
    const triggerTokens = Math.floor(contextWindow * settings.triggerRatio);
    const estimatedTokens =
      estimateMessagesTokens(llmMessages) + systemPromptTokens;

    if (estimatedTokens < triggerTokens) {
      return messages;
    }

    const existingSummary = extractSummaryFromMessages(llmMessages);
    const strippedMessages = stripSummaryMessages(llmMessages);
    const hadSummary = strippedMessages.length !== llmMessages.length;

    let summaryText: string | null = null;
    let summaryError: string | undefined;

    if (existingSummary) {
      summaryText = existingSummary;
    } else if (!hadSummary) {
      try {
        summaryText = await summarizeContext(
          strippedMessages,
          runtime,
          systemPromptTokens,
          signal,
        );
      } catch (error) {
        summaryError = error instanceof Error ? error.message : String(error);
      }
    }

    const compactedMessages = buildCompactedMessages({
      messages: strippedMessages,
      summaryText,
      settings,
      contextWindow,
      systemPromptTokens,
    });

    runtime.logger?.info("session.compaction_applied", {
      contextWindow,
      triggerRatio: settings.triggerRatio,
      budgetRatio: settings.budgetRatio,
      tailRatio: settings.tailRatio,
      summaryTokens: summaryText ? estimateTextTokens(summaryText) : 0,
      tokenEstimateBefore: estimatedTokens,
      tokenEstimateAfter: estimateMessagesTokens(compactedMessages),
      summaryError,
    });

    return compactedMessages;
  };
};

export type BuildCompactedMessagesInput = {
  messages: Message[];
  summaryText: string | null;
  settings: CompactionSettings;
  contextWindow: number;
  systemPromptTokens: number;
};

export const buildCompactedMessages = (
  input: BuildCompactedMessagesInput,
): Message[] => {
  const { messages, settings, contextWindow, systemPromptTokens } = input;
  let summaryText = normalizeSummaryText(input.summaryText);

  const budgetTokens = Math.max(
    0,
    Math.floor(contextWindow * settings.budgetRatio) - systemPromptTokens,
  );
  const tailBudgetTokens = Math.min(
    budgetTokens,
    Math.floor(contextWindow * settings.tailRatio),
  );

  const { tailMessages, headMessages } = collectTailMessages(
    messages,
    tailBudgetTokens,
  );
  const tailTokens = estimateMessagesTokens(tailMessages);

  if (summaryText) {
    const maxSummaryTokens = Math.max(0, budgetTokens - tailTokens);
    summaryText = truncateTextToBudget(summaryText, maxSummaryTokens);
  }

  const summaryMessage = summaryText
    ? [createSummaryMessage(summaryText)]
    : [];
  const summaryTokens = summaryText
    ? estimateTextTokens(`${SUMMARY_PREFIX}\n${summaryText}`)
    : 0;

  const remainingTokens = Math.max(
    0,
    budgetTokens - tailTokens - summaryTokens,
  );
  const userMessages = collectUserMessages(headMessages, remainingTokens);

  return [...userMessages, ...summaryMessage, ...tailMessages];
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

const collectTailMessages = (
  messages: Message[],
  budgetTokens: number,
): { tailMessages: Message[]; headMessages: Message[] } => {
  if (messages.length === 0 || budgetTokens <= 0) {
    return { tailMessages: [], headMessages: messages };
  }

  let remaining = budgetTokens;
  const tail: Message[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const tokens = estimateMessageTokens(message);
    if (tokens <= remaining) {
      tail.unshift(message);
      remaining -= tokens;
      continue;
    }

    if (remaining > 0) {
      tail.unshift(truncateMessage(message, remaining));
    }
    break;
  }

  const headLength = Math.max(0, messages.length - tail.length);
  return {
    tailMessages: tail,
    headMessages: messages.slice(0, headLength),
  };
};

const collectUserMessages = (
  messages: Message[],
  budgetTokens: number,
): Message[] => {
  if (budgetTokens <= 0) {
    return [];
  }

  let remaining = budgetTokens;
  const selected: Message[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role !== "user") {
      continue;
    }

    const tokens = estimateMessageTokens(message);
    if (tokens <= remaining) {
      selected.unshift(message);
      remaining -= tokens;
      continue;
    }

    if (remaining > 0) {
      selected.unshift(truncateMessage(message, remaining));
    }
    break;
  }

  return selected;
};

const truncateMessage = (message: Message, maxTokens: number): Message => {
  if (maxTokens <= 0) {
    return message;
  }

  if (message.role === "user") {
    return {
      ...message,
      content: truncateText(extractUserText(message), maxTokens),
    };
  }

  if (message.role === "assistant") {
    const hasToolCall = message.content.some((item) => item.type === "toolCall");
    if (hasToolCall) {
      return message;
    }
    const text = extractAssistantText(message);
    return {
      ...message,
      content: [{ type: "text", text: truncateText(text, maxTokens) }],
    };
  }

  const text = extractToolResultText(message);
  return {
    ...message,
    content: [{ type: "text", text: truncateText(text, maxTokens) }],
  };
};

const truncateTextToBudget = (value: string, maxTokens: number): string => {
  const prefixTokens = estimateTextTokens(SUMMARY_PREFIX);
  const available = Math.max(0, maxTokens - prefixTokens);
  if (available <= 0) {
    return "(summary unavailable)";
  }
  return truncateText(value, available);
};

const truncateText = (value: string, maxTokens: number): string => {
  const maxChars = Math.max(0, maxTokens * 4);
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars).trimEnd();
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

const isLlmMessage = (message: AgentMessage): message is Message => {
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
