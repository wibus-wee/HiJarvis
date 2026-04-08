import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";

import { autoRetry } from "@grammyjs/auto-retry";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { stream, type StreamFlavor } from "@grammyjs/stream";
import {
  createLogger,
  executePromptInSession,
  loadRuntimeConfig,
  SessionExecutionError,
  type LoadedRuntimeConfig,
  type Logger,
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
  createTelegramSessionId,
  type TelegramMessage,
  type TelegramReplyContext,
} from "./telegram-prompt.js";
import {
  parseTelegramPlatformConfig,
  type TelegramPlatformConfig,
} from "./telegram-config.js";

const telegramGatewayEnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1).optional(),
  JARVIS_TELEGRAM_ALLOWED_CHAT_IDS: z.string().trim().min(1).optional(),
  JARVIS_TELEGRAM_ALLOWED_USERNAMES: z.string().trim().min(1).optional(),
  JARVIS_TELEGRAM_HOST: z.string().trim().min(1).optional(),
  JARVIS_TELEGRAM_PORT: z.coerce.number().int().positive().optional(),
});

type TelegramGatewayRuntimeOptions = {
  configPath: string;
  host?: string;
  port?: number;
};

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
  runtime: LoadedRuntimeConfig;
  telegramConfig: TelegramPlatformConfig;
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

const defaultHost = "0.0.0.0";
const defaultPort = 3001;
const queueEntryTtlMs = 60_000;
const maxQueueSize = 20;

export const startTelegramGateway = async (
  options: TelegramGatewayRuntimeOptions,
): Promise<void> => {
  const runtimeConfig = await loadRuntimeConfig(options.configPath);
  const telegramConfig = parseTelegramPlatformConfig(runtimeConfig.platform);
  const logger = createLogger(runtimeConfig.logging).child({
    component: "telegram_gateway",
  });
  const env = loadTelegramGatewayEnv(process.env);
  const botToken = resolveTelegramBotToken(telegramConfig, env);

  const bot = new Bot<TelegramGatewayContext>(botToken);
  bot.api.config.use(autoRetry());
  bot.use(stream());

  const me = await bot.api.getMe();
  const allowedChatIds = resolveAllowedChatIds(telegramConfig, env);
  const allowedUsernames = resolveAllowedUsernames(telegramConfig, env);
  const state: TelegramGatewayState = {
    runtime: runtimeConfig,
    telegramConfig,
    logger,
    identity: {
      botId: me.id,
      ...(me.username === undefined ? {} : { username: me.username }),
    },
    ...(allowedChatIds === undefined ? {} : { allowedChatIds }),
    ...(allowedUsernames === undefined ? {} : { allowedUsernames }),
    queues: new Map<string, ConversationQueueState>(),
  };

  logger.info("telegram.gateway_initialized", {
    configPath: path.resolve(options.configPath),
    botId: me.id,
    botUsername: me.username,
    allowedChatCount: allowedChatIds?.size ?? 0,
    allowedUsernameCount: allowedUsernames?.size ?? 0,
    logLevel: runtimeConfig.logging.level,
    logToStderr: runtimeConfig.logging.stderr,
    logFilePath: runtimeConfig.logging.filePath,
  });

  registerTelegramHandlers(bot, state);
  const runner = run(bot);
  registerShutdownHandlers(runner, logger);

  startHealthServer({
    host:
      options.host ??
      env.JARVIS_TELEGRAM_HOST ??
      telegramConfig.host ??
      defaultHost,
    port:
      options.port ??
      env.JARVIS_TELEGRAM_PORT ??
      telegramConfig.port ??
      defaultPort,
    logger,
  });

  process.stdout.write(
    `Jar Telegram gateway running in long polling mode using ${path.resolve(options.configPath)}\n`,
  );
  logger.info("telegram.gateway_started", {
    configPath: path.resolve(options.configPath),
  });
};

