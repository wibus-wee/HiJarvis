import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

import {
  compactHistoryNow,
  getUsageInputTokens,
  shouldCompactFromUsage,
} from "./compaction/index.js";
import type { LoadedRuntimeConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { stripMemoryExcludedPromptContextFromMessage } from "./prompt-context.js";
import {
  executePromptWithPolicy,
  type PromptExecutionObserver,
  type PromptInput,
} from "./prompt-executor.js";
import {
  countPromptMessages,
  estimatePromptChars,
  startSessionExecutionTracker,
} from "./session-execution.js";
import { createAgent } from "./runtime.js";
import { openSession, type CompactionEvent, type SessionTurnTrigger } from "./session-store.js";
import { preparePromptWithSkills } from "./skills.js";
import { createDefaultTools } from "./tools.js";

type SessionExecutionWriters = {
  stderr: Pick<NodeJS.WriteStream, "write">;
};

export type SessionPromptOptions = {
  config: LoadedRuntimeConfig;
  sessionId: string;
  prompt: PromptInput;
  onEvent?: (event: AgentEvent) => Promise<void> | void;
  skillTriggerText?: string;
  turnTrigger?: SessionTurnTrigger;
  turnInputMetadata?: Record<string, unknown>;
  serializeMessage?: (message: AgentMessage) => AgentMessage;
  logger?: Logger;
};

export type SessionPromptResult = {
  outputText: string;
  sessionId: string;
  turnId: string;
  runId: string;
};

export class SessionExecutionError extends Error {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly runId?: string;

  constructor(options: {
    message: string;
    sessionId: string;
    turnId?: string;
    runId?: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "SessionExecutionError";
    this.sessionId = options.sessionId;
    if (options.turnId !== undefined) {
      this.turnId = options.turnId;
    }
    if (options.runId !== undefined) {
      this.runId = options.runId;
    }
  }
}

const defaultWriters: SessionExecutionWriters = {
  stderr: process.stderr,
};

export const executePromptInSession = async (
  options: SessionPromptOptions,
): Promise<SessionPromptResult> => {
  const startTime = Date.now();
  let tracker:
    | Awaited<ReturnType<typeof startSessionExecutionTracker>>
    | undefined;

  const { config } = options;
  const agentConfig = config.agent;
  const { skills, toolOptions, sessions } = config;

  const session = await openSession({
    rootDir: sessions.rootDir,
    sessionId: options.sessionId,
    provider: agentConfig.provider,
    model: agentConfig.model,
  });

  const agent = createAgent({
    ...agentConfig,
    tools: createDefaultTools(toolOptions),
    ...(options.logger ? { logger: options.logger } : {}),
    compactionEventSink: (event) => {
      void session.appendEvent(event);
      if (tracker) {
        void tracker.recordCompaction(event);
      }
    },
  });

  agent.sessionId = session.sessionId;
  agent.state.messages = session.messages;
  const logger = options.logger?.child({
    sessionId: session.sessionId,
    provider: agentConfig.provider,
    model: agentConfig.model,
  });
  const serializeMessage =
    options.serializeMessage ?? stripMemoryExcludedPromptContextFromMessage;
  const preparedPrompt = await preparePromptWithSkills(options.prompt, {
    skills,
    ...(options.skillTriggerText === undefined
      ? {}
      : { triggerText: options.skillTriggerText }),
    ...(logger === undefined ? {} : { logger }),
  });
  tracker = await startSessionExecutionTracker({
    session,
    prompt: preparedPrompt.prompt,
    trigger: options.turnTrigger ?? "user_input",
    ...(logger === undefined ? {} : { logger }),
    ...(options.turnInputMetadata === undefined
      ? {}
      : { turnInputMetadata: options.turnInputMetadata }),
  });

  let outputText = "";

  logger?.info("session.prompt_started", {
    turnId: tracker.turnId,
    runId: tracker.runId,
    existingMessages: session.messages.length,
    promptChars: estimatePromptChars(preparedPrompt.prompt),
    promptMessageCount: countPromptMessages(preparedPrompt.prompt),
    skillCount: preparedPrompt.injectedSkills.length,
    skills: preparedPrompt.injectedSkills,
  });
  for (const warning of preparedPrompt.warnings) {
    logger?.warn("skills.injection_failed", {
      turnId: tracker.turnId,
      runId: tracker.runId,
      message: warning,
    });
    await tracker.recordNote({
      kind: "skills_warning",
      message: warning,
    });
  }

  const compactionSettings = agentConfig.compaction;
  const compactionRuntime = {
    model: agent.state.model,
    systemPrompt: agent.state.systemPrompt,
    settings: compactionSettings,
    ...(agentConfig.providerConfig.apiKey
      ? { apiKey: agentConfig.providerConfig.apiKey }
      : {}),
    ...(logger ? { logger } : {}),
  };

  const runPostTurnCompaction = async (
    message: AgentMessage,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!compactionSettings.enabled) {
      return;
    }
    if (message.role !== "assistant") {
      return;
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return;
    }
    if (!shouldCompactFromUsage(message.usage, compactionRuntime)) {
      return;
    }

    const result = await compactHistoryNow(
      agent.state.messages,
      "post_turn",
      compactionRuntime,
      signal,
    );
    agent.state.messages = result.messages;
    await session.writeSnapshot(agent.state.messages.map(serializeMessage));

    const inputTokens = getUsageInputTokens(message.usage);
    const compactionEvent: CompactionEvent = {
      type: "compaction",
      kind: "post_turn",
      tokenEstimateBefore: inputTokens,
      tokenEstimateAfter: result.tokenEstimateAfter,
      summaryTokens: result.summaryTokens,
      ...(result.summaryError ? { summaryError: result.summaryError } : {}),
      ...(result.stageCount === undefined ? {} : { stageCount: result.stageCount }),
      ...(result.stages === undefined ? {} : { stages: result.stages }),
      ...(result.appliedStages === undefined ? { } : { appliedStages: result.appliedStages }),
    };
    await session.appendEvent(compactionEvent);
    if (tracker) {
      await tracker.recordCompaction(compactionEvent);
    }
  };

  agent.subscribe(async (event, signal) => {
    if (signal.aborted) {
      return;
    }

    await session.appendEvent(event);
    await tracker.recordEvent(event);

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      outputText += event.assistantMessageEvent.delta;
    }

    if (event.type === "message_end") {
      await session.appendMessage(serializeMessage(event.message));
      await runPostTurnCompaction(event.message, signal);
    }

    if (event.type === "agent_end") {
      await session.writeSnapshot(agent.state.messages.map(serializeMessage));
    }

    logAgentEvent(logger, tracker.turnId, tracker.runId, event);

    await options.onEvent?.(event);
  });

  const promptObserver: PromptExecutionObserver = {
    onAttemptFailed: async (failure) => {
      await tracker.recordRetryNotice(failure);
    },
    onRetryScheduled: async (event) => {
      await tracker.recordRetryNotice(event);
    },
  };

  try {
    await executePromptWithPolicy(
      agent,
      preparedPrompt.prompt,
      agentConfig.execution,
      defaultWriters,
      logger,
      promptObserver,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await tracker.fail(message);
    logger?.error("session.prompt_failed", {
      turnId: tracker.turnId,
      runId: tracker.runId,
      durationMs: Date.now() - startTime,
      message,
    });
    throw new SessionExecutionError({
      message,
      sessionId: session.sessionId,
      turnId: tracker.turnId,
      runId: tracker.runId,
      cause: error,
    });
  }

  await tracker.complete(outputText);
  logger?.info("session.prompt_finished", {
    turnId: tracker.turnId,
    runId: tracker.runId,
    durationMs: Date.now() - startTime,
    outputChars: outputText.trim().length,
  });

  return {
    outputText,
    sessionId: session.sessionId,
    turnId: tracker.turnId,
    runId: tracker.runId,
  };
};

const logAgentEvent = (
  logger: Logger | undefined,
  turnId: string,
  runId: string,
  event: AgentEvent,
): void => {
  if (!logger) {
    return;
  }

  switch (event.type) {
    case "tool_execution_start":
      logger.info("session.tool_started", {
        turnId,
        runId,
        toolName: event.toolName,
        args: event.args,
      });
      break;
    case "tool_execution_end":
      logger.info("session.tool_finished", {
        turnId,
        runId,
        toolName: event.toolName,
      });
      break;
    case "message_end":
      logger.debug("session.message_recorded", {
        turnId,
        runId,
        role: event.message.role,
      });
      break;
    default:
      break;
  }
};
