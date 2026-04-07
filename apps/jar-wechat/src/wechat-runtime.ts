import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";

import {
  createLogger,
  executePromptInSession,
  loadRuntimeConfig,
  type LoadedRuntimeConfig,
  type Logger,
} from "@hijarvis/jar-core";
import { WeixinBot } from "@pinixai/weixin-bot";
import { z } from "zod";

import {
  buildWeChatPrompt,
  createWeChatSessionId,
  type WeChatMessage,
} from "./wechat-prompt.js";
import {
  parseWeChatPlatformConfig,
  type WeChatPlatformConfig,
} from "./wechat-config.js";

const wechatGatewayEnvSchema = z.object({
  JARVIS_WECHAT_BASE_URL: z.string().trim().min(1).optional(),
  JARVIS_WECHAT_TOKEN_PATH: z.string().trim().min(1).optional(),
  JARVIS_WECHAT_HOST: z.string().trim().min(1).optional(),
  JARVIS_WECHAT_PORT: z.coerce.number().int().positive().optional(),
});

type WeChatGatewayRuntimeOptions = {
  configPath: string;
  host?: string;
  port?: number;
};

type WeChatGatewayEnv = z.infer<typeof wechatGatewayEnvSchema>;
type WeChatInboundMessage = Parameters<
  Parameters<WeixinBot["onMessage"]>[0]
>[0];

type QueueEntry = {
  message: WeChatMessage;
  rawMessage: WeChatInboundMessage;
  receivedAt: number;
};

type ConversationQueueState = {
  running: boolean;
  entries: QueueEntry[];
};

type WeChatGatewayState = {
  runtime: LoadedRuntimeConfig;
  wechatConfig: WeChatPlatformConfig;
  logger: Logger;
  bot: WeixinBot;
  queues: Map<string, ConversationQueueState>;
};

const defaultHost = "0.0.0.0";
const defaultPort = 3002;
const queueEntryTtlMs = 60_000;
const maxQueueSize = 20;

export const startWeChatGateway = async (
  options: WeChatGatewayRuntimeOptions,
): Promise<void> => {
  const runtimeConfig = await loadRuntimeConfig(options.configPath);
  const wechatConfig = parseWeChatPlatformConfig(runtimeConfig.platform);
  const logger = createLogger(runtimeConfig.logging).child({
    component: "wechat_gateway",
  });
  const env = loadWeChatGatewayEnv(process.env);
  const bot = createWeChatBot(wechatConfig, env, logger);

  await bot.login();

  const state: WeChatGatewayState = {
    runtime: runtimeConfig,
    wechatConfig,
    logger,
    bot,
    queues: new Map<string, ConversationQueueState>(),
  };

  logger.info("wechat.gateway_initialized", {
    configPath: path.resolve(options.configPath),
    baseUrl: resolveBaseUrl(wechatConfig, env),
    tokenPath: resolveTokenPath(wechatConfig, env),
    logLevel: runtimeConfig.logging.level,
    logToStderr: runtimeConfig.logging.stderr,
    logFilePath: runtimeConfig.logging.filePath,
  });

  registerWeChatHandlers(state);
  registerShutdownHandlers(bot, logger);

  startHealthServer({
    host: options.host ?? env.JARVIS_WECHAT_HOST ?? wechatConfig.host ?? defaultHost,
    port: options.port ?? env.JARVIS_WECHAT_PORT ?? wechatConfig.port ?? defaultPort,
    logger,
  });

  process.stdout.write(
    `Jar WeChat gateway running in long polling mode using ${path.resolve(options.configPath)}\n`,
  );
  logger.info("wechat.gateway_started", {
    configPath: path.resolve(options.configPath),
  });

  await bot.run();
};

const createWeChatBot = (
  wechatConfig: WeChatPlatformConfig,
  env: WeChatGatewayEnv,
  logger: Logger,
): WeixinBot => {
  const baseUrl = resolveBaseUrl(wechatConfig, env);
  const tokenPath = resolveTokenPath(wechatConfig, env);

  return new WeixinBot({
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(tokenPath === undefined ? {} : { tokenPath }),
    onError(error) {
      const normalizedError = toError(error);
      logger.error("wechat.sdk_failed", {
        message: normalizedError.message,
      });
    },
  });
};

const registerWeChatHandlers = (state: WeChatGatewayState): void => {
  state.bot.onMessage((message) => {
    const normalized = normalizeWeChatMessage(message);
    if (!normalized) {
      state.logger.debug("wechat.event_ignored", {
        reason: "unsupported_message",
        userId: message.userId,
        type: message.type,
      });
      return;
    }

    const conversationKey = normalized.userId;
    state.logger.info("wechat.event_received", {
      conversationKey,
      userId: normalized.userId,
      messageType: normalized.type,
      textChars: normalized.text.length,
    });

    enqueueMessage(state, conversationKey, {
      message: normalized,
      rawMessage: message,
      receivedAt: Date.now(),
    });
  });
};

const normalizeWeChatMessage = (
  message: WeChatInboundMessage,
): WeChatMessage | null => {
  const text = readWeChatMessageText(message);
  if (!text) {
    return null;
  }

  return {
    id: createWeChatMessageId(message),
    userId: message.userId,
    text,
    type: message.type,
    sentAt: message.timestamp,
  };
};

