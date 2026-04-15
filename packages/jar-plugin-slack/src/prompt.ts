import { buildTurnPrompt } from "@hijarvis/jar-core";

const slackMarkdownBlockChunkLimit = 3_000;
const slackMarkdownTotalLimit = 12_000;
const slackTextFallbackLimit = 4_000;
const slackMaxBlocks = 50;

export type SlackMessage = {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  sentAt: Date;
};

export type SlackReplyPayload = {
  text: string;
  blocks?: Array<{
    type: "markdown";
    text: string;
  }>;
};

export const createSlackSessionId = (threadId: string): string => {
  return threadId.replaceAll(":", "__").replaceAll("/", "_");
};

export const formatChannelContextBlock = (
  messages: SlackMessage[],
  mode: "delta" | "bootstrap",
): string => {
  if (messages.length === 0) {
    if (mode === "delta") {
      return "Top-level channel messages since your last reply in this channel:\n- No new top-level channel messages were captured before the current mention.";
    }

    return "Top-level channel messages before Jarvis joined this channel conversation:\n- No recent top-level channel messages were captured within the configured bootstrap window.";
  }

  const lines = messages.map((message) => {
    const author = message.authorName || message.authorId;
    const timestamp = message.sentAt.toISOString();
    return `- [${timestamp}] ${author}: ${message.text}`;
  });

  if (mode === "delta") {
    return `Top-level channel messages since your last reply in this channel:\n${lines.join("\n")}`;
  }

  return `Top-level channel messages before Jarvis joined this channel conversation:\n${lines.join("\n")}`;
};

export const formatQueuedMessagesBlock = (skipped: SlackMessage[]): string => {
  if (skipped.length === 0) {
    return "";
  }

  const lines = skipped.map((message) => {
    const author = message.authorName || message.authorId;
    return `- ${author}: ${message.text}`;
  });

  return [
    "Additional user messages that arrived while you were still processing the previous turn:",
    ...lines,
  ].join("\n");
};

export const formatCurrentMessageBlock = (message: SlackMessage): string => {
  const author = message.authorName || message.authorId;

  return [
    "Current user request:",
    `- ${author}: ${message.text}`,
  ].join("\n");
};

export const buildSubscribedThreadPrompt = (
  message: SlackMessage,
  skipped: SlackMessage[],
): string => {
  return buildTurnPrompt({
    lead: [
      "You are continuing an existing Slack thread conversation.",
      "The thread history in your session is the source of truth for prior bot interaction.",
      "Treat the queued user messages and current request below as the new thread messages since your last reply.",
    ],
    sections: [
      { body: formatQueuedMessagesBlock(skipped) },
      { body: formatCurrentMessageBlock(message) },
    ],
  });
};

export const createSlackReplyPayload = (reply: string): SlackReplyPayload => {
  const normalized = reply.trim();
  const fallbackText = truncateForSlackText(normalized, slackTextFallbackLimit);
  const blocks = splitSlackMarkdownBlocks(normalized).map((text) => ({
    type: "markdown" as const,
    text,
  }));

  return blocks.length > 0
    ? {
      text: fallbackText,
      blocks,
    }
    : {
      text: fallbackText,
    };
};

const splitSlackMarkdownBlocks = (text: string): string[] => {
  if (text.length === 0) {
    return [];
  }

  const blocks: string[] = [];
  let totalChars = 0;

  const appendBlock = (value: string): boolean => {
    if (value.length === 0 || blocks.length >= slackMaxBlocks) {
      return false;
    }

    const remainingBudget = slackMarkdownTotalLimit - totalChars;
    if (remainingBudget <= 0) {
      return false;
    }

    if (value.length <= remainingBudget) {
      blocks.push(value);
      totalChars += value.length;
      return true;
    }

    if (remainingBudget === 1) {
      blocks.push("…");
      totalChars += 1;
      return false;
    }

    blocks.push(`${value.slice(0, remainingBudget - 1)}…`);
    totalChars += remainingBudget;
    return false;
  };

  for (const paragraph of splitMarkdownParagraphs(text)) {
    if (blocks.length >= slackMaxBlocks || totalChars >= slackMarkdownTotalLimit) {
      break;
    }

    if (paragraph.length <= slackMarkdownBlockChunkLimit) {
      if (!appendBlock(paragraph)) {
        break;
      }
      continue;
    }

    let remaining = paragraph;
    while (remaining.length > slackMarkdownBlockChunkLimit) {
      if (blocks.length >= slackMaxBlocks || totalChars >= slackMarkdownTotalLimit) {
        return blocks;
      }

      const chunk = remaining.slice(0, slackMarkdownBlockChunkLimit);
      if (!appendBlock(chunk)) {
        return blocks;
      }

      remaining = remaining.slice(slackMarkdownBlockChunkLimit);
    }

    if (remaining.length > 0 && !appendBlock(remaining)) {
      break;
    }
  }

  return blocks;
};

const truncateForSlackText = (text: string, limit: number): string => {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, Math.max(0, limit - 1))}…`;
};

const splitMarkdownParagraphs = (text: string): string[] => {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
};