const registerTelegramHandlers = (
  bot: Bot<TelegramGatewayContext>,
  state: TelegramGatewayState,
): void => {
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
  telegramConfig: TelegramPlatformConfig,
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
  telegramConfig: TelegramPlatformConfig,
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
  telegramConfig: TelegramPlatformConfig,
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
    ...(chatTitle === undefined ? {} : { chatTitle }),
    ...(context.msg.message_thread_id === undefined
      ? {}
      : { threadId: context.msg.message_thread_id }),
    ...(replyTo === undefined ? {} : { replyTo }),
  };
};

const readTelegramMessageText = (
  message: TelegramReadableMessage | undefined,
): string | undefined => {
  return message?.text ?? message?.caption;
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
  const sessionKey = entry.message.threadId === undefined
    ? `telegram:${entry.message.chatId}`
    : `telegram:${entry.message.chatId}:${entry.message.threadId}`;
  const sessionId = createTelegramSessionId(sessionKey);
  const requestLogger = state.logger.child({
    conversationKey,
    sessionId,
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

  await respondInTelegramConversation({
    runtime: state.runtime,
    context: entry.context,
    conversationKey,
    sessionId,
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
    ...(seed.chatTitle === undefined ? {} : { chatTitle: seed.chatTitle }),
    ...(seed.replyTo === undefined ? {} : { replyTo: seed.replyTo }),
  };
};

const respondInTelegramConversation = async (options: {
  runtime: LoadedRuntimeConfig;
  context: TelegramMessageContext;
  conversationKey: string;
  sessionId: string;
  prompt: string;
  skillTriggerText: string;
  logger: Logger;
}): Promise<void> => {
  const startedAt = Date.now();
  const textStream = new AsyncTextDeltaQueue();
  let emittedText = false;
  let turnId: string | undefined;
  let runId: string | undefined;

  const responseTask = executePromptInSession({
    config: options.runtime,
    sessionId: options.sessionId,
    prompt: options.prompt,
    skillTriggerText: options.skillTriggerText,
    logger: options.logger,
    turnTrigger: "platform_event",
    turnInputMetadata: {
      platform: "telegram",
      conversationKey: options.conversationKey,
      chatId: String(options.context.chat.id),
      messageId: options.context.msg.message_id,
    },
    onEvent(event) {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        emittedText = true;
        textStream.push(event.assistantMessageEvent.delta);
      }
    },
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
    turnId = result.turnId;
    runId = result.runId;
    const outputText = result.outputText;

    options.logger.info("telegram.reply_posted", {
      durationMs: Date.now() - startedAt,
      replyChars: outputText.trim().length,
      sessionId: options.sessionId,
      turnId: result.turnId,
      runId: result.runId,
      conversationKey: options.conversationKey,
      streamed: true,
    });
  } catch (error) {
    const settledResult = await responseTask.catch(() => undefined);
    turnId = turnId ?? settledResult?.turnId;
    runId = runId ?? settledResult?.runId;
    const normalizedError = toError(error);
    options.logger.error("telegram.reply_failed", {
      durationMs: Date.now() - startedAt,
      message: normalizedError.message,
      sessionId: options.sessionId,
      turnId: turnId ?? (error instanceof SessionExecutionError ? error.turnId : undefined),
      runId: runId ?? (error instanceof SessionExecutionError ? error.runId : undefined),
      conversationKey: options.conversationKey,
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

const registerShutdownHandlers = (
  runner: RunnerHandle,
  logger: Logger,
): void => {
  const stopRunner = (): void => {
    logger.info("telegram.gateway_stopping");
    runner.stop();
  };

  process.once("SIGINT", stopRunner);
  process.once("SIGTERM", stopRunner);
};

const startHealthServer = (options: {
  host: string;
  port: number;
  logger?: Logger;
}): void => {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    response.statusCode = 404;
    response.end("Not found");
  });

  server.listen(options.port, options.host, () => {
    options.logger?.info("telegram.health_server_started", {
      host: options.host,
      port: options.port,
    });
    process.stdout.write(
      `Telegram health check listening on http://${options.host}:${options.port}\n`,
    );
  });
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
