import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";

import { App, LogLevel } from "@slack/bolt";
import {
  buildTurnPrompt,
  createLogger,
  executePromptInSession,
  loadAgentConfig,
  type LoadedAgentConfig,
  type Logger,
} from "@hijarvis/jar-core";
import { z } from "zod";

import {
  buildSubscribedThreadPrompt,
  createSlackReplyPayload,
  createSlackSessionId,
  formatCurrentMessageBlock,
  formatObservedContextBlock,
  formatQueuedMessagesBlock,
  type SlackMessage,
} from "./slack-prompt.js";

const slackGatewayEnvSchema = z.object({
  SLACK_BOT_TOKEN: z.string().trim().min(1).optional(),
  SLACK_APP_TOKEN: z.string().trim().min(1).optional(),
  SLACK_SIGNING_SECRET: z.string().trim().min(1).optional(),
  JARVIS_SLACK_BOT_NAME: z.string().trim().min(1).optional(),
  JARVIS_SLACK_CONTEXT_LOOKBACK_MINUTES: z.coerce.number().int().positive().optional(),
  JARVIS_SLACK_CONTEXT_MESSAGE_LIMIT: z.coerce.number().int().positive().optional(),
  PORT: z.coerce.number().int().positive().optional(),
  HOST: z.string().trim().min(1).optional(),
});

type SlackGatewayRuntimeOptions = {
  configPath: string;
  host?: string;
  port?: number;
};

type SlackGatewayEnv = z.infer<typeof slackGatewayEnvSchema>;

type ObservedContextLimits = {
  lookbackMinutes: number;
  maxMessages: number;
};

type SlackGatewayTokens = {
  botToken: string;
  appToken: string;
  signingSecret: string;
};

type SlackGatewayIdentity = {
  botUserId: string;
  botId?: string;
};

type SlackEventType = "app_mention" | "message";

type SlackEventMessage = {
  channel: string;
  channel_type?: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
};

type SlackMessageSeed = {
  id: string;
  text: string;
  authorId: string;
  sentAt: Date;
};

type NormalizedSlackEvent = {
  eventType: SlackEventType;
  eventId: string | undefined;
  channel: string;
  channelType: string | undefined;
  threadTs: string;
  threadKey: string;
  messageKey: string;
  text: string;
  user: string;
  hasBotMention: boolean;
  isDirectMessage: boolean;
  sentAt: Date;
  message: SlackMessageSeed;
};

type SlackTriggerDecision =
  | {
    action: "ignore";
    reason: "thread_not_subscribed";
    threadKey: string;
    threadTs: string;
    channel: string;
    messageKey: string;
    isDirectMessage: boolean;
    hasBotMention: boolean;
  }
  | {
    action: "enqueue";
    queueKind: QueueEntry["kind"];
    threadKey: string;
    threadTs: string;
    channel: string;
    messageKey: string;
    isDirectMessage: boolean;
    hasBotMention: boolean;
    alreadySubscribed: boolean;
    shouldSubscribe: boolean;
    message: SlackMessageSeed;
  };

type QueueEntry = {
  kind: "new_mention" | "subscribed";
  channel: string;
  threadTs: string;
  message: SlackMessageSeed;
  receivedAt: number;
};

type ThreadQueueState = {
  running: boolean;
  entries: QueueEntry[];
};

type SlackGatewayState = {
  identity: SlackGatewayIdentity;
  observedContextLimits: ObservedContextLimits;
  config: LoadedAgentConfig;
  logger: Logger;
  slackClient: App["client"];
  subscriptions: Set<string>;
  queues: Map<string, ThreadQueueState>;
  userCache: Map<string, string>;
  seenEvents: Map<string, number>;
  seenMessages: Map<string, number>;
};

const defaultObservedContextLimits: ObservedContextLimits = {
  lookbackMinutes: 15,
  maxMessages: 12,
};

const defaultHost = "0.0.0.0";
const defaultPort = 3000;
const queueEntryTtlMs = 60_000;
const maxQueueSize = 20;
const seenEventTtlMs = 5 * 60_000;
const seenMessageTtlMs = 5 * 60_000;

