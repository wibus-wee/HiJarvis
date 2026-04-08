import type { AgentEvent, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";

import {
  compactHistoryNow,
  defaultCompactionSettings,
  getUsageInputTokens,
  shouldCompactFromUsage,
} from "./compaction.js";
import type { Logger } from "./logger.js";
import { stripMemoryExcludedPromptContextFromMessage } from "./prompt-context.js";
import {
  executePromptWithPolicy,
  type PromptExecutionObserver,
  type PromptExecutionPolicy,
  type PromptInput,
} from "./prompt-executor.js";
import {
  countPromptMessages,
  estimatePromptChars,
  startSessionExecutionTracker,
} from "./session-execution.js";
import { createAgent, type JarRuntimeOptions } from "./runtime.js";
import { openSession, type CompactionEvent, type SessionTurnTrigger } from "./session-store.js";
import {
  getSkillsCatalogOverlays,
  preparePromptWithSkills,
  type SkillsRuntime,
} from "./skills.js";
import { createDefaultTools, type ToolOptions } from "./tools.js";

type SessionExecutionWriters = {
  stderr: Pick<NodeJS.WriteStream, "write">;
};

export type SessionPromptOptions = {
  execution: PromptExecutionPolicy;
  onEvent?: (event: AgentEvent) => Promise<void> | void;
  provider: JarRuntimeOptions["provider"];
  model: JarRuntimeOptions["model"];
  prompt: PromptInput;
  skillTriggerText?: string;
  sessionId: string;
  sessionsRootDir: string;
  systemPrompt: JarRuntimeOptions["systemPrompt"];
  systemPromptOverlays?: JarRuntimeOptions["systemPromptOverlays"];
  skills?: SkillsRuntime;
  thinkingLevel: JarRuntimeOptions["thinkingLevel"];
  compaction?: JarRuntimeOptions["compaction"];
  tools?: AgentTool[];
  toolOptions?: ToolOptions;
  providerConfig: JarRuntimeOptions["providerConfig"];
  logger?: Logger;
  serializeMessage?: (message: AgentMessage) => AgentMessage;
  turnTrigger?: SessionTurnTrigger;
  turnInputMetadata?: Record<string, unknown>;
  writers?: SessionExecutionWriters;
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
  const session = await openSession({
    rootDir: options.sessionsRootDir,
    sessionId: options.sessionId,
    provider: options.provider,
    model: options.model,
  });

  const resolvedTools = options.tools ?? (
    options.toolOptions
      ? createDefaultTools(options.toolOptions)
      : []
  );
  const skillOverlays = getSkillsCatalogOverlays(options.skills);
  const systemPromptOverlays = [
    ...(options.systemPromptOverlays ?? []),
    ...skillOverlays,
  ];

  const agent = createAgent({
    provider: options.provider,
    model: options.model,
    systemPrompt: options.systemPrompt,
    systemPromptOverlays,
    thinkingLevel: options.thinkingLevel,
    providerConfig: options.providerConfig,
    execution: options.execution,
    ...(options.compaction ? { compaction: options.compaction } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    compactionEventSink: (event) => {
      void session.appendEvent(event);
      if (tracker) {
        void tracker.recordCompaction(event);
      }
    },
    tools: resolvedTools,
  });

  agent.sessionId = session.sessionId;
  agent.state.messages = session.messages;
  const logger = options.logger?.child({
    sessionId: session.sessionId,
    provider: options.provider,
    model: options.model,
  });
  const serializeMessage =
    options.serializeMessage ?? stripMemoryExcludedPromptContextFromMessage;
  const preparedPrompt = await preparePromptWithSkills(options.prompt, {
    ...(options.skills === undefined ? {} : { skills: options.skills }),
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

  const compactionSettings =
    options.compaction ?? defaultCompactionSettings;
  const compactionRuntime = {
    model: agent.state.model,
    systemPrompt: agent.state.systemPrompt,
    settings: compactionSettings,
    ...(options.providerConfig.apiKey
      ? { apiKey: options.providerConfig.apiKey }
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
    await session.writeSnapshot(
      agent.state.messages.map(serializeMessage),
    );

    const inputTokens = getUsageInputTokens(message.usage);
    const compactionEvent: CompactionEvent = {
      type: "compaction",
      kind: "post_turn",
      tokenEstimateBefore: inputTokens,
      tokenEstimateAfter: result.tokenEstimateAfter,
      summaryTokens: result.summaryTokens,
      ...(result.summaryError ? { summaryError: result.summaryError } : {}),
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
      await session.writeSnapshot(
        agent.state.messages.map(serializeMessage),
      );
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
      options.execution,
      options.writers ?? defaultWriters,
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
