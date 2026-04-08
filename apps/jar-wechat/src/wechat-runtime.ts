import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createLogger,
  executePromptInSession,
  loadRuntimeConfig,
  SessionExecutionError,
  stripMemoryExcludedPromptContextFromMessage,
  supportsModelInput,
  type ImageContent,
  type LoadedRuntimeConfig,
  type Logger,
  type UserMessage,
} from "@hijarvis/jar-core";
import {
  MessageItemType,
  WeixinBot,
  type IncomingMessage,
  type MessageItem,
} from "@pinixai/weixin-bot";
import { z } from "zod";

import {
  buildWeChatPrompt,
  createWeChatSessionId,
  hasMeaningfulWeChatText,
  hasWeChatImageAttachments,
  sanitizePersistedConversationMessage,
  type WeChatAttachment,
  type WeChatMessage,
  type WeChatPromptAsset,
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
type QueueEntry = {
  message: WeChatMessage;
  rawMessage: IncomingMessage;
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
  imageInputEnabled: boolean;
  queues: Map<string, ConversationQueueState>;
};

type PreparedPromptImage = {
  reference: string;
  messageId: string;
  url?: string;
  content: ImageContent;
};

const defaultHost = "0.0.0.0";
const defaultPort = 3002;
const defaultCoalesceWindowMs = 2_500;
const queueEntryTtlMs = 60_000;
const maxQueueSize = 20;
const maxImagesPerTurn = 4;
const maxImageBytes = 10 * 1024 * 1024;

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
  const imageInputEnabled = supportsImageInput(
    runtimeConfig.runtime.provider,
    runtimeConfig.runtime.model,
  );

  await bot.login();

  const state: WeChatGatewayState = {
    runtime: runtimeConfig,
    wechatConfig,
    logger,
    bot,
    imageInputEnabled,
    queues: new Map<string, ConversationQueueState>(),
  };

  logger.info("wechat.gateway_initialized", {
    configPath: path.resolve(options.configPath),
    baseUrl: resolveBaseUrl(wechatConfig, env),
    tokenPath: resolveTokenPath(wechatConfig, env),
    imageInputEnabled,
    coalesceWindowMs: resolveCoalesceWindowMs(wechatConfig),
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
      textChars: normalized.text?.length ?? 0,
      imageCount: normalized.attachments.length,
    });

    enqueueMessage(state, conversationKey, {
      message: normalized,
      rawMessage: message,
      receivedAt: Date.now(),
    });
  });
};

const normalizeWeChatMessage = (
  message: IncomingMessage,
): WeChatMessage | null => {
  const messageId = createWeChatMessageId(message);
  const { text, attachments, transcriptText } = extractWeChatContent(message, messageId);

  if (transcriptText.trim().length === 0) {
    return null;
  }

  return {
    id: messageId,
    userId: message.userId,
    ...(text === undefined ? {} : { text }),
    attachments,
    transcriptText,
    type: message.type,
    sentAt: message.timestamp,
  };
};

const extractWeChatContent = (
  message: IncomingMessage,
  messageId: string,
): {
  text?: string;
  attachments: WeChatAttachment[];
  transcriptText: string;
} => {
  const textParts: string[] = [];
  const attachments: WeChatAttachment[] = [];

  for (const [index, item] of message.raw.item_list.entries()) {
    collectMessageItemContent(item, messageId, index, textParts, attachments);
  }

  let text = textParts
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join("\n");

  if (!text && message.type === "text") {
    text = message.text.trim();
  }

  const transcriptParts = [
    ...(text ? [text] : []),
    ...attachments.map((attachment) => attachment.transcriptText),
  ];

  if (transcriptParts.length === 0) {
    const fallback = message.text.trim();
    if (fallback.length > 0) {
      transcriptParts.push(fallback);
    } else if (message.type !== "text") {
      transcriptParts.push(`[${message.type} message]`);
    }
  }

  return {
    ...(text ? { text } : {}),
    attachments,
    transcriptText: transcriptParts.join("\n"),
  };
};

const collectMessageItemContent = (
  item: MessageItem,
  messageId: string,
  index: number,
  textParts: string[],
  attachments: WeChatAttachment[],
): void => {
  switch (item.type) {
    case MessageItemType.TEXT: {
      const text = item.text_item?.text?.trim();
      if (text) {
        textParts.push(text);
      }
      return;
    }
    case MessageItemType.IMAGE: {
      const url = item.image_item?.url?.trim();
      attachments.push({
        id: `${messageId}#${index + 1}`,
        kind: "image",
        ...(url ? { url } : {}),
        transcriptText: url ? `[image] ${url}` : "[image]",
      });
      return;
    }
    default:
      return;
  }
};