export const startSlackGateway = async (
  options: SlackGatewayRuntimeOptions,
): Promise<void> => {
  const config = await loadAgentConfig(options.configPath);
  const logger = createLogger(config.logging).child({
    component: "slack_gateway",
  });
  const env = loadSlackGatewayEnv(process.env);
  const tokens = resolveSlackTokens(config, env);

  const observedContextLimits = {
    lookbackMinutes:
      env.JARVIS_SLACK_CONTEXT_LOOKBACK_MINUTES ??
      config.platform.slack.contextLookbackMinutes ??
      defaultObservedContextLimits.lookbackMinutes,
    maxMessages:
      env.JARVIS_SLACK_CONTEXT_MESSAGE_LIMIT ??
      config.platform.slack.contextMessageLimit ??
      defaultObservedContextLimits.maxMessages,
  };

  const app = new App({
    token: tokens.botToken,
    appToken: tokens.appToken,
    signingSecret: tokens.signingSecret,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  const identity = await resolveBotIdentity(app);
  const state: SlackGatewayState = {
    identity,
    observedContextLimits,
    config,
    logger,
    slackClient: app.client,
    subscriptions: new Set<string>(),
    queues: new Map<string, ThreadQueueState>(),
    userCache: new Map<string, string>(),
    seenEvents: new Map<string, number>(),
    seenMessages: new Map<string, number>(),
  };

  logger.info("slack.gateway_initialized", {
    configPath: path.resolve(options.configPath),
    botUserId: identity.botUserId,
    contextLookbackMinutes: observedContextLimits.lookbackMinutes,
    contextMessageLimit: observedContextLimits.maxMessages,
    logLevel: config.logging.level,
    logToStderr: config.logging.stderr,
    logFilePath: config.logging.filePath,
  });

  registerSlackHandlers(app, state);

  await app.start();
  startHealthServer({
    host:
      options.host ??
      env.HOST ??
      config.platform.slack.host ??
      defaultHost,
    port:
      options.port ??
      env.PORT ??
      config.platform.slack.port ??
      defaultPort,
    logger,
  });

  process.stdout.write(
    `Jar Slack gateway running in Socket Mode using ${path.resolve(options.configPath)}\n`,
  );
  logger.info("slack.gateway_started", {
    configPath: path.resolve(options.configPath),
  });
};

const resolveSlackTokens = (
  config: LoadedAgentConfig,
  env: SlackGatewayEnv,
): SlackGatewayTokens => {
  const botToken =
    env.SLACK_BOT_TOKEN ?? config.platform.slack.botToken ?? "";
  const appToken =
    env.SLACK_APP_TOKEN ?? config.platform.slack.appToken ?? "";
  const signingSecret =
    env.SLACK_SIGNING_SECRET ?? config.platform.slack.signingSecret ?? "";

  const missing: string[] = [];
  if (!botToken) {
    missing.push("SLACK_BOT_TOKEN");
  }
  if (!appToken) {
    missing.push("SLACK_APP_TOKEN");
  }
  if (!signingSecret) {
    missing.push("SLACK_SIGNING_SECRET");
  }

  if (missing.length > 0) {
    throw new Error(`Missing Slack credentials: ${missing.join(", ")}`);
  }

  return { botToken, appToken, signingSecret };
};

const resolveBotIdentity = async (app: App): Promise<SlackGatewayIdentity> => {
  const auth = await app.client.auth.test();
  const botUserId = auth.user_id;
  if (!botUserId) {
    throw new Error("Slack auth.test did not return a bot user id.");
  }

  if (auth.bot_id) {
    return {
      botUserId,
      botId: auth.bot_id,
    };
  }

  return { botUserId };
};

const registerSlackHandlers = (app: App, state: SlackGatewayState): void => {
  app.event("app_mention", async (args) => {
    await processSlackEvent({
      eventType: "app_mention",
      event: args.event as SlackEventMessage,
      eventId: (args.body as { event_id?: string } | undefined)?.event_id,
      state,
    });
  });

  app.event("message", async (args) => {
    await processSlackEvent({
      eventType: "message",
      event: args.event as SlackEventMessage,
      eventId: (args.body as { event_id?: string } | undefined)?.event_id,
      state,
    });
  });
};

const processSlackEvent = async ({
  eventType,
  event,
  eventId,
  state,
}: {
  eventType: SlackEventType;
  event: SlackEventMessage;
  eventId: string | undefined;
  state: SlackGatewayState;
}): Promise<void> => {
  if (!isSlackMessageEvent(event)) {
    return;
  }

  if (isDuplicateEvent(eventId, state)) {
    state.logger.debug("slack.event_deduplicated", {
      eventType,
      eventId,
    });
    return;
  }

  const normalized = normalizeSlackEvent(eventType, event, state.identity.botUserId, eventId);
  if (!normalized) {
    return;
  }

  const decision = classifySlackTrigger(normalized, state.subscriptions);
  if (decision.action === "ignore") {
    state.logger.debug("slack.event_ignored", {
      eventType: normalized.eventType,
      eventId: normalized.eventId,
      reason: decision.reason,
      threadKey: decision.threadKey,
      channel: decision.channel,
      threadTs: decision.threadTs,
      isDirectMessage: decision.isDirectMessage,
      hasBotMention: decision.hasBotMention,
      messageTs: normalized.message.id,
    });
    return;
  }

  if (isDuplicateMessage(decision.messageKey, state)) {
    state.logger.debug("slack.message_deduplicated", {
      eventType: normalized.eventType,
      eventId: normalized.eventId,
      threadKey: decision.threadKey,
      channel: decision.channel,
      threadTs: decision.threadTs,
      messageKey: decision.messageKey,
      messageTs: normalized.message.id,
    });
    return;
  }

  if (decision.shouldSubscribe) {
    state.subscriptions.add(decision.threadKey);
  }

  state.logger.info("slack.event_received", {
    eventType: normalized.eventType,
    eventId: normalized.eventId,
    trigger: decision.queueKind,
    threadKey: decision.threadKey,
    channel: decision.channel,
    threadTs: decision.threadTs,
    isDirectMessage: decision.isDirectMessage,
    hasBotMention: decision.hasBotMention,
    alreadySubscribed: decision.alreadySubscribed,
    shouldSubscribe: decision.shouldSubscribe,
    messageTs: normalized.message.id,
    textChars: normalized.message.text.length,
  });

  enqueueMessage(state, decision.threadKey, {
    kind: decision.queueKind,
    channel: decision.channel,
    threadTs: decision.threadTs,
    message: decision.message,
    receivedAt: Date.now(),
  });
};

const enqueueMessage = (
  state: SlackGatewayState,
  threadKey: string,
  entry: QueueEntry,
): void => {
  const queue = getThreadQueue(state, threadKey);
  const now = Date.now();

  queue.entries = queue.entries.filter(
    (queued) => now - queued.receivedAt <= queueEntryTtlMs,
  );
  queue.entries.push(entry);

  if (queue.entries.length > maxQueueSize) {
    queue.entries.splice(0, queue.entries.length - maxQueueSize);
  }

  state.logger.info("slack.queue_enqueued", {
    threadKey,
    kind: entry.kind,
    queueSize: queue.entries.length,
    channel: entry.channel,
    threadTs: entry.threadTs,
    messageTs: entry.message.id,
  });

  if (!queue.running) {
    queue.running = true;
    void drainQueue(state, threadKey, queue);
  }
};

const drainQueue = async (
  state: SlackGatewayState,
  threadKey: string,
  queue: ThreadQueueState,
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

      state.logger.info("slack.queue_draining", {
        threadKey,
        batchSize: batch.length,
        skippedCount: skipped.length,
        currentKind: current.kind,
      });

      try {
        await handleQueueEntry(state, threadKey, current, skipped);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.logger.error("slack.queue_entry_failed", {
          threadKey,
          message,
        });
      }
    }
  } finally {
    queue.running = false;
  }
};

