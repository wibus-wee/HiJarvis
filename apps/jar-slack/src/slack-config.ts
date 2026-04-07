import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

const slackPlatformSchema = z.object({
  bot_name: nonEmptyString.optional(),
  bot_token: nonEmptyString.optional(),
  app_token: nonEmptyString.optional(),
  signing_secret: nonEmptyString.optional(),
  context_lookback_minutes: z.number().int().positive().optional(),
  context_message_limit: z.number().int().positive().optional(),
  host: nonEmptyString.optional(),
  port: z.number().int().positive().optional(),
}).strict();

const defaultContextLookbackMinutes = 15;
const defaultContextMessageLimit = 12;

export type SlackPlatformConfig = {
  botName?: string;
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  contextLookbackMinutes: number;
  contextMessageLimit: number;
  host?: string;
  port?: number;
};

export const parseSlackPlatformConfig = (
  platform: Record<string, unknown>,
): SlackPlatformConfig => {
  const parsed = slackPlatformSchema.parse(platform.slack ?? {});

  return {
    ...(parsed.bot_name === undefined ? {} : { botName: parsed.bot_name }),
    ...(parsed.bot_token === undefined ? {} : { botToken: parsed.bot_token }),
    ...(parsed.app_token === undefined ? {} : { appToken: parsed.app_token }),
    ...(parsed.signing_secret === undefined
      ? {}
      : { signingSecret: parsed.signing_secret }),
    contextLookbackMinutes:
      parsed.context_lookback_minutes ?? defaultContextLookbackMinutes,
    contextMessageLimit:
      parsed.context_message_limit ?? defaultContextMessageLimit,
    ...(parsed.host === undefined ? {} : { host: parsed.host }),
    ...(parsed.port === undefined ? {} : { port: parsed.port }),
  };
};
