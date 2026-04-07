import assert from "node:assert/strict";
import test from "node:test";

import { parseSlackPlatformConfig } from "./slack-config.js";

test("parseSlackPlatformConfig maps toml fields into runtime config", () => {
  const config = parseSlackPlatformConfig({
    slack: {
      bot_name: "jarvis",
      bot_token: "xoxb-test",
      app_token: "xapp-test",
      signing_secret: "secret-test",
      context_lookback_minutes: 20,
      context_message_limit: 18,
      host: "127.0.0.1",
      port: 4318,
    },
  });

  assert.deepEqual(config, {
    botName: "jarvis",
    botToken: "xoxb-test",
    appToken: "xapp-test",
    signingSecret: "secret-test",
    contextLookbackMinutes: 20,
    contextMessageLimit: 18,
    host: "127.0.0.1",
    port: 4318,
  });
});

test("parseSlackPlatformConfig applies default context limits when omitted", () => {
  const config = parseSlackPlatformConfig({ slack: {} });

  assert.equal(config.contextLookbackMinutes, 15);
  assert.equal(config.contextMessageLimit, 12);
});
