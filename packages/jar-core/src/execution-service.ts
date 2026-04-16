import type { LoadedRuntimeConfig } from "./config.js";
import type { HookRegistry } from "./hooks/index.js";
import {
  parseSideQuestionCommand,
  buildDefaultSkillTriggerText,
  type IngressCommand,
  type MessageIngressCommand,
} from "./ingress.js";
import type { Logger } from "./logger.js";
import type { MemoryProviderFactory } from "./memory/index.js";
import type { PromptInput } from "./prompt-executor.js";
import { executeSideQuestion } from "./side-question/execute-side-question.js";
import { unregisterLiveThreadForSideQuestion } from "./side-question/live-thread-registry.js";
import type { PromptSection } from "./prompt-builder.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";

import {
  initStores,
  loadSession,
  preparePrompt,
  createAgentContext,
  subscribeEvents,
  executeAndFinalize,
} from "./execution/index.js";
import {
  attachFaultEnvelope,
  classifyError,
  getFaultEnvelope,
  serializeFaultError,
  type FaultEnvelope,
} from "./fault.js";

// Re-export types and utilities that were previously defined here,
// so the public API surface remains unchanged.
export {
  type MessageIngressResult,
  type SideQuestionIngressResult,
  type IngressResult,
} from "./execution/types.js";
export {
  resolveEntityMemoryScope,
  resolveMessageTools,
} from "./execution/resolve-tools.js";

import type {
  MessageIngressResult,
  SideQuestionIngressResult,
  IngressResult,
  PreparedPromptContext,
} from "./execution/types.js";

export const executeIngressCommand = async (options: {
  config: LoadedRuntimeConfig;
  command: IngressCommand;
  logger?: Logger;
  hooks?: HookRegistry;
  pluginOverrides?: {
    skillRoots?: string[];
    overlays?: PromptSection[];
    tools?: AgentTool[];
    memoryProvider?: MemoryProviderFactory;
  };
}): Promise<IngressResult> => {
  if (options.command.kind === "side_question") {
    const result = await executeSideQuestion({
      config: options.config,
      parentThreadId: options.command.parentThreadId,
      question: options.command.question.text,
      skillTriggerText: options.command.question.text,
      logger: options.logger,
    });
    return {
      kind: "side_question",
      outputText: result.outputText,
      parentThreadId: result.parentThreadId,
      capturedAt: result.capturedAt,
    };
  }

  return executeMessageCommand(
    options.config,
    options.command,
    options.logger,
    options.hooks,
    options.pluginOverrides,
  );
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
    logger: options.logger,
  });
  return {
    handled: true,
    result: result as SideQuestionIngressResult,
  };
};

// ── Core pipeline ─────────────────────────────────────────────

const executeMessageCommand = async (
  config: LoadedRuntimeConfig,
  command: MessageIngressCommand,
  logger?: Logger,
  hooks?: HookRegistry,
  pluginOverrides?: {
    skillRoots?: string[];
    overlays?: PromptSection[];
    tools?: AgentTool[];
    memoryProvider?: MemoryProviderFactory;
  },
): Promise<MessageIngressResult> => {

  // ── Hook: ingress:before ─────────────────────────────────────
  if (hooks?.has("ingress:before")) {
    const transformed = await hooks.transform("ingress:before", { config, command });
    command = transformed.command;
  }

  const stores = await initStores(config, command, logger, hooks, pluginOverrides);
  let session: Awaited<ReturnType<typeof loadSession>> | undefined;
  let tracker: PreparedPromptContext["tracker"] | undefined;
  let phase: FaultEnvelope["phase"] = "ingress";

  try {
    phase = "session";
    session = await loadSession(stores);

    // ── Hook: session:loaded ─────────────────────────────────────
    if (hooks?.has("session:loaded")) {
      await hooks.tap("session:loaded", session);
    }

    // ── Hook: prompt:transform ───────────────────────────────────
    let promptInput: PromptInput = command.prompt;
    let skillTriggerText = command.skillTriggerText ?? buildDefaultSkillTriggerText(command);

    if (hooks?.has("prompt:transform")) {
      const transformed = await hooks.transform("prompt:transform", {
        config,
        command,
        session,
        prompt: promptInput,
        skillTriggerText,
      });
      promptInput = transformed.prompt;
      skillTriggerText = transformed.skillTriggerText;
    }

    phase = "prompt";
    const prompt = await preparePrompt(session, promptInput, skillTriggerText);
    tracker = prompt.tracker;

    // ── Hook: prompt:prepared ────────────────────────────────────
    if (hooks?.has("prompt:prepared")) {
      await hooks.tap("prompt:prepared", prompt);
    }

    phase = "agent";
    const agentCtx = await createAgentContext(prompt);
    const subscribed = subscribeEvents(agentCtx);
    phase = "execution";
    const result = await executeAndFinalize(subscribed);

    // ── Hook: response:transform ─────────────────────────────────
    phase = "response";
    const durationMs = Date.now() - stores.startTime;
    if (hooks?.has("response:transform")) {
      const transformed = await hooks.transform("response:transform", {
        result,
        durationMs,
      });
      result.outputText = transformed.outputText;
    }

    // ── Hook: response:complete ──────────────────────────────────
    if (hooks?.has("response:complete")) {
      await hooks.tap("response:complete", { result, durationMs });
    }

    return result;
  } catch (error) {
    const durationMs = Date.now() - stores.startTime;
    const existingEnvelope = getFaultEnvelope(error);
    const envelope: FaultEnvelope = existingEnvelope ?? {
      fault: classifyError(error),
      phase,
      threadId: session?.conversation.threadId,
      turnId: tracker?.turnId,
      runId: tracker?.runId,
      startedAt: stores.startTime,
      durationMs,
    };
    const wrapped = existingEnvelope ? error : attachFaultEnvelope(error, envelope);

    session?.requestLogger?.error("thread.execution_failed", {
      phase: envelope.phase,
      durationMs,
      threadId: envelope.threadId,
      turnId: envelope.turnId,
      runId: envelope.runId,
      fault: envelope.fault,
      error: serializeFaultError(wrapped),
    });

    // ── Hook: error:caught ───────────────────────────────────────
    if (hooks?.has("error:caught")) {
      await hooks.tap("error:caught", { error: wrapped, phase: envelope.phase, envelope });
    }
    throw wrapped;
  } finally {
    if (session) {
      unregisterLiveThreadForSideQuestion(session.conversation.threadId);
      // Release the cached conversation handle so memory doesn't grow
      // unboundedly in long-running gateway processes.
      await stores.stateStore.release(session.conversation.threadId).catch(() => {});
    }
  }
};
