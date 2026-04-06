import { buildTurnPrompt } from "@hijarvis/jar-core";

export type SlackMessage = {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  sentAt: Date;
};

export const createSlackSessionId = (threadId: string): string => {
  return threadId.replaceAll(":", "__").replaceAll("/", "_");
};

export const formatObservedContextBlock = (messages: SlackMessage[]): string => {
  if (messages.length === 0) {
    return "Observed channel context before the mention:\n- No recent top-level channel messages were captured within the configured lookback window.";
  }

  const lines = messages.map((message) => {
    const author = message.authorName || message.authorId;
    const timestamp = message.sentAt.toISOString();
    return `- [${timestamp}] ${author}: ${message.text}`;
  });

  return `Observed channel context before the mention:\n${lines.join("\n")}`;
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
    ],
    sections: [
      { body: formatQueuedMessagesBlock(skipped) },
      { body: formatCurrentMessageBlock(message) },
    ],
  });
};
