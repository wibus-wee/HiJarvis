import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

const slackIdentitySchema = z.object({
  entity: nonEmptyString,
  bot_token: nonEmptyString.optional(),
  app_token: nonEmptyString.optional(),
  signing_secret: nonEmptyString.optional(),
  context_lookback_minutes: z.number().int().positive().optional(),
  context_message_limit: z.number().int().positive().optional(),
}).strict();

const slackPlatformSchema = z.object({
  identities: z.record(nonEmptyString, slackIdentitySchema),
}).strict();

const defaultContextLookbackMinutes = 15;
const defaultContextMessageLimit = 12;

export type SlackPlatformIdentityConfig = {
  id: string;
  entityId: string;
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  contextLookbackMinutes: number;
  contextMessageLimit: number;
};

export const parseSlackPlatformConfig = (
  platform: Record<string, unknown>,
): Record<string, SlackPlatformIdentityConfig> => {
  const parsed = slackPlatformSchema.parse(platform.slack ?? {});

  return Object.fromEntries(Object.entries(parsed.identities).map(([id, identity]) => [id, {
    id,
    entityId: identity.entity,
    botToken: identity.bot_token,
    appToken: identity.app_token,
    signingSecret: identity.signing_secret,
    contextLookbackMinutes:
      identity.context_lookback_minutes ?? defaultContextLookbackMinutes,
    contextMessageLimit:
      identity.context_message_limit ?? defaultContextMessageLimit,
  } satisfies SlackPlatformIdentityConfig]));
};
