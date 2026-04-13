import type { AgentMessage } from "@mariozechner/pi-agent-core";

import {
  compactHistoryNow,
  getUsageInputTokens,
  shouldCompactFromUsage,
} from "../compaction/index.js";
import type { CompactionEvent, UsageRecord } from "../execution-types.js";
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
      summaryError: result.summaryError,
      stageCount: result.stageCount,
      stages: result.stages,
      appliedStages: result.appliedStages,
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

    // ── Hook: agent:event ──────────────────────────────────────
    if (ctx.hooks?.has("agent:event")) {
      await ctx.hooks.tap("agent:event", {
        event,
        threadId: ctx.conversation.threadId,
      });
    }

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

      if ("role" in event.message && event.message.role === "assistant" && event.message.usage) {
        const usage = event.message.usage;
        const identityId = ctx.command.source.identityId;
        const entityId = identityId
          ? ctx.config.platformIdentities[identityId]?.entityId
          : undefined;
        const record: UsageRecord = {
          type: "usage",
          threadId: ctx.conversation.threadId,
          turnId: ctx.tracker.turnId,
          runId: ctx.tracker.runId,
          identityId,
          entityId,
          platform: ctx.command.source.platform,
          model: ctx.config.agent.model,
          provider: ctx.config.agent.provider,
          usage: {
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheReadTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
            totalTokens: usage.totalTokens,
          },
          cost: { ...usage.cost },
          recordedAt: Date.now(),
        };
        try {
          await ctx.usageStore.appendUsage(record);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.requestLogger?.warn("usage.record_failed", { message });
        }
      }
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
