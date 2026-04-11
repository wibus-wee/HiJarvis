import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

const telegramIdentitySchema = z.object({
  entity: nonEmptyString,
  bot_token: nonEmptyString.optional(),
  allowed_chat_ids: z.array(z.union([z.number().int(), nonEmptyString])).optional(),
  allowed_usernames: z.array(nonEmptyString).optional(),
}).strict();

const telegramPlatformSchema = z.object({
  identities: z.record(nonEmptyString, telegramIdentitySchema),
}).strict();

export type TelegramPlatformIdentityConfig = {
  id: string;
  entityId: string;
  botToken?: string;
  allowedChatIds?: string[];
  allowedUsernames?: string[];
};

export const parseTelegramPlatformConfig = (
  platform: Record<string, unknown>,
): Record<string, TelegramPlatformIdentityConfig> => {
  const parsed = telegramPlatformSchema.parse(platform.telegram ?? {});

  return Object.fromEntries(Object.entries(parsed.identities).map(([id, identity]) => [id, {
    id,
    entityId: identity.entity,
    ...(identity.bot_token === undefined ? {} : { botToken: identity.bot_token }),
    ...(identity.allowed_chat_ids === undefined
      ? {}
      : {
        allowedChatIds: identity.allowed_chat_ids.map((value) => String(value)),
      }),
    ...(identity.allowed_usernames === undefined
      ? {}
      : {
        allowedUsernames: identity.allowed_usernames.map((value) =>
          value.replace(/^@/, "").toLowerCase()
        ),
      }),
  } satisfies TelegramPlatformIdentityConfig]));
};
