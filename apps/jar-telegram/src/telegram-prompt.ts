export type TelegramReplyContext = {
  authorId: string;
  authorName: string;
  text: string;
  sentAt: Date;
};

export type TelegramMessage = {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  sentAt: Date;
  chatTitle?: string;
  replyTo?: TelegramReplyContext;
};

export const createTelegramSessionId = (conversationId: string): string => {
  return conversationId.replaceAll(":", "__").replaceAll("/", "_");
};

export const parseTelegramSideQueryCommand = (
  text: string,
): { entityId: string; question: string } | null => {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/btw(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/i);
  if (!match) {
    return null;
  }

  const entityId = match[1]?.trim();
  const question = match[2]?.trim();
  if (!entityId || !question) {
    return null;
  }

  return { entityId, question };
};

export const formatTelegramReplyContextBlock = (
  replyTo: TelegramReplyContext | undefined,
): string => {
  if (!replyTo) {
    return "";
  }

  return [
    "Telegram reply context for the current message:",
    `- [${replyTo.sentAt.toISOString()}] ${replyTo.authorName || replyTo.authorId}: ${replyTo.text}`,
  ].join("\n");
};

export const formatTelegramQueuedMessagesBlock = (
  skipped: TelegramMessage[],
): string => {
  if (skipped.length === 0) {
    return "";
  }

  const lines = skipped.map((message) => {
    return `- ${message.authorName || message.authorId}: ${message.text}`;
  });

  return [
    "Additional Telegram messages that arrived while you were still processing the previous turn:",
    ...lines,
  ].join("\n");
};

export const formatTelegramCurrentMessageBlock = (
  message: TelegramMessage,
): string => {
  return [
    "Current Telegram user request:",
    `- ${message.authorName || message.authorId}: ${message.text}`,
  ].join("\n");
};

export const buildTelegramPrompt = (options: {
  message: TelegramMessage;
  skipped: TelegramMessage[];
  chatType: "private" | "group";
}): string => {
  const header = options.chatType === "private"
    ? [
      "You are replying inside a Telegram private chat.",
      "Your Jar session history is the source of truth for earlier turns.",
    ]
    : [
      "You are replying inside a Telegram group or supergroup conversation.",
      "Telegram Bot API does not provide full history here, so only use the explicit reply context, queued messages, and your Jar session history.",
    ];

  const chatTitleLine = options.message.chatTitle
    ? `Telegram chat title: ${options.message.chatTitle}`
    : "";

  return [
    ...header,
    chatTitleLine,
    "",
    formatTelegramReplyContextBlock(options.message.replyTo),
    "",
    formatTelegramQueuedMessagesBlock(options.skipped),
    "",
    formatTelegramCurrentMessageBlock(options.message),
  ]
    .filter((segment) => segment.trim().length > 0)
    .join("\n");
};
