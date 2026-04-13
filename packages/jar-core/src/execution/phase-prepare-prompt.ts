import { buildDefaultSkillTriggerText, buildTurnInputMetadata } from "../ingress.js";
import { preparePromptWithSkills } from "../skills.js";
import { startThreadExecutionTracker } from "../thread-execution.js";
import type { PromptInput } from "../prompt-executor.js";
import type { PreparedPromptContext, SessionContext } from "./types.js";

export const preparePrompt = async (
  ctx: SessionContext,
  promptOverride?: PromptInput,
  skillTriggerTextOverride?: string,
): Promise<PreparedPromptContext> => {
  const skillTriggerText = skillTriggerTextOverride
    ?? ctx.command.skillTriggerText
    ?? buildDefaultSkillTriggerText(ctx.command);

  const prepared = await preparePromptWithSkills(promptOverride ?? ctx.command.prompt, {
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
