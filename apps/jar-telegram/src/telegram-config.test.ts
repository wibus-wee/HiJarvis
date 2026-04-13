import assert from "node:assert/strict";
import test from "node:test";

import { parseTelegramPlatformConfig } from "./telegram-config.js";

test("parseTelegramPlatformConfig maps toml fields into runtime config", () => {
  const config = parseTelegramPlatformConfig({
    telegram: {
      identities: {
        main: {
          entity: "jarvis",
          bot_token: "123456:test-token",
          allowed_chat_ids: [12345, "-1009876543210"],
          allowed_usernames: ["Wibus", "@JarvisUser"],
        },
      },
    },
  });

  assert.deepEqual(config.main, {
    id: "main",
    entityId: "jarvis",
    botToken: "123456:test-token",
    allowedChatIds: ["12345", "-1009876543210"],
    allowedUsernames: ["wibus", "jarvisuser"],
  });
});

test("parseTelegramPlatformConfig tolerates missing optional fields", () => {
  const config = parseTelegramPlatformConfig({
    telegram: {
      identities: {
        main: {
          entity: "jarvis",
        },
      },
    },
  });

  assert.deepEqual(config.main, {
    id: "main",
    entityId: "jarvis",
    botToken: undefined,
    allowedChatIds: undefined,
    allowedUsernames: undefined,
  });
});
