import { registerLiveThreadForSideQuestion } from "../side-question/live-thread-registry.js";
import type { SessionContext, StoresContext } from "./types.js";

export const loadSession = async (ctx: StoresContext): Promise<SessionContext> => {
  const conversation = await ctx.stateStore.load(ctx.command.routing, ctx.config);

  registerLiveThreadForSideQuestion({
    threadId: conversation.threadId,
    laneId: conversation.laneId,
  });

  const requestLogger = ctx.logger?.child({
    threadId: conversation.threadId,
    provider: ctx.config.agent.provider,
    model: ctx.config.agent.model,
  });

  return {
    ...ctx,
    conversation,
    requestLogger,
  };
};
