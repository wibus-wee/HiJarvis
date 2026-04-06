import type { Message, MessageContext } from "chat";

export const createSlackSessionId = (threadId: string): string => {
  return threadId.replaceAll(":", "__").replaceAll("/", "_");
};

export const formatObservedContextBlock = (messages: Message[]): string => {
  if (messages.length === 0) {
    return "Observed channel context before the mention:\n- No recent top-level channel messages were captured within the configured lookback window.";
  }

  const lines = messages.map((message) => {
    const author = message.author.fullName || message.author.userName || message.author.userId;
    const timestamp = message.metadata.dateSent.toISOString();
    return `- [${timestamp}] ${author}: ${message.text}`;
  });

  return `Observed channel context before the mention:\n${lines.join("\n")}`;
};

export const formatQueuedMessagesBlock = (
  context: MessageContext | undefined,
): string => {
  if (!context || context.skipped.length === 0) {
    return "";
  }

  const lines = context.skipped.map((message) => {
    const author = message.author.fullName || message.author.userName || message.author.userId;
    return `- ${author}: ${message.text}`;
  });

  return [
    "Additional user messages that arrived while you were still processing the previous turn:",
    ...lines,
  ].join("\n");
};

export const formatCurrentMessageBlock = (message: Message): string => {
  const author = message.author.fullName || message.author.userName || message.author.userId;

  return [
    "Current user request:",
    `- ${author}: ${message.text}`,
  ].join("\n");
};

export const buildSubscribedThreadPrompt = (
  message: Message,
  context: MessageContext | undefined,
): string => {
  return [
    "You are continuing an existing Slack thread conversation.",
    "The thread history in your session is the source of truth for prior bot interaction.",
    "",
    formatQueuedMessagesBlock(context),
    "",
    formatCurrentMessageBlock(message),
  ]
    .filter((segment) => segment.trim().length > 0)
    .join("\n");
};
