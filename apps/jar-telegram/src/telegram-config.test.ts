import assert from "node:assert/strict";
import test from "node:test";

import { parseTelegramPlatformConfig } from "./telegram-config.js";

test("parseTelegramPlatformConfig maps toml fields into runtime config", () => {
  const config = parseTelegramPlatformConfig({
    telegram: {
      bot_token: "123456:test-token",
      allowed_chat_ids: [12345, "-1009876543210"],
      allowed_usernames: ["Wibus", "@JarvisUser"],
      host: "127.0.0.1",
      port: 4319,
    },
  });

  assert.deepEqual(config, {
    botToken: "123456:test-token",
    allowedChatIds: ["12345", "-1009876543210"],
    allowedUsernames: ["wibus", "jarvisuser"],
    host: "127.0.0.1",
    port: 4319,
  });
});

test("parseTelegramPlatformConfig tolerates missing optional fields", () => {
  const config = parseTelegramPlatformConfig({ telegram: {} });

  assert.deepEqual(config, {});
});
