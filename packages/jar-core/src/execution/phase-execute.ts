import {
  executePromptWithPolicy,
  type PromptExecutionObserver,
} from "../prompt-executor.js";
import { IngressExecutionError, type MessageIngressResult, type SubscribedContext } from "./types.js";

const defaultWriters = {
  stderr: process.stderr,
};

export const executeAndFinalize = async (ctx: SubscribedContext): Promise<MessageIngressResult> => {
  const promptObserver: PromptExecutionObserver = {
    onAttemptFailed: async (failure) => {
      await ctx.tracker.recordRetryNotice(failure);
    },
    onRetryScheduled: async (event) => {
      await ctx.tracker.recordRetryNotice(event);
    },
  };

  try {
    await executePromptWithPolicy(
      ctx.agent,
      ctx.prepared.prompt,
      ctx.config.agent.execution,
      defaultWriters,
      ctx.requestLogger,
      promptObserver,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.tracker.fail(message);
    ctx.requestLogger?.error("thread.prompt_failed", {
      turnId: ctx.tracker.turnId,
      runId: ctx.tracker.runId,
      durationMs: Date.now() - ctx.startTime,
      message,
    });
    throw new IngressExecutionError({
      message,
      threadId: ctx.conversation.threadId,
      turnId: ctx.tracker.turnId,
      runId: ctx.tracker.runId,
      cause: error,
    });
  }

  await ctx.tracker.complete(ctx.outputRef.text);
  ctx.requestLogger?.info("thread.prompt_finished", {
    turnId: ctx.tracker.turnId,
    runId: ctx.tracker.runId,
    durationMs: Date.now() - ctx.startTime,
    outputChars: ctx.outputRef.text.trim().length,
  });

  return {
    kind: "message",
    outputText: ctx.outputRef.text,
    threadId: ctx.conversation.threadId,
    turnId: ctx.tracker.turnId,
    runId: ctx.tracker.runId,
  };
};