const handleQueueEntry = async (
  state: SlackGatewayState,
  threadKey: string,
  entry: QueueEntry,
  skipped: SlackMessageSeed[],
): Promise<void> => {
  const sessionId = createSlackSessionId(`slack:${threadKey}`);
  const requestLogger = state.logger.child({
    threadKey,
    sessionId,
    channel: entry.channel,
    threadTs: entry.threadTs,
    requestKind: entry.kind,
    messageTs: entry.message.id,
  });
  const current = await materializeSlackMessage(state, entry.message);
  const skippedMessages = await materializeSkippedMessages(state, skipped);
  requestLogger.info("slack.request_started", {
    skippedCount: skippedMessages.length,
    currentAuthor: current.authorName,
  });
  const prompt = entry.kind === "new_mention"
    ? await buildMentionPrompt(
      state,
      entry.channel,
      current,
      skippedMessages,
      requestLogger,
    )
    : buildSubscribedThreadPrompt(current, skippedMessages);

  await respondInSlackThread({
    config: state.config,
    channel: entry.channel,
    threadTs: entry.threadTs,
    threadKey,
    sessionId,
    prompt,
    client: state,
    logger: requestLogger,
  });
};

const buildMentionPrompt = async (
  state: SlackGatewayState,
  channel: string,
  currentMessage: SlackMessage,
  skipped: SlackMessage[],
  logger: Logger,
): Promise<string> => {
  const observedMessages = await collectObservedChannelMessages(
    state,
    channel,
    currentMessage,
  );

  logger.info("slack.context_collected", {
    observedCount: observedMessages.length,
    skippedCount: skipped.length,
    lookbackMinutes: state.observedContextLimits.lookbackMinutes,
  });

  return buildTurnPrompt({
    lead: [
      "You are replying inside a Slack thread that was created from a channel mention.",
      "Use the observed channel context to understand what happened immediately before the mention.",
      "Do not claim to remember channel history beyond the observed context provided below.",
    ],
    sections: [
      { body: formatObservedContextBlock(observedMessages) },
      { body: formatQueuedMessagesBlock(skipped) },
      { body: formatCurrentMessageBlock(currentMessage) },
    ],
  });
};

