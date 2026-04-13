import type { LoadedRuntimeConfig } from "./config.js";
import {
  parseSideQuestionCommand,
  type IngressCommand,
  type MessageIngressCommand,
} from "./ingress.js";
import type { Logger } from "./logger.js";
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
): Promise<MessageIngressResult> => {
  const stores = initStores(config, command, logger);
  const session = await loadSession(stores);

  try {
    const prompt = await preparePrompt(session);
    const agentCtx = await createAgentContext(prompt);
    const subscribed = subscribeEvents(agentCtx);
    return await executeAndFinalize(subscribed);
  } finally {
    unregisterLiveThreadForSideQuestion(session.conversation.threadId);
  }
};
