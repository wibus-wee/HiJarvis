import type { AgentEvent } from "@mariozechner/pi-agent-core";

import type { PromptInput } from "./prompt-executor.js";

export type SlackScope = {
  kind: "slack";
  channelId: string;
  threadTs?: string;
};

export type TelegramScope = {
  kind: "telegram";
  chatId: string;
  messageThreadId?: string;
};

export type LocalThreadScope = {
  kind: "local_thread";
  threadId: string;
};

export type IngressScope = SlackScope | TelegramScope | LocalThreadScope;

export type RoutedScope = {
  platform: "slack" | "telegram" | "cli";
  identityId?: string;
  scope: IngressScope;
};

export type IngressSource = {
  platform: "cli" | "slack" | "telegram";
  identityId?: string;
  transportEventId?: string;
};

export type IngressObservedMessage = {
  id?: string;
  text: string;
  authorId?: string;
  authorName?: string;
  sentAt?: number;
};

export type MessageIngressCommand = {
  kind: "message";
  source: IngressSource;
  routing: RoutedScope;
  actor?: {
    userId?: string;
    username?: string;
    displayName?: string;
  };
  message: {
    text: string;
    id?: string;
    sentAt?: number;
  };
  context?: {
    observedMessages?: IngressObservedMessage[];
    queuedMessages?: IngressObservedMessage[];
    replyTo?: IngressObservedMessage;
  };
  prompt: PromptInput;
  skillTriggerText?: string;
  audit: {
    trigger: "user_input" | "platform_event" | "automation" | "replay";
    triggerKind?: string;
    metadata?: Record<string, unknown>;
  };
  execution?: {
    onEvent?: (event: AgentEvent) => Promise<void> | void;
  };
};

export type SideQuestionIngressCommand = {
  kind: "side_question";
  source: IngressSource;
  parentThreadId: string;
  question: {
    text: string;
  };
};

export type IngressCommand = MessageIngressCommand | SideQuestionIngressCommand;

export type ParsedSideQuestionCommand = SideQuestionIngressCommand;

const btwPattern = /^\/btw\b/i;

export const parseSideQuestionCommand = (options: {
  input: string;
  parentThreadId: string;
  source: IngressSource;
}): ParsedSideQuestionCommand | null => {
  if (!btwPattern.test(options.input)) {
    return null;
  }

  const question = options.input.replace(btwPattern, "").trim();
  if (question.length === 0) {
    return null;
  }

  return {
    kind: "side_question",
    source: options.source,
    parentThreadId: options.parentThreadId,
    question: {
      text: question,
    },
  };
};

export const buildThreadIdFromScope = (target: RoutedScope): string => {
  if (target.scope.kind === "local_thread") {
    return target.scope.threadId;
  }

  if (target.scope.kind === "slack") {
    const base = [
      "identity",
      target.identityId ?? "unknown",
      "slack",
      "channel",
      target.scope.channelId,
    ];
    if (target.scope.threadTs !== undefined) {
      base.push("thread", target.scope.threadTs);
    }
    return base.join("__");
  }

  const base = [
    "identity",
    target.identityId ?? "unknown",
    "telegram",
    "chat",
    target.scope.chatId,
  ];
  if (target.scope.messageThreadId !== undefined) {
    base.push("thread", target.scope.messageThreadId);
  }
  return base.join("__");
};

export const buildDefaultSkillTriggerText = (command: MessageIngressCommand): string => {
  const parts = [
    ...(command.context?.queuedMessages ?? []).map((message) => message.text.trim()),
    command.message.text.trim(),
  ].filter((text) => text.length > 0);
  return parts.join("\n");
};

export const buildTurnInputMetadata = (
  command: MessageIngressCommand,
): Record<string, unknown> => {
  return {
    platform: command.source.platform,
    identityId: command.source.identityId,
    transportEventId: command.source.transportEventId,
    triggerKind: command.audit.triggerKind,
    ...(command.audit.metadata ?? {}),
    scope: command.routing.scope,
    actor: command.actor,
  };
};