const createWeChatMessageId = (message: IncomingMessage): string => {
  const explicitId = message.raw.message_id;

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
      await waitForQuietWindow(queue, resolveCoalesceWindowMs(state.wechatConfig));

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

      state.logger.info("wechat.queue_draining", {
        conversationKey,
        batchSize: batch.length,
        imageCount: batch.reduce(
          (sum, entry) => sum + entry.message.attachments.length,
          0,
        ),
      });

      try {
        await handleQueueBatch(state, conversationKey, batch);
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

const waitForQuietWindow = async (
  queue: ConversationQueueState,
  coalesceWindowMs: number,
): Promise<void> => {
  while (true) {
    const latestEntry = queue.entries[queue.entries.length - 1];
    if (!latestEntry) {
      return;
    }

    const remainingMs = latestEntry.receivedAt + coalesceWindowMs - Date.now();
    if (remainingMs <= 0) {
      return;
    }

    await sleep(remainingMs);
  }
};

const handleQueueBatch = async (
  state: WeChatGatewayState,
  conversationKey: string,
  batch: QueueEntry[],
): Promise<void> => {
  const latestEntry = batch[batch.length - 1]!;
  const messages = batch.map((entry) => entry.message);
  const sessionId = createWeChatSessionId(`wechat:${latestEntry.message.userId}`);
  const requestLogger = state.logger.child({
    conversationKey,
    sessionId,
    userId: latestEntry.message.userId,
    messageId: latestEntry.message.id,
    batchSize: batch.length,
  });

  if (hasWeChatImageAttachments(messages) && !hasMeaningfulWeChatText(messages)) {
    const replyText = [
      "I received your image.",
      "Send one short follow-up message telling me what to focus on, and I will analyze it together with the image.",
    ].join(" ");

    await state.bot.reply(latestEntry.rawMessage, replyText);
    requestLogger.info("wechat.reply_requested_follow_up", {
      reason: "image_without_text",
      imageCount: messages.reduce(
        (sum, message) => sum + message.attachments.length,
        0,
      ),
    });
    return;
  }

  const prompt = await createWeChatPromptMessage(state, messages, requestLogger);
  const promptContent = Array.isArray(prompt.content) ? prompt.content : [];

  requestLogger.info("wechat.request_started", {
    promptChars: promptContent
      .filter(
        (
          item,
        ): item is Extract<NonNullable<UserMessage["content"]>[number], { type: "text" }> =>
          item.type === "text",
      )
      .reduce((sum, item) => sum + item.text.length, 0),
    promptContentBlocks: promptContent.length,
  });

  await respondInWeChatConversation({
    runtime: state.runtime,
    bot: state.bot,
    rawMessage: latestEntry.rawMessage,
    conversationKey,
    sessionId,
    prompt,
    skillTriggerText: buildWeChatSkillTriggerText(messages),
    logger: requestLogger,
  });
};

const createWeChatPromptMessage = async (
  state: WeChatGatewayState,
  messages: WeChatMessage[],
  logger: Logger,
): Promise<UserMessage> => {
  const images = await preparePromptImages(messages, state.imageInputEnabled, logger);
  const assets = buildPromptAssets(messages, images);
  const content: UserMessage["content"] = [{
    type: "text",
    text: buildWeChatPrompt({
      messages,
      assets,
      imageInputEnabled: state.imageInputEnabled,
    }),
  }];

  for (const image of images) {
    content.push({
      type: "text",
      text: [
        `Attached WeChat image ${image.reference} for message ${image.messageId}.`,
        image.url ? `Source URL: ${image.url}` : "Source URL unavailable.",
      ].join(" "),
    });
    content.push(image.content);
  }

  return {
    role: "user",
    content,
    timestamp: messages[messages.length - 1]?.sentAt.getTime() ?? Date.now(),
  };
};

const preparePromptImages = async (
  messages: WeChatMessage[],
  imageInputEnabled: boolean,
  logger: Logger,
): Promise<PreparedPromptImage[]> => {
  if (!imageInputEnabled) {
    return [];
  }

  const attachments = messages.flatMap((message) => {
    return message.attachments.map((attachment) => ({
      messageId: message.id,
      attachment,
    }));
  });

  const selected = attachments.slice(0, maxImagesPerTurn);
  const prepared: PreparedPromptImage[] = [];

  for (const [index, asset] of selected.entries()) {
    if (!asset.attachment.url) {
      logger.debug("wechat.image_skipped", {
        messageId: asset.messageId,
        attachmentId: asset.attachment.id,
        reason: "missing_url",
      });
      continue;
    }

    try {
      const image = await fetchImageContent(asset.attachment.url);
      prepared.push({
        reference: `IMG-${index + 1}`,
        messageId: asset.messageId,
        url: asset.attachment.url,
        content: image,
      });
    } catch (error) {
      logger.warn("wechat.image_fetch_failed", {
        messageId: asset.messageId,
        attachmentId: asset.attachment.id,
        url: asset.attachment.url,
        message: toError(error).message,
      });
    }
  }

  return prepared;
};

const buildPromptAssets = (
  messages: WeChatMessage[],
  preparedImages: PreparedPromptImage[],
): WeChatPromptAsset[] => {
  const preparedByAttachmentKey = new Map(
    preparedImages.map((image) => [toAttachmentKey(image.messageId, image.url), image]),
  );
  const assets: WeChatPromptAsset[] = [];
  const attachments = messages.flatMap((message) => {
    return message.attachments.map((attachment) => ({
      messageId: message.id,
      attachment,
    }));
  });

  for (const [index, entry] of attachments.entries()) {
    const reference = `IMG-${index + 1}`;
    const prepared = preparedByAttachmentKey.get(
      toAttachmentKey(entry.messageId, entry.attachment.url),
    );

    if (prepared) {
      assets.push({
        reference: prepared.reference,
        messageId: entry.messageId,
        included: true,
        ...(entry.attachment.url === undefined ? {} : { url: entry.attachment.url }),
      });
      continue;
    }

    const issue = index >= maxImagesPerTurn
      ? `exceeds the ${maxImagesPerTurn}-image limit for one turn`
      : entry.attachment.url
        ? "download failed or source was unavailable"
        : "missing image URL";

    assets.push({
      reference,
      messageId: entry.messageId,
      included: false,
      issue,
      ...(entry.attachment.url === undefined ? {} : { url: entry.attachment.url }),
    });
  }

  return assets;
};

const toAttachmentKey = (
  messageId: string,
  url: string | undefined,
): string => {
  return `${messageId}:${url ?? "(missing-url)"}`;
};

const respondInWeChatConversation = async (options: {
  runtime: LoadedRuntimeConfig;
  bot: WeixinBot;
  rawMessage: IncomingMessage;
  conversationKey: string;
  sessionId: string;
  prompt: UserMessage;
  skillTriggerText: string;
  logger: Logger;
}): Promise<void> => {
  const startedAt = Date.now();
  let turnId: string | undefined;
  let runId: string | undefined;

  try {
    await options.bot.sendTyping(options.rawMessage.userId);
  } catch (error) {
    options.logger.debug("wechat.typing_failed", {
      message: toError(error).message,
    });
  }

  try {
    const execution = await executePromptInSession({
      ...options.runtime.runtime,
      skills: options.runtime.skills,
      toolOptions: options.runtime.toolOptions,
      sessionsRootDir: options.runtime.sessions.rootDir,
      sessionId: options.sessionId,
      prompt: options.prompt,
      skillTriggerText: options.skillTriggerText,
      turnTrigger: "platform_event",
      turnInputMetadata: {
        platform: "wechat",
        conversationKey: options.conversationKey,
        userId: options.rawMessage.userId,
        messageType: options.rawMessage.type,
      },
      logger: options.logger,
      serializeMessage: (message) => {
        return stripMemoryExcludedPromptContextFromMessage(
          sanitizePersistedConversationMessage(message),
        );
      },
      writers: {
        stderr: process.stderr,
      },
    });
    turnId = execution.turnId;
    runId = execution.runId;
    const { outputText } = execution;

    const replyText = outputText.trim().length > 0
      ? outputText
      : "I finished processing that, but I do not have a textual reply to send.";

    await options.bot.reply(options.rawMessage, replyText);

    options.logger.info("wechat.reply_posted", {
      durationMs: Date.now() - startedAt,
      replyChars: replyText.trim().length,
      sessionId: options.sessionId,
      turnId,
      runId,
      conversationKey: options.conversationKey,
    });
  } catch (error) {
    const normalizedError = toError(error);
    options.logger.error("wechat.reply_failed", {
      durationMs: Date.now() - startedAt,
      message: normalizedError.message,
      sessionId: options.sessionId,
      turnId: turnId ?? (error instanceof SessionExecutionError ? error.turnId : undefined),
      runId: runId ?? (error instanceof SessionExecutionError ? error.runId : undefined),
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

const buildWeChatSkillTriggerText = (
  messages: WeChatMessage[],
): string => {
  return messages
    .map((message) => (message.text ?? "").trim())
    .filter((text) => text.length > 0)
    .join("\n");
};

const fetchImageContent = async (url: string): Promise<ImageContent> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Image fetch failed with HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxImageBytes) {
    throw new Error(`Image exceeds ${maxImageBytes} bytes`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxImageBytes) {
    throw new Error(`Image exceeds ${maxImageBytes} bytes`);
  }

  const mimeType = resolveImageMimeType(
    response.headers.get("content-type"),
    url,
  );

  return {
    type: "image",
    data: Buffer.from(arrayBuffer).toString("base64"),
    mimeType,
  };
};

const resolveImageMimeType = (
  contentTypeHeader: string | null,
  url: string,
): string => {
  const normalizedHeader = contentTypeHeader?.split(";")[0]?.trim().toLowerCase();
  if (normalizedHeader?.startsWith("image/")) {
    return normalizedHeader;
  }

  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".png")) {
    return "image/png";
  }
  if (pathname.endsWith(".gif")) {
    return "image/gif";
  }
  if (pathname.endsWith(".webp")) {
    return "image/webp";
  }
  if (pathname.endsWith(".bmp")) {
    return "image/bmp";
  }

  return "image/jpeg";
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

const resolveCoalesceWindowMs = (
  wechatConfig: WeChatPlatformConfig,
): number => {
  return wechatConfig.coalesceWindowMs ?? defaultCoalesceWindowMs;
};

const supportsImageInput = (
  provider: LoadedRuntimeConfig["runtime"]["provider"],
  modelId: string,
): boolean => {
  return supportsModelInput(provider, modelId, "image");
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