const collectObservedChannelMessages = async (
  state: SlackGatewayState,
  channel: string,
  currentMessage: SlackMessage,
): Promise<SlackMessage[]> => {
  const cutoffTime =
    currentMessage.sentAt.getTime() -
    state.observedContextLimits.lookbackMinutes * 60_000;
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;

  while (messages.length < state.observedContextLimits.maxMessages) {
    const response = await state.slackClient.conversations.history({
      channel,
      latest: String(currentMessage.sentAt.getTime() / 1000),
      inclusive: false,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    if (!response.ok) {
      state.logger.error("slack.history_failed", {
        channel,
        messageTs: currentMessage.id,
        error: response.error ?? "unknown",
      });
      break;
    }

    const history = response.messages ?? [];
    for (const item of history) {
      if (!item.ts || !item.text || !item.user) {
        continue;
      }

      if (item.bot_id || item.user === state.identity.botUserId) {
        continue;
      }

      if (item.thread_ts && item.thread_ts !== item.ts) {
        continue;
      }

      const sentAt = Number(item.ts) * 1000;
      if (!Number.isFinite(sentAt)) {
        continue;
      }

      if (sentAt >= currentMessage.sentAt.getTime()) {
        continue;
      }

      if (sentAt < cutoffTime) {
        return messages.reverse();
      }

      const authorName = await resolveUserName(state, item.user);
      messages.push({
        id: item.ts,
        text: item.text,
        authorId: item.user,
        authorName,
        sentAt: new Date(sentAt),
      });

      if (messages.length >= state.observedContextLimits.maxMessages) {
        break;
      }
    }

    if (!response.has_more || !response.response_metadata?.next_cursor) {
      break;
    }

    cursor = response.response_metadata.next_cursor;
  }

  return messages.reverse();
};

const resolveUserName = async (
  state: SlackGatewayState,
  userId: string,
): Promise<string> => {
  const cached = state.userCache.get(userId);
  if (cached) {
    return cached;
  }

  try {
    const response = await state.slackClient.users.info({ user: userId });
    const profile = response.user?.profile;
    const name =
      profile?.display_name ||
      profile?.real_name ||
      response.user?.name ||
      userId;

    state.userCache.set(userId, name);
    return name;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.logger.warn("slack.user_lookup_failed", {
      userId,
      message,
    });
    state.userCache.set(userId, userId);
    return userId;
  }
};

export const normalizeSlackEvent = (
  eventType: SlackEventType,
  event: SlackEventMessage,
  botUserId: string,
  eventId: string | undefined,
): NormalizedSlackEvent | null => {
  if (event.subtype || event.bot_id || event.user === botUserId) {
    return null;
  }

  if (!event.user || !event.text) {
    return null;
  }

  const sentAtMs = Number(event.ts) * 1000;
  if (!Number.isFinite(sentAtMs)) {
    return null;
  }

  const threadTs = event.thread_ts ?? event.ts;
  const sentAt = new Date(sentAtMs);
  const text = stripBotMention(event.text, botUserId);
  const message = {
    id: event.ts,
    text,
    authorId: event.user,
    sentAt,
  };

  return {
    eventType,
    eventId,
    channel: event.channel,
    channelType: event.channel_type,
    threadTs,
    threadKey: buildThreadKey(event.channel, threadTs),
    messageKey: buildMessageKey(event.channel, event.ts),
    text,
    user: event.user,
    hasBotMention: includesBotMention(event.text, botUserId),
    isDirectMessage: event.channel_type === "im",
    sentAt,
    message,
  };
};

export const classifySlackTrigger = (
  event: NormalizedSlackEvent,
  subscriptions: ReadonlySet<string>,
): SlackTriggerDecision => {
  const alreadySubscribed = subscriptions.has(event.threadKey);

  if (event.isDirectMessage) {
    return {
      action: "enqueue",
      queueKind: "subscribed",
      threadKey: event.threadKey,
      threadTs: event.threadTs,
      channel: event.channel,
      messageKey: event.messageKey,
      isDirectMessage: true,
      hasBotMention: event.hasBotMention,
      alreadySubscribed,
      shouldSubscribe: !alreadySubscribed,
      message: event.message,
    };
  }

  if (!alreadySubscribed) {
    if (event.eventType === "app_mention") {
      return {
        action: "enqueue",
        queueKind: "new_mention",
        threadKey: event.threadKey,
        threadTs: event.threadTs,
        channel: event.channel,
        messageKey: event.messageKey,
        isDirectMessage: false,
        hasBotMention: event.hasBotMention,
        alreadySubscribed,
        shouldSubscribe: true,
        message: event.message,
      };
    }

    return {
      action: "ignore",
      reason: "thread_not_subscribed",
      threadKey: event.threadKey,
      threadTs: event.threadTs,
      channel: event.channel,
      messageKey: event.messageKey,
      isDirectMessage: false,
      hasBotMention: event.hasBotMention,
    };
  }

  return {
    action: "enqueue",
    queueKind: "subscribed",
    threadKey: event.threadKey,
    threadTs: event.threadTs,
    channel: event.channel,
    messageKey: event.messageKey,
    isDirectMessage: false,
    hasBotMention: event.hasBotMention,
    alreadySubscribed,
    shouldSubscribe: false,
    message: event.message,
  };
};

const materializeSlackMessage = async (
  state: SlackGatewayState,
  seed: SlackMessageSeed,
): Promise<SlackMessage> => {
  const authorName = await resolveUserName(state, seed.authorId);
  return {
    id: seed.id,
    text: seed.text,
    authorId: seed.authorId,
    authorName,
    sentAt: seed.sentAt,
  };
};

const materializeSkippedMessages = async (
  state: SlackGatewayState,
  skipped: SlackMessageSeed[],
): Promise<SlackMessage[]> => {
  const messages: SlackMessage[] = [];
  for (const item of skipped) {
    messages.push(await materializeSlackMessage(state, item));
  }
  return messages;
};

const stripBotMention = (text: string, botUserId: string): string => {
  const mention = `<@${botUserId}>`;
  return text.replace(mention, "").trim();
};

const includesBotMention = (text: string, botUserId: string): boolean => {
  return text.includes(`<@${botUserId}>`);
};

const respondInSlackThread = async ({
  config,
  channel,
  threadTs,
  threadKey,
  sessionId,
  prompt,
  client,
  logger,
}: {
  config: LoadedAgentConfig;
  channel: string;
  threadTs: string;
  threadKey: string;
  sessionId: string;
  prompt: string;
  client: SlackGatewayState;
  logger: Logger;
}): Promise<void> => {
  const startedAt = Date.now();
  try {
    logger.info("slack.reply_generation_started", {
      promptChars: prompt.length,
    });
    const { outputText } = await executePromptInSession({
      ...config.runtime,
      toolOptions: config.toolOptions,
      sessionsRootDir: config.sessions.rootDir,
      sessionId,
      prompt,
      logger,
      writers: {
        stderr: process.stderr,
      },
    });

    const reply = outputText.trim().length > 0
      ? outputText
      : "I finished processing that, but I do not have a textual reply to send.";

    await client.slackClient.chat.postMessage({
      channel,
      thread_ts: threadTs,
      ...createSlackReplyPayload(reply),
    });

    logger.info("slack.reply_posted", {
      durationMs: Date.now() - startedAt,
      replyChars: reply.length,
      sessionId,
      threadKey,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("slack.reply_failed", {
      durationMs: Date.now() - startedAt,
      message,
      sessionId,
      threadKey,
    });

    await client.slackClient.chat.postMessage({
      channel,
      thread_ts: threadTs,
      ...createSlackReplyPayload(
        "I ran into an error while processing that request. Please try again in the same thread.",
      ),
    });
  }
};

const getThreadQueue = (
  state: SlackGatewayState,
  threadKey: string,
): ThreadQueueState => {
  const existing = state.queues.get(threadKey);
  if (existing) {
    return existing;
  }

  const created: ThreadQueueState = {
    running: false,
    entries: [],
  };
  state.queues.set(threadKey, created);
  return created;
};

const buildThreadKey = (channel: string, threadTs: string): string => {
  return `${channel}:${threadTs}`;
};

const buildMessageKey = (channel: string, messageTs: string): string => {
  return `${channel}:${messageTs}`;
};

const isSlackMessageEvent = (event: unknown): event is SlackEventMessage => {
  if (!event || typeof event !== "object") {
    return false;
  }

  return "channel" in event && "ts" in event;
};

const isDuplicateEvent = (
  eventId: string | undefined,
  state: SlackGatewayState,
): boolean => {
  return hasSeenKey(state.seenEvents, eventId, seenEventTtlMs);
};

const isDuplicateMessage = (
  messageKey: string,
  state: SlackGatewayState,
): boolean => {
  return hasSeenKey(state.seenMessages, messageKey, seenMessageTtlMs);
};

export const hasSeenKey = (
  store: Map<string, number>,
  key: string | undefined,
  ttlMs: number,
  now = Date.now(),
): boolean => {
  if (!key) {
    return false;
  }

  for (const [currentKey, timestamp] of store.entries()) {
    if (now - timestamp > ttlMs) {
      store.delete(currentKey);
    }
  }

  if (store.has(key)) {
    return true;
  }

  store.set(key, now);
  return false;
};

const loadSlackGatewayEnv = (
  rawEnv: NodeJS.ProcessEnv,
): SlackGatewayEnv => {
  return slackGatewayEnvSchema.parse(rawEnv);
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
    options.logger?.info("slack.health_server_started", {
      host: options.host,
      port: options.port,
    });
    process.stdout.write(
      `Slack health check listening on http://${options.host}:${options.port}\n`,
    );
  });
};
