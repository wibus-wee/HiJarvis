import { createAgent } from "../runtime.js";
import {
  updateLiveThreadCaptureForSideQuestion,
} from "../side-question/live-thread-registry.js";
import { getSkillsCatalogOverlays } from "../skills.js";
import { resolveMessageTools } from "./resolve-tools.js";
import type { AgentContext, PreparedPromptContext } from "./types.js";

export const createAgentContext = async (ctx: PreparedPromptContext): Promise<AgentContext> => {
  let tools = await resolveMessageTools(ctx.config, ctx.command, {
    tools: ctx.pluginTools,
    memoryProvider: ctx.pluginMemoryProvider,
  });

  // ── Hook: tools:resolve ──────────────────────────────────────
  if (ctx.hooks?.has("tools:resolve")) {
    const transformed = await ctx.hooks.transform("tools:resolve", {
      config: ctx.config,
      command: ctx.command,
      tools,
    });
    tools = transformed.tools;
  }

  // ── Hook: tool:before / tool:after ─────────────────────────
  // Bridge our hook system into the upstream Agent's native callbacks.
  const beforeToolCall = ctx.hooks?.has("tool:before")
    ? async (context: Parameters<NonNullable<Parameters<typeof createAgent>[0]["beforeToolCall"]>>[0], signal?: AbortSignal) => {
        return ctx.hooks!.transform("tool:before", context);
      }
    : undefined;

  const afterToolCall = ctx.hooks?.has("tool:after")
    ? async (context: Parameters<NonNullable<Parameters<typeof createAgent>[0]["afterToolCall"]>>[0], signal?: AbortSignal) => {
        return ctx.hooks!.transform("tool:after", context);
      }
    : undefined;

  const systemPromptOverlays = [
    ...getSkillsCatalogOverlays(ctx.skills),
    ...(ctx.config.agent.systemPromptOverlays ?? []),
    ...(ctx.pluginOverlays ?? []),
  ];

  const agent = createAgent({
    ...ctx.config.agent,
    systemPromptOverlays,
    tools,
    logger: ctx.requestLogger,
    beforeToolCall,
    afterToolCall,
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
    apiKey: ctx.config.agent.providerConfig.apiKey,
    logger: ctx.requestLogger,
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
