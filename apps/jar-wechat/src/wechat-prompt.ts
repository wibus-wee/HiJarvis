import type { AgentMessage } from "@hijarvis/jar-core";

export type WeChatAttachment = {
  id: string;
  kind: "image";
  url?: string;
  transcriptText: string;
};

export type WeChatMessage = {
  id: string;
  userId: string;
  sentAt: Date;
  type: string;
  text?: string;
  attachments: WeChatAttachment[];
  transcriptText: string;
};

export type WeChatPromptAsset = {
  reference: string;
  messageId: string;
  url?: string;
  included: boolean;
  issue?: string;
};

export const createWeChatSessionId = (conversationId: string): string => {
  return conversationId.replaceAll(":", "__").replaceAll("/", "_");
};

export const hasMeaningfulWeChatText = (messages: WeChatMessage[]): boolean => {
  return messages.some((message) => (message.text ?? "").trim().length > 0);
};

export const hasWeChatImageAttachments = (messages: WeChatMessage[]): boolean => {
  return messages.some((message) => message.attachments.length > 0);
};

export const buildWeChatPrompt = (options: {
  messages: WeChatMessage[];
  assets: WeChatPromptAsset[];
  imageInputEnabled: boolean;
}): string => {
  const bundleHeader = [
    "You are replying inside a WeChat direct conversation.",
    "Your Jar session history is the source of truth for earlier turns in this chat.",
    "Treat the bundled WeChat messages below as one user turn assembled from a short coalescing window.",
  ];

  const imageSummary = buildImageSummaryBlock(options.assets, options.imageInputEnabled);
  const messageLines = options.messages.map((message) => {
    return `- [${message.sentAt.toISOString()}] ${message.userId} (${message.type}): ${message.transcriptText}`;
  });

  return [
    ...bundleHeader,
    "",
    imageSummary,
    "",
    "Bundled WeChat messages for the current turn:",
    ...messageLines,
  ]
    .filter((segment) => segment.trim().length > 0)
    .join("\n");
};

export const sanitizePersistedConversationMessage = (
  message: AgentMessage,
): AgentMessage => {
  if (!("role" in message)) {
    return message;
  }

  if (message.role === "user") {
    if (typeof message.content === "string") {
      return message;
    }

    const textContent = message.content.filter((item) => item.type === "text");
    if (textContent.length === message.content.length) {
      return message;
    }

    return {
      ...message,
      content: textContent.length > 0
        ? textContent
        : [{
          type: "text",
          text: "[Image attachments omitted from persisted session transcript.]",
        }],
    };
  }

  if (message.role === "toolResult") {
    const textContent = message.content.filter((item) => item.type === "text");
    if (textContent.length === message.content.length) {
      return message;
    }

    return {
      ...message,
      content: textContent.length > 0
        ? textContent
        : [{
          type: "text",
          text: "[Image tool output omitted from persisted session transcript.]",
        }],
    };
  }

  return message;
};

const buildImageSummaryBlock = (
  assets: WeChatPromptAsset[],
  imageInputEnabled: boolean,
): string => {
  if (assets.length === 0) {
    return "No image attachments were included in this bundled turn.";
  }

  const statusLine = imageInputEnabled
    ? "WeChat image handling is enabled. Attached image blocks appear later in this same user message."
    : "The configured model does not accept direct image input. Use only the textual image references below.";

  const assetLines = assets.map((asset) => {
    const location = asset.url ?? "(url unavailable)";
    if (asset.included) {
      return `- ${asset.reference}: attached from ${location}`;
    }

    const reason = asset.issue ?? "not attached";
    return `- ${asset.reference}: not attached from ${location} (${reason})`;
  });

  return [
    statusLine,
    "WeChat image references in this bundled turn:",
    ...assetLines,
  ].join("\n");
};
