import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";

import { App, LogLevel } from "@slack/bolt";
import {
  executePromptInSession,
  loadAgentConfig,
  type LoadedAgentConfig,
} from "@hijarvis/jar-core";
import { z } from "zod";

import {
  buildSubscribedThreadPrompt,
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
  slackClient: App["client"];
  subscriptions: Set<string>;
  queues: Map<string, ThreadQueueState>;
  userCache: Map<string, string>;
  seenEvents: Map<string, number>;
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

export const startSlackGateway = async (
  options: SlackGatewayRuntimeOptions,
): Promise<void> => {
  const config = await loadAgentConfig(options.configPath);
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
    slackClient: app.client,
    subscriptions: new Set<string>(),
    queues: new Map<string, ThreadQueueState>(),
    userCache: new Map<string, string>(),
    seenEvents: new Map<string, number>(),
  };

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
  });

  process.stdout.write(
    `Jar Slack gateway running in Socket Mode using ${path.resolve(options.configPath)}\n`,
  );
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
    const event = args.event as SlackEventMessage;
    const body = args.body as { event_id?: string } | undefined;

    if (!isSlackMessageEvent(event)) {
      return;
    }

    if (isDuplicateEvent(body?.event_id, state)) {
      return;
    }

    const normalized = normalizeSlackMessageSeed(event, state.identity.botUserId);
    if (!normalized) {
      return;
    }

    const threadTs = event.thread_ts ?? event.ts;
    const threadKey = buildThreadKey(event.channel, threadTs);
    const isSubscribed = state.subscriptions.has(threadKey);
    state.subscriptions.add(threadKey);

    enqueueMessage(state, threadKey, {
      kind: isSubscribed ? "subscribed" : "new_mention",
      channel: event.channel,
      threadTs,
      message: normalized,
      receivedAt: Date.now(),
    });
  });

  app.event("message", async (args) => {
    const event = args.event as SlackEventMessage;
    const body = args.body as { event_id?: string } | undefined;

    if (!isSlackMessageEvent(event)) {
      return;
    }

    if (isDuplicateEvent(body?.event_id, state)) {
      return;
    }

    if (event.subtype || event.bot_id || event.user === state.identity.botUserId) {
      return;
    }

    if (!event.user || !event.text) {
      return;
    }

    const isDirectMessage = event.channel_type === "im";
    const threadTs = event.thread_ts ?? event.ts;
    const threadKey = buildThreadKey(event.channel, threadTs);

    if (!isDirectMessage && !state.subscriptions.has(threadKey)) {
      return;
    }

    if (isDirectMessage) {
      state.subscriptions.add(threadKey);
    }

    const normalized = normalizeSlackMessageSeed(event, state.identity.botUserId);
    if (!normalized) {
      return;
    }

    enqueueMessage(state, threadKey, {
      kind: "subscribed",
      channel: event.channel,
      threadTs,
      message: normalized,
      receivedAt: Date.now(),
    });
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

      try {
        await handleQueueEntry(state, threadKey, current, skipped);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[slack:error] ${message}\n`);
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
  const current = await materializeSlackMessage(state, entry.message);
  const skippedMessages = await materializeSkippedMessages(state, skipped);
  const prompt = entry.kind === "new_mention"
    ? await buildMentionPrompt(state, entry.channel, current, skippedMessages)
    : buildSubscribedThreadPrompt(current, skippedMessages);

  await respondInSlackThread({
    config: state.config,
    channel: entry.channel,
    threadTs: entry.threadTs,
    threadKey,
    prompt,
    client: state,
  });
};

const buildMentionPrompt = async (
  state: SlackGatewayState,
  channel: string,
  currentMessage: SlackMessage,
  skipped: SlackMessage[],
): Promise<string> => {
  const observedMessages = await collectObservedChannelMessages(
    state,
    channel,
    currentMessage,
  );

  return [
    "You are replying inside a Slack thread that was created from a channel mention.",
    "Use the observed channel context to understand what happened immediately before the mention.",
    "Do not claim to remember channel history beyond the observed context provided below.",
    "",
    formatObservedContextBlock(observedMessages),
    "",
    formatQueuedMessagesBlock(skipped),
    "",
    formatCurrentMessageBlock(currentMessage),
  ]
    .filter((segment) => segment.trim().length > 0)
    .join("\n");
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
      process.stderr.write(
        `[slack:error] conversations.history failed: ${response.error ?? "unknown"}\n`,
      );
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
    process.stderr.write(`[slack:error] users.info failed: ${message}\n`);
    state.userCache.set(userId, userId);
    return userId;
  }
};

const normalizeSlackMessageSeed = (
  event: SlackEventMessage,
  botUserId: string,
): SlackMessageSeed | null => {
  if (!event.user || !event.text) {
    return null;
  }

  const sentAtMs = Number(event.ts) * 1000;
  if (!Number.isFinite(sentAtMs)) {
    return null;
  }
  const sentAt = new Date(sentAtMs);
  const text = stripBotMention(event.text, botUserId);

  return {
    id: event.ts,
    text,
    authorId: event.user,
    sentAt,
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

const respondInSlackThread = async ({
  config,
  channel,
  threadTs,
  threadKey,
  prompt,
  client,
}: {
  config: LoadedAgentConfig;
  channel: string;
  threadTs: string;
  threadKey: string;
  prompt: string;
  client: SlackGatewayState;
}): Promise<void> => {
  try {
    const { outputText } = await executePromptInSession({
      ...config.runtime,
      toolOptions: config.toolOptions,
      sessionsRootDir: config.sessions.rootDir,
      sessionId: createSlackSessionId(`slack:${threadKey}`),
      prompt,
      writers: {
        stderr: process.stderr,
      },
    });

    const reply = outputText.trim().length > 0
      ? outputText
      : "I finished processing that, but I do not have a textual reply to send.";

  await client.slackClient.chat.postMessage({
    channel,
    text: reply,
    thread_ts: threadTs,
  });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[slack:error] ${message}\n`);

    await client.slackClient.chat.postMessage({
      channel,
      text: "I ran into an error while processing that request. Please try again in the same thread.",
      thread_ts: threadTs,
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
  if (!eventId) {
    return false;
  }

  const now = Date.now();
  for (const [id, timestamp] of state.seenEvents.entries()) {
    if (now - timestamp > seenEventTtlMs) {
      state.seenEvents.delete(id);
    }
  }

  if (state.seenEvents.has(eventId)) {
    return true;
  }

  state.seenEvents.set(eventId, now);
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
    process.stdout.write(
      `Slack health check listening on http://${options.host}:${options.port}\n`,
    );
  });
};
