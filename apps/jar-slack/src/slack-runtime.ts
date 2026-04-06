import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  executePromptInSession,
  loadAgentConfig,
  type LoadedAgentConfig,
} from "@hijarvis/jar-core";
import {
  Chat,
  type Adapter,
  type Message,
  type MessageContext,
  type Thread,
} from "chat";
import { z } from "zod";

import {
  buildSubscribedThreadPrompt,
  createSlackSessionId,
  formatCurrentMessageBlock,
  formatObservedContextBlock,
  formatQueuedMessagesBlock,
} from "./slack-prompt.js";

const slackGatewayEnvSchema = z.object({
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

const defaultObservedContextLimits: ObservedContextLimits = {
  lookbackMinutes: 15,
  maxMessages: 12,
};

const defaultHost = "0.0.0.0";
const defaultPort = 3000;

export const startSlackGateway = async (
  options: SlackGatewayRuntimeOptions,
): Promise<void> => {
  const config = await loadAgentConfig(options.configPath);
  const env = loadSlackGatewayEnv(process.env);
  const bot = createSlackBot(config, env);
  const host = options.host ?? env.HOST ?? defaultHost;
  const port = options.port ?? env.PORT ?? defaultPort;

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      if (request.method !== "POST" || request.url !== "/webhooks/slack") {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      const webhookRequest = toWebRequest(request, host, port);
      const webhookHandler = bot.webhooks.slack;
      if (!webhookHandler) {
        throw new Error("Slack webhook handler is not registered.");
      }

      const webhookResponse = await webhookHandler(webhookRequest);
      await writeWebResponse(response, webhookResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.statusCode = 500;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end(message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  process.stdout.write(
    `Jar Slack gateway listening on http://${host}:${port} using ${path.resolve(options.configPath)}\n`,
  );
};

export const createSlackBot = (
  config: LoadedAgentConfig,
  env: SlackGatewayEnv,
): Chat => {
  const observedContextLimits = {
    lookbackMinutes:
      env.JARVIS_SLACK_CONTEXT_LOOKBACK_MINUTES ??
      defaultObservedContextLimits.lookbackMinutes,
    maxMessages:
      env.JARVIS_SLACK_CONTEXT_MESSAGE_LIMIT ??
      defaultObservedContextLimits.maxMessages,
  };

  const bot = new Chat({
    userName: env.JARVIS_SLACK_BOT_NAME ?? "jarvis",
    adapters: {
      slack: createSlackAdapter() as unknown as Adapter,
    },
    state: createMemoryState(),
    concurrency: {
      strategy: "queue",
      maxQueueSize: 20,
      onQueueFull: "drop-oldest",
      queueEntryTtlMs: 60_000,
    },
  });

  bot.onNewMention(async (thread, message, context) => {
    await thread.subscribe();
    await respondInSlackThread({
      config,
      prompt: await buildMentionPrompt(
        thread,
        message,
        context,
        observedContextLimits,
      ),
      thread,
    });
  });

  bot.onSubscribedMessage(async (thread, message, context) => {
    await respondInSlackThread({
      config,
      prompt: buildSubscribedThreadPrompt(message, context),
      thread,
    });
  });

  bot.onDirectMessage(async (thread, message, _channel, context) => {
    await thread.subscribe();
    await respondInSlackThread({
      config,
      prompt: buildSubscribedThreadPrompt(message, context),
      thread,
    });
  });

  return bot;
};

const respondInSlackThread = async ({
  config,
  prompt,
  thread,
}: {
  config: LoadedAgentConfig;
  prompt: string;
  thread: Thread;
}): Promise<void> => {
  try {
    await thread.startTyping();

    const { outputText } = await executePromptInSession({
      ...config.runtime,
      toolOptions: config.toolOptions,
      sessionsRootDir: config.sessions.rootDir,
      sessionId: createSlackSessionId(thread.id),
      prompt,
      writers: {
        stderr: process.stderr,
      },
    });

    const reply = outputText.trim().length > 0
      ? outputText
      : "I finished processing that, but I do not have a textual reply to send.";

    await thread.post(reply);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[slack:error] ${message}\n`);
    await thread.post(
      "I ran into an error while processing that request. Please try again in the same thread.",
    );
  }
};

const buildMentionPrompt = async (
  thread: Thread,
  message: Message,
  context: MessageContext | undefined,
  limits: ObservedContextLimits,
): Promise<string> => {
  const observedMessages = await collectObservedChannelMessages(
    thread,
    message,
    limits,
  );

  return [
    "You are replying inside a Slack thread that was created from a channel mention.",
    "Use the observed channel context to understand what happened immediately before the mention.",
    "Do not claim to remember channel history beyond the observed context provided below.",
    "",
    formatObservedContextBlock(observedMessages),
    "",
    formatQueuedMessagesBlock(context),
    "",
    formatCurrentMessageBlock(message),
  ]
    .filter((segment) => segment.trim().length > 0)
    .join("\n");
};

const collectObservedChannelMessages = async (
  thread: Thread,
  currentMessage: Message,
  limits: ObservedContextLimits,
): Promise<Message[]> => {
  const cutoffTime =
    currentMessage.metadata.dateSent.getTime() - limits.lookbackMinutes * 60_000;
  const messages: Message[] = [];

  for await (const candidate of thread.channel.messages) {
    if (candidate.id === currentMessage.id) {
      continue;
    }

    const sentAt = candidate.metadata.dateSent.getTime();
    if (sentAt >= currentMessage.metadata.dateSent.getTime()) {
      continue;
    }

    if (sentAt < cutoffTime) {
      break;
    }

    if (candidate.author.isBot) {
      continue;
    }

    messages.push(candidate);
    if (messages.length >= limits.maxMessages) {
      break;
    }
  }

  return messages.reverse();
};
const loadSlackGatewayEnv = (
  rawEnv: NodeJS.ProcessEnv,
): SlackGatewayEnv => {
  return slackGatewayEnvSchema.parse(rawEnv);
};

const toWebRequest = (
  request: IncomingMessage,
  host: string,
  port: number,
): Request => {
  const method = request.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
      continue;
    }

    headers.set(name, value);
  }

  const url = new URL(request.url ?? "/", `http://${resolveHostHeader(request.headers, host, port)}`);
  const body = method === "GET" || method === "HEAD"
    ? null
    : (Readable.toWeb(request) as ReadableStream<Uint8Array>);

  if (body === null) {
    return new Request(url, {
      method,
      headers,
    });
  }

  return new Request(url, {
    method,
    headers,
    body,
    duplex: "half",
  });
};

const resolveHostHeader = (
  headers: IncomingHttpHeaders,
  fallbackHost: string,
  fallbackPort: number,
): string => {
  const hostHeader = headers.host?.trim();
  if (hostHeader && hostHeader.length > 0) {
    return hostHeader;
  }

  return `${fallbackHost}:${fallbackPort}`;
};

const writeWebResponse = async (
  response: ServerResponse,
  webhookResponse: Response,
): Promise<void> => {
  response.statusCode = webhookResponse.status;

  webhookResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });

  const body = webhookResponse.body === null
    ? undefined
    : Buffer.from(await webhookResponse.arrayBuffer());

  response.end(body);
};