const readWeChatMessageText = (
  message: WeChatInboundMessage,
): string | null => {
  const normalized = message.text.trim();
  if (normalized.length > 0) {
    return normalized;
  }

  if (message.type !== "text") {
    return `[${message.type} message]`;
  }

  return null;
};

const createWeChatMessageId = (message: WeChatInboundMessage): string => {
  const rawMessage = message.raw as { id?: string; msgid?: string | number };
  const explicitId = rawMessage.id ?? rawMessage.msgid;

  if (explicitId !== undefined) {
    return String(explicitId);
  }

  return `${message.userId}:${message.timestamp.getTime()}`;
};

const enqueueMessage = (
  state: WeChatGatewayState,
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

  state.logger.info("wechat.queue_enqueued", {
    conversationKey,
    queueSize: queue.entries.length,
    userId: entry.message.userId,
    messageId: entry.message.id,
  });

  if (!queue.running) {
    queue.running = true;
    void drainQueue(state, conversationKey, queue);
  }
};

const drainQueue = async (
  state: WeChatGatewayState,
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

      state.logger.info("wechat.queue_draining", {
        conversationKey,
        batchSize: batch.length,
        skippedCount: skipped.length,
      });

      try {
        await handleQueueEntry(state, conversationKey, current, skipped);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.logger.error("wechat.queue_entry_failed", {
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
  state: WeChatGatewayState,
  conversationKey: string,
  entry: QueueEntry,
  skipped: WeChatMessage[],
): Promise<void> => {
  const sessionId = createWeChatSessionId(`wechat:${entry.message.userId}`);
  const requestLogger = state.logger.child({
    conversationKey,
    sessionId,
    userId: entry.message.userId,
    messageId: entry.message.id,
    messageType: entry.message.type,
  });
  const prompt = buildWeChatPrompt({
    message: entry.message,
    skipped,
  });

  requestLogger.info("wechat.request_started", {
    skippedCount: skipped.length,
    promptChars: prompt.length,
  });

  await respondInWeChatConversation({
    runtime: state.runtime,
    bot: state.bot,
    rawMessage: entry.rawMessage,
    conversationKey,
    sessionId,
    prompt,
    logger: requestLogger,
  });
};

const respondInWeChatConversation = async (options: {
  runtime: LoadedRuntimeConfig;
  bot: WeixinBot;
  rawMessage: WeChatInboundMessage;
  conversationKey: string;
  sessionId: string;
  prompt: string;
  logger: Logger;
}): Promise<void> => {
  const startedAt = Date.now();

  try {
    await options.bot.sendTyping(options.rawMessage.userId);
  } catch (error) {
    options.logger.debug("wechat.typing_failed", {
      message: toError(error).message,
    });
  }

  try {
    const { outputText } = await executePromptInSession({
      ...options.runtime.runtime,
      toolOptions: options.runtime.toolOptions,
      sessionsRootDir: options.runtime.sessions.rootDir,
      sessionId: options.sessionId,
      prompt: options.prompt,
      logger: options.logger,
      writers: {
        stderr: process.stderr,
      },
    });

    const replyText = outputText.trim().length > 0
      ? outputText
      : "I finished processing that, but I do not have a textual reply to send.";

    await options.bot.reply(options.rawMessage, replyText);

    options.logger.info("wechat.reply_posted", {
      durationMs: Date.now() - startedAt,
      replyChars: replyText.trim().length,
      sessionId: options.sessionId,
      conversationKey: options.conversationKey,
    });
  } catch (error) {
    const normalizedError = toError(error);
    options.logger.error("wechat.reply_failed", {
      durationMs: Date.now() - startedAt,
      message: normalizedError.message,
      sessionId: options.sessionId,
      conversationKey: options.conversationKey,
    });

    await options.bot.reply(
      options.rawMessage,
      "I ran into an error while processing that request. Please try again in the same chat.",
    ).catch(() => undefined);
  } finally {
    await options.bot.stopTyping(options.rawMessage.userId).catch(() => undefined);
  }
};

const getConversationQueue = (
  state: WeChatGatewayState,
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

const resolveBaseUrl = (
  wechatConfig: WeChatPlatformConfig,
  env: WeChatGatewayEnv,
): string | undefined => {
  return env.JARVIS_WECHAT_BASE_URL ?? wechatConfig.baseUrl;
};

const resolveTokenPath = (
  wechatConfig: WeChatPlatformConfig,
  env: WeChatGatewayEnv,
): string | undefined => {
  return env.JARVIS_WECHAT_TOKEN_PATH ?? wechatConfig.tokenPath;
};

const loadWeChatGatewayEnv = (rawEnv: NodeJS.ProcessEnv): WeChatGatewayEnv => {
  return wechatGatewayEnvSchema.parse(rawEnv);
};

const registerShutdownHandlers = (
  bot: WeixinBot,
  logger: Logger,
): void => {
  const stopBot = (): void => {
    logger.info("wechat.gateway_stopping");
    bot.stop();
  };

  process.once("SIGINT", stopBot);
  process.once("SIGTERM", stopBot);
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
    options.logger?.info("wechat.health_server_started", {
      host: options.host,
      port: options.port,
    });
    process.stdout.write(
      `WeChat health check listening on http://${options.host}:${options.port}\n`,
    );
  });
};

const toError = (error: unknown): Error => {
  return error instanceof Error ? error : new Error(String(error));
};
