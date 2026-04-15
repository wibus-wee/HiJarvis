import process from "node:process";

import { autoRetry } from "@grammyjs/auto-retry";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { stream, type StreamFlavor } from "@grammyjs/stream";
import {
  buildThreadIdFromScope,
  executeIngressCommand,
  getFaultEnvelope,
  maybeExecuteSideQuestionIngress,
  parseSideQuestionCommand,
  type MessageIngressCommand,
  type LoadedRuntimeConfig,
  type Logger,
  type PlatformIdentityRef,
  type PluginContribution,
  type HookRegistry,
  type ServiceRegistry,
} from "@hijarvis/jar-core";
import {
  Bot,
  type Context,
  GrammyError,
  HttpError,
} from "grammy";
import { z } from "zod";

import {
  buildTelegramPrompt,
  type TelegramMessage,
  type TelegramReplyContext,
} from "./prompt.js";
import {
  parseTelegramPlatformConfig,
  type TelegramPlatformIdentityConfig,
} from "./config.js";

const telegramGatewayEnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1).optional(),
  JARVIS_TELEGRAM_ALLOWED_CHAT_IDS: z.string().trim().min(1).optional(),
  JARVIS_TELEGRAM_ALLOWED_USERNAMES: z.string().trim().min(1).optional(),
});

type TelegramGatewayEnv = z.infer<typeof telegramGatewayEnvSchema>;
type TelegramGatewayContext = StreamFlavor<Context>;
type TelegramMessageContext = TelegramGatewayContext & {
  chat: NonNullable<TelegramGatewayContext["chat"]>;
  msg: NonNullable<TelegramGatewayContext["msg"]>;
};
type TelegramUserLike = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
};
type TelegramReadableMessage = {
  text?: string;
  caption?: string;
};

type TelegramIdentity = {
  botId: number;
  username?: string;
};

type TriggerKind = "private_chat" | "reply_to_bot" | "mention";

type TelegramMessageSeed = {
  id: string;
  messageId: number;
  text: string;
  authorId: string;
  authorName: string;
  sentAt: Date;
  chatId: string;
  chatType: "private" | "group";
  chatTitle?: string;
  threadId?: number;
  replyTo?: TelegramReplyContext;
};

type QueueEntry = {
  context: TelegramMessageContext;
  kind: TriggerKind;
  message: TelegramMessageSeed;
  receivedAt: number;
};

type ConversationQueueState = {
  running: boolean;
  entries: QueueEntry[];
};

type TelegramGatewayState = {
  identityConfig: PlatformIdentityRef;
  runtime: LoadedRuntimeConfig;
  hooks: HookRegistry;
  services: ServiceRegistry;
  telegramConfig: TelegramPlatformIdentityConfig;
  logger: Logger;
  identity: TelegramIdentity;
  allowedChatIds?: Set<string>;
  allowedUsernames?: Set<string>;
  queues: Map<string, ConversationQueueState>;
};

type AsyncIteratorWaiter = {
  resolve: (value: IteratorResult<string>) => void;
  reject: (error: Error) => void;
};

const queueEntryTtlMs = 60_000;
const maxQueueSize = 20;

export type StopFn = () => Promise<void>;

