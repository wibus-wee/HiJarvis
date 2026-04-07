import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

const telegramPlatformSchema = z.object({
  bot_token: nonEmptyString.optional(),
  allowed_chat_ids: z.array(z.union([z.number().int(), nonEmptyString])).optional(),
  allowed_usernames: z.array(nonEmptyString).optional(),
  host: nonEmptyString.optional(),
  port: z.number().int().positive().optional(),
}).strict();

export type TelegramPlatformConfig = {
  botToken?: string;
  allowedChatIds?: string[];
  allowedUsernames?: string[];
  host?: string;
  port?: number;
};

export const parseTelegramPlatformConfig = (
  platform: Record<string, unknown>,
): TelegramPlatformConfig => {
  const parsed = telegramPlatformSchema.parse(platform.telegram ?? {});

  return {
    ...(parsed.bot_token === undefined ? {} : { botToken: parsed.bot_token }),
    ...(parsed.allowed_chat_ids === undefined
      ? {}
      : {
        allowedChatIds: parsed.allowed_chat_ids.map((value) => String(value)),
      }),
    ...(parsed.allowed_usernames === undefined
      ? {}
      : {
        allowedUsernames: parsed.allowed_usernames.map((value) =>
          value.replace(/^@/, "").toLowerCase()
        ),
      }),
    ...(parsed.host === undefined ? {} : { host: parsed.host }),
    ...(parsed.port === undefined ? {} : { port: parsed.port }),
  };
};
