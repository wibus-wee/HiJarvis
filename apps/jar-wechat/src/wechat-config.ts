import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

const wechatPlatformSchema = z.object({
  base_url: nonEmptyString.optional(),
  token_path: nonEmptyString.optional(),
  host: nonEmptyString.optional(),
  port: z.number().int().positive().optional(),
}).strict();

export type WeChatPlatformConfig = {
  baseUrl?: string;
  tokenPath?: string;
  host?: string;
  port?: number;
};

export const parseWeChatPlatformConfig = (
  platform: Record<string, unknown>,
): WeChatPlatformConfig => {
  const parsed = wechatPlatformSchema.parse(platform.wechat ?? {});

  return {
    ...(parsed.base_url === undefined ? {} : { baseUrl: parsed.base_url }),
    ...(parsed.token_path === undefined ? {} : { tokenPath: parsed.token_path }),
    ...(parsed.host === undefined ? {} : { host: parsed.host }),
    ...(parsed.port === undefined ? {} : { port: parsed.port }),
  };
};
