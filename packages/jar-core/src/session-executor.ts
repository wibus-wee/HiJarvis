import type { AgentEvent } from "@mariozechner/pi-agent-core";

import type { Logger } from "./logger.js";
import {
  executePromptWithPolicy,
  type PromptExecutionPolicy,
} from "./prompt-executor.js";
import { createAgent, type JarRuntimeOptions } from "./runtime.js";
import { openSession } from "./session-store.js";
import { createTools, type ToolOptions } from "./tools.js";

type SessionExecutionWriters = {
  stderr: Pick<NodeJS.WriteStream, "write">;
};

export type SessionPromptOptions = {
  execution: PromptExecutionPolicy;
  onEvent?: (event: AgentEvent) => Promise<void> | void;
  provider: JarRuntimeOptions["provider"];
  model: JarRuntimeOptions["model"];
  prompt: string;
  sessionId: string;
  sessionsRootDir: string;
  systemPrompt: JarRuntimeOptions["systemPrompt"];
  thinkingLevel: JarRuntimeOptions["thinkingLevel"];
  compaction?: JarRuntimeOptions["compaction"];
  toolOptions: ToolOptions;
  providerConfig: JarRuntimeOptions["providerConfig"];
  logger?: Logger;
  writers?: SessionExecutionWriters;
};

export type SessionPromptResult = {
  outputText: string;
  sessionId: string;
};

const defaultWriters: SessionExecutionWriters = {
  stderr: process.stderr,
};

export const executePromptInSession = async (
  options: SessionPromptOptions,
): Promise<SessionPromptResult> => {
  const startTime = Date.now();
  const session = await openSession({
    rootDir: options.sessionsRootDir,
    sessionId: options.sessionId,
    provider: options.provider,
    model: options.model,
  });

  const agent = createAgent({
    provider: options.provider,
    model: options.model,
    systemPrompt: options.systemPrompt,
    thinkingLevel: options.thinkingLevel,
    providerConfig: options.providerConfig,
    execution: options.execution,
    ...(options.compaction ? { compaction: options.compaction } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    compactionEventSink: (event) => {
      void session.appendEvent(event);
    },
    tools: createTools(options.toolOptions),
  });

  agent.sessionId = session.sessionId;
  agent.state.messages = session.messages;
  const logger = options.logger?.child({
    sessionId: session.sessionId,
    provider: options.provider,
    model: options.model,
  });

  let outputText = "";

  logger?.info("session.prompt_started", {
    existingMessages: session.messages.length,
    promptChars: options.prompt.length,
  });

  agent.subscribe(async (event, signal) => {
    if (signal.aborted) {
      return;
    }

    await session.appendEvent(event);

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      outputText += event.assistantMessageEvent.delta;
    }

    if (event.type === "message_end") {
      await session.appendMessage(event.message);
    }

    if (event.type === "agent_end") {
      await session.writeSnapshot(agent.state.messages);
    }

    logAgentEvent(logger, event);

    await options.onEvent?.(event);
  });

  try {
    await executePromptWithPolicy(
      agent,
      options.prompt,
      options.execution,
      options.writers ?? defaultWriters,
      logger,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.error("session.prompt_failed", {
      durationMs: Date.now() - startTime,
      message,
    });
    throw error;
  }

  logger?.info("session.prompt_finished", {
    durationMs: Date.now() - startTime,
    outputChars: outputText.trim().length,
  });

  return {
    outputText,
    sessionId: session.sessionId,
  };
};

const logAgentEvent = (logger: Logger | undefined, event: AgentEvent): void => {
  if (!logger) {
    return;
  }

  switch (event.type) {
    case "tool_execution_start":
      logger.info("session.tool_started", {
        toolName: event.toolName,
        args: event.args,
      });
      break;
    case "tool_execution_end":
      logger.info("session.tool_finished", {
        toolName: event.toolName,
      });
      break;
    case "message_end":
      logger.debug("session.message_recorded", {
        role: event.message.role,
      });
      break;
    default:
      break;
  }
};