export const startTelegramIdentities = async (
  config: LoadedRuntimeConfig,
  hooks: HookRegistry,
  services: ServiceRegistry,
  logger: Logger,
): Promise<StopFn[]> => {
  const env = loadTelegramGatewayEnv(process.env);
  const telegramConfigs = parseTelegramPlatformConfig(config.platform);
  const identities = Object.values(config.platformIdentities).filter(
    (identity): identity is PlatformIdentityRef => identity.platform === "telegram",
  );

  const stops: StopFn[] = [];

  for (const identityConfig of identities) {
    const telegramConfig = telegramConfigs[identityConfig.id];
    if (telegramConfig === undefined) {
      throw new Error(`Missing Telegram runtime config for identity "${identityConfig.id}"`);
    }

    const botToken = resolveTelegramBotToken(telegramConfig, env);
    const bot = new Bot<TelegramGatewayContext>(botToken);
    bot.api.config.use(autoRetry());
    bot.use(stream());

    const me = await bot.api.getMe();
    const allowedChatIds = resolveAllowedChatIds(telegramConfig, env);
    const allowedUsernames = resolveAllowedUsernames(telegramConfig, env);
    const identityLogger = logger.child({ identityId: identityConfig.id, entityId: identityConfig.entityId });
    const state: TelegramGatewayState = {
      identityConfig,
      runtime: config,
      hooks,
      services,
      telegramConfig,
      logger: identityLogger,
      identity: {
        botId: me.id,
        username: me.username,
      },
      allowedChatIds,
      allowedUsernames,
      queues: new Map<string, ConversationQueueState>(),
    };

    identityLogger.info("telegram.gateway_initialized", {
      botId: me.id,
      botUsername: me.username,
      allowedChatCount: allowedChatIds?.size ?? 0,
      allowedUsernameCount: allowedUsernames?.size ?? 0,
    });

    registerTelegramHandlers(bot, state);
    const runner = run(bot);

    process.stdout.write(
      `Jar Telegram identity ${identityConfig.id} running in long polling mode\n`,
    );
    identityLogger.info("telegram.gateway_started");

    stops.push(async () => {
      identityLogger.info("telegram.gateway_stopping");
      runner.stop();
    });
  }

  return stops;
};

