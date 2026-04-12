import type { AgentEvent, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";

import {
  compactHistoryNow,
  getUsageInputTokens,
  shouldCompactFromUsage,
} from "./compaction/index.js";
import type { LoadedRuntimeConfig } from "./config.js";
import type { CompactionEvent } from "./execution-types.js";
import {
  buildDefaultSkillTriggerText,
  buildTurnInputMetadata,
  parseSideQuestionCommand,
  type IngressCommand,
  type MessageIngressCommand,
} from "./ingress.js";
import type { Logger } from "./logger.js";
import {
  FileSystemMemoryProvider,
  type MemoryProvider,
} from "./memory/index.js";
import {
  createFileSystemConversationStateStore,
  createFileSystemEventLogStore,
  createFileSystemExecutionAuditStore,
} from "./persistence.js";
import {
  executePromptWithPolicy,
  type PromptExecutionObserver,
} from "./prompt-executor.js";
import { stripMemoryExcludedPromptContextFromMessage } from "./prompt-context.js";
import { createAgent } from "./runtime.js";
import { executeSideQuestion } from "./side-question/execute-side-question.js";
import {
  registerLiveThreadForSideQuestion,
  unregisterLiveThreadForSideQuestion,
  updateLiveThreadCaptureForSideQuestion,
} from "./side-question/live-thread-registry.js";
import { preparePromptWithSkills } from "./skills.js";
import { startThreadExecutionTracker } from "./thread-execution.js";
import { createDefaultTools, createMemoryTools } from "./tools.js";

export type MessageIngressResult = {
  kind: "message";
  outputText: string;
  threadId: string;
  turnId: string;
  runId: string;
};

export type SideQuestionIngressResult = {
  kind: "side_question";
  outputText: string;
  parentThreadId: string;
  capturedAt: number;
};

export type IngressResult = MessageIngressResult | SideQuestionIngressResult;

export class IngressExecutionError extends Error {
  readonly threadId?: string;
  readonly turnId?: string;
  readonly runId?: string;

  constructor(options: {
    message: string;
    threadId?: string;
    turnId?: string;
    runId?: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "IngressExecutionError";
    if (options.threadId !== undefined) {
      this.threadId = options.threadId;
    }
    if (options.turnId !== undefined) {
      this.turnId = options.turnId;
    }
    if (options.runId !== undefined) {
      this.runId = options.runId;
    }
  }
}

const defaultWriters = {
  stderr: process.stderr,
};

export const executeIngressCommand = async (options: {
  config: LoadedRuntimeConfig;
  command: IngressCommand;
  logger?: Logger;
}): Promise<IngressResult> => {
  if (options.command.kind === "side_question") {
    const result = await executeSideQuestion({
      config: options.config,
      parentThreadId: options.command.parentThreadId,
      question: options.command.question.text,
      skillTriggerText: options.command.question.text,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    return {
      kind: "side_question",
      outputText: result.outputText,
      parentThreadId: result.parentThreadId,
      capturedAt: result.capturedAt,
    };
  }

  return executeMessageCommand(options.config, options.command, options.logger);
};

export const maybeExecuteSideQuestionIngress = async (options: {
  config: LoadedRuntimeConfig;
  input: string;
  parentThreadId: string;
  source: IngressCommand["source"];
  logger?: Logger;
}): Promise<{ handled: false } | { handled: true; result: SideQuestionIngressResult }> => {
  const parsed = parseSideQuestionCommand({
    input: options.input,
    parentThreadId: options.parentThreadId,
    source: options.source,
  });
  if (parsed === null) {
    return { handled: false };
  }

  const result = await executeIngressCommand({
    config: options.config,
    command: parsed,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return {
    handled: true,
    result: result as SideQuestionIngressResult,
  };
};

export const resolveEntityMemoryScope = (
  config: LoadedRuntimeConfig,
  command: MessageIngressCommand,
): string => {
  const identityId = command.routing.identityId;
  if (identityId !== undefined) {
    const identity = config.platformIdentities[identityId];
    if (identity !== undefined) {
      return identity.entityId;
    }
  }

  const firstEntity = Object.keys(config.entities)[0];
  return firstEntity ?? "default";
};

const createMemoryProvider = (config: LoadedRuntimeConfig): MemoryProvider => {
  if (config.memory.provider !== "filesystem") {
    throw new Error(`Unsupported memory provider "${config.memory.provider}"`);
  }

  return new FileSystemMemoryProvider({ rootDir: config.memory.rootDir });
};

export const resolveMessageTools = (
  config: LoadedRuntimeConfig,
  command: MessageIngressCommand,
  dependencies: {
    createDefaultTools?: typeof createDefaultTools;
    createMemoryTools?: (entityId: string, provider: MemoryProvider) => AgentTool[];
    createMemoryProvider?: (config: LoadedRuntimeConfig) => MemoryProvider;
  } = {},
): AgentTool[] => {
  const defaultTools = (dependencies.createDefaultTools ?? createDefaultTools)(config.toolOptions);
  if (!config.memory.enabled) {
    return defaultTools;
  }

  const entityId = resolveEntityMemoryScope(config, command);
  const provider = (dependencies.createMemoryProvider ?? createMemoryProvider)(config);
  const memoryTools = (dependencies.createMemoryTools ?? createMemoryTools)(entityId, provider);
  return [...defaultTools, ...memoryTools];
};

const executeMessageCommand = async (
  config: LoadedRuntimeConfig,
  command: MessageIngressCommand,
  logger?: Logger,
): Promise<MessageIngressResult> => {
  const stateStore = createFileSystemConversationStateStore();
  const auditStore = createFileSystemExecutionAuditStore();
  const eventStore = createFileSystemEventLogStore();
  const startTime = Date.now();

  const conversation = await stateStore.load(command.routing, config);
  registerLiveThreadForSideQuestion({
    threadId: conversation.threadId,
    laneId: conversation.laneId,
  });

  try {
    const requestLogger = logger?.child({
      threadId: conversation.threadId,
      provider: config.agent.provider,
      model: config.agent.model,
    });
    const skillTriggerText = command.skillTriggerText ?? buildDefaultSkillTriggerText(command);
    const prepared = await preparePromptWithSkills(command.prompt, {
      skills: config.skills,
      triggerText: skillTriggerText,
      ...(requestLogger === undefined ? {} : { logger: requestLogger }),
    });

    const tracker = await startThreadExecutionTracker({
      threadId: conversation.threadId,
      auditStore,
      prompt: prepared.prompt,
      trigger: command.audit.trigger,
      ...(requestLogger === undefined ? {} : { logger: requestLogger }),
      turnInputMetadata: buildTurnInputMetadata(command),
    });

    const agent = createAgent({
      ...config.agent,
      tools: resolveMessageTools(config, command),
      ...(requestLogger ? { logger: requestLogger } : {}),
      compactionEventSink: (event) => {
        void eventStore.appendEvent(conversation.threadId, event);
        void tracker.recordCompaction(event);
      },
    });
    agent.sessionId = conversation.threadId;
    agent.state.messages = [...conversation.messages];

    const refreshLiveCapture = () => {
      updateLiveThreadCaptureForSideQuestion(conversation.threadId, {
        threadId: conversation.threadId,
        laneId: conversation.laneId,
        capturedAt: Date.now(),
        messages: agent.state.messages.map((message) => structuredClone(message)),
      });
    };

    refreshLiveCapture();

    let outputText = "";
    const serializeMessage = stripMemoryExcludedPromptContextFromMessage;
    const compactionRuntime = {
      model: agent.state.model,
      systemPrompt: agent.state.systemPrompt,
      settings: config.agent.compaction,
      ...(config.agent.providerConfig.apiKey
        ? { apiKey: config.agent.providerConfig.apiKey }
        : {}),
      ...(requestLogger ? { logger: requestLogger } : {}),
    };

    for (const warning of prepared.warnings) {
      await tracker.recordNote({
        kind: "skills_warning",
        message: warning,
      });
    }

    const runPostTurnCompaction = async (
      message: AgentMessage,
      signal: AbortSignal,
    ): Promise<void> => {
      if (!config.agent.compaction.enabled || message.role !== "assistant") {
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
      refreshLiveCapture();
      await stateStore.applyCheckpoint({
        threadId: conversation.threadId,
        messages: agent.state.messages.map(serializeMessage),
        sourceOffsets: [],
      });

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
        ...(result.appliedStages === undefined ? {} : { appliedStages: result.appliedStages }),
      };
      await eventStore.appendEvent(conversation.threadId, compactionEvent);
      await tracker.recordCompaction(compactionEvent);
    };

    agent.subscribe(async (event, signal) => {
      if (signal.aborted) {
        return;
      }
      await eventStore.appendEvent(conversation.threadId, event);
      await tracker.recordEvent(event);
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        outputText += event.assistantMessageEvent.delta;
        refreshLiveCapture();
      }
      if (event.type === "message_end") {
        const message = serializeMessage(event.message);
        await stateStore.appendMessage({
          threadId: conversation.threadId,
          message,
        });
        agent.state.messages = [...agent.state.messages.slice(0, -1), message];
        refreshLiveCapture();
        await runPostTurnCompaction(event.message, signal);
      }
      if (event.type === "agent_end") {
        await stateStore.flush(conversation.threadId);
      }
      await command.execution?.onEvent?.(event);
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
        prepared.prompt,
        config.agent.execution,
        defaultWriters,
        requestLogger,
        promptObserver,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await tracker.fail(message);
      requestLogger?.error("thread.prompt_failed", {
        turnId: tracker.turnId,
        runId: tracker.runId,
        durationMs: Date.now() - startTime,
        message,
      });
      throw new IngressExecutionError({
        message,
        threadId: conversation.threadId,
        turnId: tracker.turnId,
        runId: tracker.runId,
        cause: error,
      });
    }

    await tracker.complete(outputText);
    requestLogger?.info("thread.prompt_finished", {
      turnId: tracker.turnId,
      runId: tracker.runId,
      durationMs: Date.now() - startTime,
      outputChars: outputText.trim().length,
    });

    return {
      kind: "message",
      outputText,
      threadId: conversation.threadId,
      turnId: tracker.turnId,
      runId: tracker.runId,
    };
  } finally {
    unregisterLiveThreadForSideQuestion(conversation.threadId);
  }
};
