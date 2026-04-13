import type { AgentMessage } from "@mariozechner/pi-agent-core";

import {
  compactHistoryNow,
  getUsageInputTokens,
  shouldCompactFromUsage,
} from "../compaction/index.js";
import type { CompactionEvent } from "../execution-types.js";
import { stripMemoryExcludedPromptContextFromMessage } from "../prompt-context.js";
import type { AgentContext, SubscribedContext } from "./types.js";

export const subscribeEvents = (ctx: AgentContext): SubscribedContext => {
  const outputRef = { text: "" };
  const serializeMessage = stripMemoryExcludedPromptContextFromMessage;

  const runPostTurnCompaction = async (
    message: AgentMessage,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!ctx.config.agent.compaction.enabled || message.role !== "assistant") {
      return;
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return;
    }
    if (!shouldCompactFromUsage(message.usage, ctx.compactionRuntime)) {
      return;
    }

    const result = await compactHistoryNow(
      ctx.agent.state.messages,
      "post_turn",
      ctx.compactionRuntime,
      signal,
    );
    ctx.agent.state.messages = result.messages;
    ctx.refreshLiveCapture();
    await ctx.stateStore.applyCheckpoint({
      threadId: ctx.conversation.threadId,
      messages: ctx.agent.state.messages.map(serializeMessage),
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
    await ctx.eventStore.appendEvent(ctx.conversation.threadId, compactionEvent);
    await ctx.tracker.recordCompaction(compactionEvent);
  };

  ctx.agent.subscribe(async (event, signal) => {
    if (signal.aborted) {
      return;
    }
    await ctx.eventStore.appendEvent(ctx.conversation.threadId, event);
    await ctx.tracker.recordEvent(event);
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      outputRef.text += event.assistantMessageEvent.delta;
      ctx.refreshLiveCapture();
    }
    if (event.type === "message_end") {
      const message = serializeMessage(event.message);
      await ctx.stateStore.appendMessage({
        threadId: ctx.conversation.threadId,
        message,
      });
      ctx.agent.state.messages = [...ctx.agent.state.messages.slice(0, -1), message];
      ctx.refreshLiveCapture();
      await runPostTurnCompaction(event.message, signal);
    }
    if (event.type === "agent_end") {
      await ctx.stateStore.flush(ctx.conversation.threadId);
    }
    await ctx.command.execution?.onEvent?.(event);
  });

  return {
    ...ctx,
    outputRef,
  };
};
