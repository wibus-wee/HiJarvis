import assert from "node:assert/strict";
import test from "node:test";

import { parseWeChatPlatformConfig } from "./wechat-config.js";

test("parseWeChatPlatformConfig maps toml fields into runtime config", () => {
  const config = parseWeChatPlatformConfig({
    wechat: {
      base_url: "http://127.0.0.1:8080",
      token_path: ".jar/wechat-credentials.json",
      coalesce_window_ms: 2800,
      host: "127.0.0.1",
      port: 3102,
    },
  });

  assert.deepEqual(config, {
    baseUrl: "http://127.0.0.1:8080",
    tokenPath: ".jar/wechat-credentials.json",
    coalesceWindowMs: 2800,
    host: "127.0.0.1",
    port: 3102,
  });
});

test("parseWeChatPlatformConfig tolerates missing optional fields", () => {
  const config = parseWeChatPlatformConfig({ wechat: {} });

  assert.deepEqual(config, {});
});