const registerTelegramHandlers = (
  bot: Bot<TelegramGatewayContext>,
  state: TelegramGatewayState,
): void => {
  bot.command("btw", async (context) => {
    const messageContext = context as TelegramMessageContext;
    if (!isAllowedChat(messageContext.chat.id, state)) {
      return;
    }

    if (!isAllowedUsername(messageContext.msg.from?.username, state)) {
      return;
    }

    const text = readTelegramMessageText(messageContext.msg);
    const parsed = text ? parseSideQuestionCommand({
      input: text,
      parentThreadId: "preview",
      source: {
        platform: "telegram",
        identityId: state.identityConfig.id,
      },
    }) : null;
    if (parsed === null) {
      await messageContext.reply("Usage: /btw <question>", createReplyOptions(messageContext));
      return;
    }

    const normalized = normalizeTelegramMessageSeed(messageContext, state.identity);
    if (!normalized) {
      await messageContext.reply(
        "I could not read that /btw question.",
        createReplyOptions(messageContext),
      );
      return;
    }

    const threadId = buildThreadIdFromScope({
      platform: "telegram",
      identityId: state.identityConfig.id,
      scope: normalized.threadId === undefined
        ? {
          kind: "telegram",
          chatId: normalized.chatId,
        }
        : {
          kind: "telegram",
          chatId: normalized.chatId,
          messageThreadId: String(normalized.threadId),
        },
    });
    const requestLogger = state.logger.child({
      conversationKey: buildConversationKey(normalized.chatId, normalized.threadId),
      threadId,
      entityId: state.identityConfig.entityId,
      chatId: normalized.chatId,
      messageId: normalized.messageId,
      trigger: "side_question",
    });

    try {
      const result = await executeIngressCommand({
        config: state.runtime,
        hooks: state.hooks,
        logger: requestLogger,
        command: {
          kind: "side_question",
          source: {
            platform: "telegram",
            identityId: state.identityConfig.id,
          },
          parentThreadId: threadId,
          question: {
            text: parsed.question.text,
          },
        },
      });
      if (result.kind !== "side_question") {
        throw new Error("Telegram /btw expected a side-question execution result.");
      }
      await messageContext.reply(
        result.outputText.trim().length > 0
          ? result.outputText
          : "I do not have a side-question reply.",
        createReplyOptions(messageContext),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      requestLogger.error("telegram.side_question_failed", {
        threadId,
        chatId: normalized.chatId,
        messageId: normalized.messageId,
        message,
      });
      await messageContext.reply(
        message.includes("No live parent thread available")
          ? "No active live thread is available for /btw in this chat yet."
          : "I ran into an error while answering that /btw question.",
        createReplyOptions(messageContext),
      );
    }
  });

  bot.command(["start", "help"], async (context) => {
    const messageContext = context as TelegramMessageContext;
    if (!isAllowedChat(messageContext.chat.id, state)) {
      return;
    }

    await messageContext.reply(
      "Jar Telegram gateway is ready. Send a private message, or mention/reply to the bot in a group.",
      createReplyOptions(messageContext),
    );
  });

  bot.on("message", async (context) => {
    const messageContext = context as TelegramMessageContext;

    if (!isAllowedChat(messageContext.chat.id, state)) {
      state.logger.debug("telegram.event_ignored", {
        reason: "chat_not_allowed",
        chatId: String(messageContext.chat.id),
      });
      return;
    }

    if (!isAllowedUsername(messageContext.msg.from?.username, state)) {
      state.logger.debug("telegram.event_ignored", {
        reason: "username_not_allowed",
        chatId: String(messageContext.chat.id),
        username: messageContext.msg.from?.username,
      });
      return;
    }

    if (isTelegramSideQuestionCommand(readTelegramMessageText(messageContext.msg))) {
      state.logger.debug("telegram.event_ignored", {
        reason: "side_question_command",
        chatId: String(messageContext.chat.id),
        messageId: messageContext.msg.message_id,
      });
      return;
    }

    const trigger = classifyMessageTrigger(messageContext, state.identity);
    if (!trigger) {
      state.logger.debug("telegram.event_ignored", {
        reason: "not_triggered",
        chatId: String(messageContext.chat.id),
        messageId: messageContext.msg.message_id,
      });
      return;
    }

    const normalized = normalizeTelegramMessageSeed(messageContext, state.identity);
    if (!normalized) {
      state.logger.debug("telegram.event_ignored", {
        reason: "unsupported_message",
        chatId: String(messageContext.chat.id),
        messageId: messageContext.msg.message_id,
      });
      return;
    }

    const conversationKey = buildConversationKey(
      normalized.chatId,
      normalized.threadId,
    );

    state.logger.info("telegram.event_received", {
      trigger,
      conversationKey,
      chatId: normalized.chatId,
      messageId: normalized.messageId,
      textChars: normalized.text.length,
    });

    enqueueMessage(state, conversationKey, {
      context: messageContext,
      kind: trigger,
      message: normalized,
      receivedAt: Date.now(),
    });
  });

  bot.catch((error) => {
    const context = error.ctx;
    if (error.error instanceof GrammyError) {
      state.logger.error("telegram.middleware_failed", {
        chatId: context.chat?.id !== undefined ? String(context.chat.id) : undefined,
        messageId: context.msg?.message_id,
        message: error.error.description,
      });
      return;
    }

    if (error.error instanceof HttpError) {
      state.logger.error("telegram.middleware_failed", {
        chatId: context.chat?.id !== undefined ? String(context.chat.id) : undefined,
        messageId: context.msg?.message_id,
        message: error.error.message,
      });
      return;
    }

    const message = error.error instanceof Error
      ? error.error.message
      : String(error.error);

    state.logger.error("telegram.middleware_failed", {
      chatId: context.chat?.id !== undefined ? String(context.chat.id) : undefined,
      messageId: context.msg?.message_id,
      message,
    });
  });
};

const resolveTelegramBotToken = (
  telegramConfig: TelegramPlatformIdentityConfig,
  env: TelegramGatewayEnv,
): string => {
  const botToken =
    env.TELEGRAM_BOT_TOKEN ?? telegramConfig.botToken ?? "";

  if (!botToken) {
    throw new Error("Missing Telegram credentials: TELEGRAM_BOT_TOKEN");
  }

  return botToken;
};

const resolveAllowedChatIds = (
  telegramConfig: TelegramPlatformIdentityConfig,
  env: TelegramGatewayEnv,
): Set<string> | undefined => {
  if (env.JARVIS_TELEGRAM_ALLOWED_CHAT_IDS) {
    const values = env.JARVIS_TELEGRAM_ALLOWED_CHAT_IDS
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    return values.length > 0 ? new Set(values) : undefined;
  }

  const configured = telegramConfig.allowedChatIds;
  if (!configured || configured.length === 0) {
    return undefined;
  }

  return new Set(configured);
};

const resolveAllowedUsernames = (
  telegramConfig: TelegramPlatformIdentityConfig,
  env: TelegramGatewayEnv,
): Set<string> | undefined => {
  if (env.JARVIS_TELEGRAM_ALLOWED_USERNAMES) {
    const values = env.JARVIS_TELEGRAM_ALLOWED_USERNAMES
      .split(",")
      .map((value) => value.trim().replace(/^@/, "").toLowerCase())
      .filter((value) => value.length > 0);

    return values.length > 0 ? new Set(values) : undefined;
  }

  const configured = telegramConfig.allowedUsernames;
  if (!configured || configured.length === 0) {
    return undefined;
  }

  return new Set(configured);
};

const isAllowedChat = (
  chatId: number,
  state: TelegramGatewayState,
): boolean => {
  if (!state.allowedChatIds) {
    return true;
  }

  return state.allowedChatIds.has(String(chatId));
};

const isAllowedUsername = (
  username: string | undefined,
  state: TelegramGatewayState,
): boolean => {
  if (!state.allowedUsernames) {
    return true;
  }

  if (!username) {
    return false;
  }

  return state.allowedUsernames.has(username.toLowerCase());
};

const classifyMessageTrigger = (
  context: TelegramMessageContext,
  identity: TelegramIdentity,
): TriggerKind | null => {
  if (context.chat.type === "private") {
    return "private_chat";
  }

  const replyTo = context.msg.reply_to_message;
  if (replyTo?.from?.id === identity.botId) {
    return "reply_to_bot";
  }

  const text = readTelegramMessageText(context.msg);
  if (!text) {
    return null;
  }

  const username = identity.username;
  if (!username) {
    return null;
  }

  const normalizedMention = `@${username.toLowerCase()}`;
  return text.toLowerCase().includes(normalizedMention) ? "mention" : null;
};

const normalizeTelegramMessageSeed = (
  context: TelegramMessageContext,
  identity: TelegramIdentity,
): TelegramMessageSeed | null => {
  const text = readTelegramMessageText(context.msg);
  const from = context.msg.from;

  if (!text || !from) {
    return null;
  }

  const sentAt = new Date(context.msg.date * 1000);
  const normalizedText = stripBotMention(text, identity.username);

  if (!normalizedText) {
    return null;
  }

  const chatTitle = readChatTitle(context.chat);
  const replyTo = readReplyContext(context.msg.reply_to_message);

  return {
    id: String(context.msg.message_id),
    messageId: context.msg.message_id,
    text: normalizedText,
    authorId: String(from.id),
    authorName: formatTelegramAuthorName(from),
    sentAt,
    chatId: String(context.chat.id),
    chatType: context.chat.type === "private" ? "private" : "group",
    chatTitle,
    threadId: context.msg.message_thread_id,
    replyTo,
  };
};

const readTelegramMessageText = (
  message: TelegramReadableMessage | undefined,
): string | undefined => {
  return message?.text ?? message?.caption;
};

export const isTelegramSideQuestionCommand = (text: string | undefined): boolean => {
  return text !== undefined && parseSideQuestionCommand({
    input: text,
    parentThreadId: "preview",
    source: { platform: "telegram" },
  }) !== null;
};

const stripBotMention = (
  text: string,
  username: string | undefined,
): string => {
  if (!username) {
    return text.trim();
  }

  return text.replaceAll(`@${username}`, "").trim();
};

const formatTelegramAuthorName = (
  from: TelegramUserLike,
): string => {
  const parts = [from.first_name, from.last_name].filter(
    (part): part is string => Boolean(part),
  );

  if (parts.length > 0) {
    return parts.join(" ");
  }

  return from.username ?? String(from.id);
};

const readChatTitle = (
  chat: TelegramMessageContext["chat"],
): string | undefined => {
  switch (chat.type) {
    case "group":
    case "supergroup":
      return chat.title;
    case "private":
      return undefined;
  }
};

const readReplyContext = (
  replyTo: TelegramMessageContext["msg"]["reply_to_message"],
): TelegramReplyContext | undefined => {
  const text = replyTo ? readTelegramMessageText(replyTo) : undefined;
  const from = replyTo?.from;
  if (!replyTo || !text || !from) {
    return undefined;
  }

  return {
    authorId: String(from.id),
    authorName: formatTelegramAuthorName(from),
    text,
    sentAt: new Date(replyTo.date * 1000),
  };
};

const enqueueMessage = (
  state: TelegramGatewayState,
  conversationKey: string,
  entry: QueueEntry,
): void => {
  const queue = getConversationQueue(state, conversationKey);
  const now = Date.now();

  queue.entries = queue.entries.filter(
    (queued) => now - queued.receivedAt <= queueEntryTtlMs,
  );
  queue.entries.push(entry);

  if (queue.entries.length > maxQueueSize) {
    queue.entries.splice(0, queue.entries.length - maxQueueSize);
  }

  state.logger.info("telegram.queue_enqueued", {
    conversationKey,
    trigger: entry.kind,
    queueSize: queue.entries.length,
    chatId: entry.message.chatId,
    messageId: entry.message.messageId,
  });

  if (!queue.running) {
    queue.running = true;
    void drainQueue(state, conversationKey, queue);
  }
};

const drainQueue = async (
  state: TelegramGatewayState,
  conversationKey: string,
  queue: ConversationQueueState,
): Promise<void> => {
  try {
    while (queue.entries.length > 0) {
      const now = Date.now();
      queue.entries = queue.entries.filter(
        (queued) => now - queued.receivedAt <= queueEntryTtlMs,
      );

      if (queue.entries.length === 0) {
        break;
      }

      const batch = queue.entries.splice(0, queue.entries.length);
      if (batch.length === 0) {
        continue;
      }

      const current = batch[batch.length - 1]!;
      const skipped = batch.slice(0, -1).map((item) => item.message);

      state.logger.info("telegram.queue_draining", {
        conversationKey,
        batchSize: batch.length,
        skippedCount: skipped.length,
        trigger: current.kind,
      });

      try {
        await handleQueueEntry(state, conversationKey, current, skipped);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.logger.error("telegram.queue_entry_failed", {
          conversationKey,
          message,
        });
      }
    }
  } finally {
    queue.running = false;
  }
};

const handleQueueEntry = async (
  state: TelegramGatewayState,
  conversationKey: string,
  entry: QueueEntry,
  skipped: TelegramMessageSeed[],
): Promise<void> => {
  const threadId = buildThreadIdFromScope({
    platform: "telegram",
    identityId: state.identityConfig.id,
    scope: entry.message.threadId === undefined
      ? {
        kind: "telegram",
        chatId: entry.message.chatId,
      }
      : {
        kind: "telegram",
        chatId: entry.message.chatId,
        messageThreadId: String(entry.message.threadId),
      },
  });
  const requestLogger = state.logger.child({
    conversationKey,
    threadId,
    entityId: state.identityConfig.entityId,
    chatId: entry.message.chatId,
    messageId: entry.message.messageId,
    trigger: entry.kind,
  });
  const current = materializeTelegramMessage(entry.message);
  const skippedMessages = skipped.map(materializeTelegramMessage);
  const prompt = buildTelegramPrompt({
    message: current,
    skipped: skippedMessages,
    chatType: current.chatTitle || entry.message.chatType === "group"
      ? "group"
      : "private",
  });

  requestLogger.info("telegram.request_started", {
    skippedCount: skippedMessages.length,
    currentAuthor: current.authorName,
    promptChars: prompt.length,
  });

  const sideQuestion = await maybeExecuteSideQuestionIngress({
    config: state.runtime,
    parentThreadId: threadId,
    input: current.text,
    source: {
      platform: "telegram",
      identityId: state.identityConfig.id,
    },
    logger: requestLogger,
  });

  if (sideQuestion.handled) {
    await entry.context.reply(
      sideQuestion.result.outputText.trim().length > 0
        ? sideQuestion.result.outputText
        : "I do not have a side-question reply.",
      createReplyOptions(entry.context),
    );
    return;
  }

  await respondInTelegramConversation({
    state,
    context: entry.context,
    conversationKey,
    threadId,
    prompt,
    skillTriggerText: buildTelegramSkillTriggerText(current, skippedMessages),
    logger: requestLogger,
  });
};

const materializeTelegramMessage = (
  seed: TelegramMessageSeed,
): TelegramMessage => {
  return {
    id: seed.id,
    text: seed.text,
    authorId: seed.authorId,
    authorName: seed.authorName,
    sentAt: seed.sentAt,
    chatTitle: seed.chatTitle,
    replyTo: seed.replyTo,
  };
};

const respondInTelegramConversation = async (options: {
  state: TelegramGatewayState;
  context: TelegramMessageContext;
  conversationKey: string;
  threadId: string;
  prompt: string;
  skillTriggerText: string;
  logger: Logger;
}): Promise<void> => {
  const startedAt = Date.now();
  const textStream = new AsyncTextDeltaQueue();
  let emittedText = false;
  let turnId: string | undefined;
  let runId: string | undefined;

  // Retrieve contributions lazily — by the time events fire, jar-runtime has
  // already registered them in the services registry after manager.load().
  const contributions = options.state.services.get<PluginContribution>("pluginContributions");

  const responseTask = executeIngressCommand({
    config: options.state.runtime,
    hooks: options.state.hooks,
    logger: options.logger,
    pluginOverrides: contributions ?? { skills: [], overlays: [], tools: [] },
    command: {
      kind: "message",
      source: {
        platform: "telegram",
      },
      routing: {
        platform: "telegram",
        scope: options.context.msg.message_thread_id === undefined
          ? {
            kind: "telegram",
            chatId: String(options.context.chat.id),
          }
          : {
            kind: "telegram",
            chatId: String(options.context.chat.id),
            messageThreadId: String(options.context.msg.message_thread_id),
          },
      },
      message: {
        text: options.skillTriggerText,
        id: String(options.context.msg.message_id),
      },
      prompt: options.prompt,
      skillTriggerText: options.skillTriggerText,
      audit: {
        trigger: "platform_event",
        triggerKind: "telegram_message",
        metadata: {
          conversationKey: options.conversationKey,
          chatId: String(options.context.chat.id),
          messageId: options.context.msg.message_id,
        },
      },
      execution: {
        onEvent(event) {
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            emittedText = true;
            textStream.push(event.assistantMessageEvent.delta);
          }
        },
      },
    } satisfies MessageIngressCommand,
  })
    .then((result) => {
      const { outputText } = result;
      if (!emittedText) {
        textStream.push(
          outputText.trim().length > 0
            ? outputText
            : "I finished processing that, but I do not have a textual reply to send.",
        );
      }

      textStream.close();
      return result;
    })
    .catch((error: unknown) => {
      textStream.fail(toError(error));
      throw error;
    });

  try {
    await options.context.replyWithStream(
      textStream,
      createReplyOptions(options.context),
    );
    const result = await responseTask;
    if (result.kind !== "message") {
      throw new Error("Telegram reply generation expected a message execution result.");
    }
    turnId = result.turnId;
    runId = result.runId;
    const outputText = result.outputText;

    options.logger.info("telegram.reply_posted", {
      durationMs: Date.now() - startedAt,
      replyChars: outputText.trim().length,
      threadId: options.threadId,
      turnId: result.turnId,
      runId: result.runId,
      conversationKey: options.conversationKey,
      streamed: true,
    });
  } catch (error) {
    const settledResult = await responseTask.catch(() => undefined);
    if (settledResult?.kind === "message") {
      turnId = turnId ?? settledResult.turnId;
      runId = runId ?? settledResult.runId;
    }
    const normalizedError = toError(error);
    const envelope = getFaultEnvelope(error);
    options.logger.error("telegram.reply_failed", {
      durationMs: Date.now() - startedAt,
      message: normalizedError.message,
      threadId: options.threadId,
      turnId: turnId ?? envelope?.turnId,
      runId: runId ?? envelope?.runId,
      conversationKey: options.conversationKey,
      fault: envelope?.fault,
      phase: envelope?.phase,
    });

    if (!emittedText) {
      await options.context.reply(
        "I ran into an error while processing that request. Please try again in the same chat.",
        createReplyOptions(options.context),
      );
    }
  }
};

