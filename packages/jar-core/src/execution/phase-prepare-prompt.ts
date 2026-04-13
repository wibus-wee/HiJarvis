import { buildDefaultSkillTriggerText, buildTurnInputMetadata } from "../ingress.js";
import { preparePromptWithSkills } from "../skills.js";
import { startThreadExecutionTracker } from "../thread-execution.js";
import type { PreparedPromptContext, SessionContext } from "./types.js";

export const preparePrompt = async (ctx: SessionContext): Promise<PreparedPromptContext> => {
  const skillTriggerText = ctx.command.skillTriggerText ?? buildDefaultSkillTriggerText(ctx.command);

  const prepared = await preparePromptWithSkills(ctx.command.prompt, {
    skills: ctx.config.skills,
    triggerText: skillTriggerText,
    logger: ctx.requestLogger,
  });

  const tracker = await startThreadExecutionTracker({
    threadId: ctx.conversation.threadId,
    auditStore: ctx.auditStore,
    prompt: prepared.prompt,
    trigger: ctx.command.audit.trigger,
    logger: ctx.requestLogger,
    turnInputMetadata: buildTurnInputMetadata(ctx.command),
  });

  for (const warning of prepared.warnings) {
    await tracker.recordNote({
      kind: "skills_warning",
      message: warning,
    });
  }

  return {
    ...ctx,
    prepared,
    tracker,
  };
};
