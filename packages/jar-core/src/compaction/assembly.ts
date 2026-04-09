import type { Message, UserMessage } from "@mariozechner/pi-ai";

import { SUMMARY_PREFIX } from "./prompt.js";
import type { BuildCompactedMessagesInput } from "./types.js";

const MID_TURN_TOOL_TAIL_MAX_TOKENS = 4096;
const APPROX_BYTES_PER_TOKEN = 4;
const RESIZED_IMAGE_BYTES_ESTIMATE = 7_373;
const ITEM_SEPARATOR_BYTES = 1;

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
      ? Math.min(budgetTokens, MID_TURN_TOOL_TAIL_MAX_TOKENS)
      : 0;
  const { tailMessages, remainingMessages } =
    kind === "mid_turn"
      ? collectMinimalToolTail(messages, tailBudgetTokens)
      : { tailMessages: [], remainingMessages: messages };
  const tailTokens = estimateMessagesTokens(tailMessages);
  const summaryTokens = summaryText
    ? estimateTextTokens(`${SUMMARY_PREFIX}
${summaryText}`)
    : 0;
  const remainingTokens = Math.max(0, budgetTokens - summaryTokens - tailTokens);

  const userMessages = collectUserMessages(remainingMessages, remainingTokens);
  if (summaryText) {
    return [createSummaryMessage(summaryText), ...userMessages, ...tailMessages];
  }
  return [...userMessages, ...tailMessages];
};

export const stripSummaryMessages = (messages: Message[]): Message[] =>
  messages.filter((message) => !isSummaryMessage(message));

export const extractSummaryFromMessages = (messages: Message[]): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || !isSummaryMessage(message)) {
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

export const findSummaryMessageIndex = (messages: Message[]): number | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isSummaryMessage(message)) {
      return index;
    }
  }
  return null;
};

export const estimateMessagesTokens = (messages: Message[]): number =>
  messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

export const estimateMessageTokens = (message: Message): number => {
  const bytes = estimateMessageBytes(message);
  if (bytes <= 0) {
    return 0;
  }
  return estimateTokensFromBytes(bytes);
};

export const estimateTextTokens = (value: string): number => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return estimateTokensFromBytes(estimateUtf8Bytes(value));
};

export const normalizeSummaryText = (summaryText: string | null): string | null => {
  if (summaryText === null) {
    return null;
  }
  const trimmed = summaryText.trim();
  return trimmed.length > 0 ? trimmed : "(summary unavailable)";
};

export const isSummaryMessage = (message: Message): boolean => {
  if (message.role !== "user") {
    return false;
  }

  const text = extractUserText(message);
  return text.trim().startsWith(SUMMARY_PREFIX);
};

export const createSummaryMessage = (summaryText: string): Message => ({
  role: "user",
  content: `${SUMMARY_PREFIX}\n${summaryText}`,
  timestamp: Date.now(),
});

export const extractUserText = (message: Message): string => {
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

export const extractAssistantText = (message: Message): string => {
  if (message.role !== "assistant") {
    return "";
  }

  return message.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
};

export const collectUserMessages = (
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

export const collectMinimalToolTail = (
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

const extractToolResultText = (message: Message): string => {
  if (message.role !== "toolResult") {
    return "";
  }

  return message.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
};

export { extractToolResultText };

const truncateText = (value: string, maxTokens: number): string => {
  const maxBytes = Math.max(0, maxTokens * APPROX_BYTES_PER_TOKEN);
  if (estimateUtf8Bytes(value) <= maxBytes) {
    return value;
  }
  return truncateTextByBytes(value, maxBytes).trimEnd();
};

const hasToolCallContent = (message: Message): boolean => {
  if (message.role !== "assistant") {
    return false;
  }

  return message.content.some((item) => item.type === "toolCall");
};

const estimateMessageBytes = (message: Message): number => {
  if (message.role === "user") {
    if (typeof message.content === "string") {
      return estimateUtf8Bytes(message.content);
    }

    return sumItemBytes(message.content, (item) => {
      if (item.type === "text") {
        return estimateUtf8Bytes(item.text);
      }
      if (item.type === "image") {
        return RESIZED_IMAGE_BYTES_ESTIMATE;
      }
      return 0;
    });
  }

  if (message.role === "assistant") {
    return sumItemBytes(message.content, (item) => {
      if (item.type === "text") {
        return estimateUtf8Bytes(item.text);
      }
      if (item.type === "thinking") {
        return estimateUtf8Bytes(item.thinking);
      }
      if (item.type === "toolCall") {
        const payload = JSON.stringify(item.arguments ?? {});
        return estimateUtf8Bytes(`${item.name} ${payload}`);
      }
      return 0;
    });
  }

  if (message.role === "toolResult") {
    return sumItemBytes(message.content, (item) => {
      if (item.type === "text") {
        return estimateUtf8Bytes(item.text);
      }
      if (item.type === "image") {
        return RESIZED_IMAGE_BYTES_ESTIMATE;
      }
      return 0;
    });
  }

  return 0;
};

const sumItemBytes = <T>(
  items: T[],
  estimateItem: (item: T) => number,
): number => {
  let total = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (index > 0) {
      total += ITEM_SEPARATOR_BYTES;
    }
    total += estimateItem(items[index]!);
  }
  return total;
};

const estimateUtf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const estimateTokensFromBytes = (bytes: number): number =>
  Math.ceil(bytes / APPROX_BYTES_PER_TOKEN);

const truncateTextByBytes = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0 || value.length === 0) {
    return "";
  }

  if (estimateUtf8Bytes(value) <= maxBytes) {
    return value;
  }

  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const slice = value.slice(0, mid);
    if (estimateUtf8Bytes(slice) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return value.slice(0, low);
};
