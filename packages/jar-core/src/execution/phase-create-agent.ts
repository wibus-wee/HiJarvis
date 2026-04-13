import { createAgent } from "../runtime.js";
import {
  updateLiveThreadCaptureForSideQuestion,
} from "../side-question/live-thread-registry.js";
import { resolveMessageTools } from "./resolve-tools.js";
import type { AgentContext, PreparedPromptContext } from "./types.js";

export const createAgentContext = async (ctx: PreparedPromptContext): Promise<AgentContext> => {
  const tools = await resolveMessageTools(ctx.config, ctx.command);

  const agent = createAgent({
    ...ctx.config.agent,
    tools,
    ...(ctx.requestLogger ? { logger: ctx.requestLogger } : {}),
    compactionEventSink: (event) => {
      void ctx.eventStore.appendEvent(ctx.conversation.threadId, event);
      void ctx.tracker.recordCompaction(event);
    },
  });
  agent.sessionId = ctx.conversation.threadId;
  agent.state.messages = [...ctx.conversation.messages];

  const compactionRuntime = {
    model: agent.state.model,
    systemPrompt: agent.state.systemPrompt,
    settings: ctx.config.agent.compaction,
    ...(ctx.config.agent.providerConfig.apiKey
      ? { apiKey: ctx.config.agent.providerConfig.apiKey }
      : {}),
    ...(ctx.requestLogger ? { logger: ctx.requestLogger } : {}),
  };

  const refreshLiveCapture = () => {
    updateLiveThreadCaptureForSideQuestion(ctx.conversation.threadId, {
      threadId: ctx.conversation.threadId,
      laneId: ctx.conversation.laneId,
      capturedAt: Date.now(),
      messages: agent.state.messages.map((message) => structuredClone(message)),
    });
  };

  refreshLiveCapture();

  return {
    ...ctx,
    agent,
    tools,
    compactionRuntime,
    refreshLiveCapture,
  };
};
