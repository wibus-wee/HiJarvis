import type { LoadedRuntimeConfig } from "./config.js";
import type { HookRegistry } from "./hooks/index.js";
import {
  parseSideQuestionCommand,
  buildDefaultSkillTriggerText,
  type IngressCommand,
  type MessageIngressCommand,
} from "./ingress.js";
import type { Logger } from "./logger.js";
import type { PromptInput } from "./prompt-executor.js";
import { executeSideQuestion } from "./side-question/execute-side-question.js";
import { unregisterLiveThreadForSideQuestion } from "./side-question/live-thread-registry.js";

import {
  initStores,
  loadSession,
  preparePrompt,
  createAgentContext,
  subscribeEvents,
  executeAndFinalize,
} from "./execution/index.js";

// Re-export types and utilities that were previously defined here,
// so the public API surface remains unchanged.
export {
  IngressExecutionError,
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
} from "./execution/types.js";

export const executeIngressCommand = async (options: {
  config: LoadedRuntimeConfig;
  command: IngressCommand;
  logger?: Logger;
  hooks?: HookRegistry;
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

  return executeMessageCommand(options.config, options.command, options.logger, options.hooks);
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
): Promise<MessageIngressResult> => {

  // ── Hook: ingress:before ─────────────────────────────────────
  if (hooks?.has("ingress:before")) {
    const transformed = await hooks.transform("ingress:before", { config, command });
    command = transformed.command;
  }

  const stores = initStores(config, command, logger, hooks);
  let session: Awaited<ReturnType<typeof loadSession>> | undefined;

  try {
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
        session,
        prompt: promptInput,
        skillTriggerText,
      });
      promptInput = transformed.prompt;
      skillTriggerText = transformed.skillTriggerText;
    }

    const prompt = await preparePrompt(session, promptInput, skillTriggerText);

    // ── Hook: prompt:prepared ────────────────────────────────────
    if (hooks?.has("prompt:prepared")) {
      await hooks.tap("prompt:prepared", prompt);
    }

    const agentCtx = await createAgentContext(prompt);
    const subscribed = subscribeEvents(agentCtx);
    const result = await executeAndFinalize(subscribed);

    // ── Hook: response:transform ─────────────────────────────────
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
    // ── Hook: error:caught ───────────────────────────────────────
    if (hooks?.has("error:caught")) {
      await hooks.tap("error:caught", { error, phase: "execution" });
    }
    throw error;
  } finally {
    if (session) {
      unregisterLiveThreadForSideQuestion(session.conversation.threadId);
      // Release the cached conversation handle so memory doesn't grow
      // unboundedly in long-running gateway processes.
      await stores.stateStore.release(session.conversation.threadId).catch(() => {});
    }
  }
};