const buildTelegramSkillTriggerText = (
  currentMessage: TelegramMessage,
  skipped: TelegramMessage[],
): string => {
  return [...skipped, currentMessage]
    .map((message) => message.text.trim())
    .filter((text) => text.length > 0)
    .join("\n");
};

const createReplyOptions = (
  context: TelegramMessageContext,
): Record<string, number | { message_id: number }> => {
  const options: Record<string, number | { message_id: number }> = {
    reply_parameters: {
      message_id: context.msg.message_id,
    },
  };

  if (context.msg.message_thread_id !== undefined) {
    options.message_thread_id = context.msg.message_thread_id;
  }

  return options;
};

const getConversationQueue = (
  state: TelegramGatewayState,
  conversationKey: string,
): ConversationQueueState => {
  const existing = state.queues.get(conversationKey);
  if (existing) {
    return existing;
  }

  const created: ConversationQueueState = {
    running: false,
    entries: [],
  };
  state.queues.set(conversationKey, created);
  return created;
};

const buildConversationKey = (
  chatId: string,
  threadId: number | undefined,
): string => {
  return threadId === undefined ? chatId : `${chatId}:${threadId}`;
};

const loadTelegramGatewayEnv = (
  rawEnv: NodeJS.ProcessEnv,
): TelegramGatewayEnv => {
  return telegramGatewayEnvSchema.parse(rawEnv);
};

const toError = (error: unknown): Error => {
  return error instanceof Error ? error : new Error(String(error));
};

class AsyncTextDeltaQueue implements AsyncIterable<string> {
  private readonly chunks: string[] = [];
  private readonly waiters: AsyncIteratorWaiter[] = [];
  private completed = false;
  private failure: Error | null = null;

  push(chunk: string): void {
    if (!chunk) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({
        done: false,
        value: chunk,
      });
      return;
    }

    this.chunks.push(chunk);
  }

  close(): void {
    this.completed = true;

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve({
        done: true,
        value: undefined,
      });
    }
  }

  fail(error: Error): void {
    this.failure = error;

    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async (): Promise<IteratorResult<string>> => {
        if (this.chunks.length > 0) {
          return {
            done: false,
            value: this.chunks.shift()!,
          };
        }

        if (this.failure) {
          throw this.failure;
        }

        if (this.completed) {
          return {
            done: true,
            value: undefined,
          };
        }

        return new Promise<IteratorResult<string>>((resolve, reject) => {
          this.waiters.push({
            resolve,
            reject,
          });
        });
      },
    };
  }
}
