export type WeChatMessage = {
  id: string;
  text: string;
  userId: string;
  sentAt: Date;
  type: string;
};

export const createWeChatSessionId = (conversationId: string): string => {
  return conversationId.replaceAll(":", "__").replaceAll("/", "_");
};

export const formatWeChatQueuedMessagesBlock = (
  skipped: WeChatMessage[],
): string => {
  if (skipped.length === 0) {
    return "";
  }

  const lines = skipped.map((message) => {
    return `- ${message.userId}: ${message.text}`;
  });

  return [
    "Additional WeChat messages that arrived while you were still processing the previous turn:",
    ...lines,
  ].join("\n");
};

export const formatWeChatCurrentMessageBlock = (
  message: WeChatMessage,
): string => {
  return [
    "Current WeChat user request:",
    `- ${message.userId}: ${message.text}`,
    `- messageType: ${message.type}`,
  ].join("\n");
};

export const buildWeChatPrompt = (options: {
  message: WeChatMessage;
  skipped: WeChatMessage[];
}): string => {
  return [
    "You are replying inside a WeChat direct conversation.",
    "Your Jar session history is the source of truth for earlier turns in this chat.",
    "",
    formatWeChatQueuedMessagesBlock(options.skipped),
    "",
    formatWeChatCurrentMessageBlock(options.message),
  ]
    .filter((segment) => segment.trim().length > 0)
    .join("\n");
};
