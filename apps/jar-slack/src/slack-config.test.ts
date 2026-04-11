import assert from "node:assert/strict";
import test from "node:test";

import { parseSlackPlatformConfig } from "./slack-config.js";

test("parseSlackPlatformConfig maps toml fields into runtime config", () => {
  const config = parseSlackPlatformConfig({
    slack: {
      identities: {
        main: {
          entity: "jarvis",
          bot_token: "xoxb-test",
          app_token: "xapp-test",
          signing_secret: "secret-test",
          context_lookback_minutes: 20,
          context_message_limit: 18,
        },
      },
    },
  });

  assert.deepEqual(config.main, {
    id: "main",
    entityId: "jarvis",
    botToken: "xoxb-test",
    appToken: "xapp-test",
    signingSecret: "secret-test",
    contextLookbackMinutes: 20,
    contextMessageLimit: 18,
  });
});

test("parseSlackPlatformConfig applies default context limits when omitted", () => {
  const config = parseSlackPlatformConfig({
    slack: {
      identities: {
        main: {
          entity: "jarvis",
        },
      },
    },
  });

  assert.equal(config.main?.contextLookbackMinutes, 15);
  assert.equal(config.main?.contextMessageLimit, 12);
});
