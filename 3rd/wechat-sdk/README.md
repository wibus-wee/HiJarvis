# WeChat SDK

[简体中文](./README.zh_CN.md)

WeChat iLink API SDK extracted from the OpenClaw Weixin channel. It focuses on:

- QR login helpers
- getUpdates long-poll API
- sendMessage and CDN upload helpers
- inbound message parsing helpers
- generic reply payload types

## Usage

```ts
import {
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  sendMessageWeixin,
} from "./index.js";

const start = await startWeixinLoginWithQr({
  apiBaseUrl: "https://ilinkai.weixin.qq.com",
});

const result = await waitForWeixinLogin({
  sessionKey: start.sessionKey,
  apiBaseUrl: "https://ilinkai.weixin.qq.com",
});

if (result.connected && result.botToken) {
  await sendMessageWeixin({
    to: "user@im.wechat",
    text: "hello",
    opts: {
      baseUrl: result.baseUrl || "https://ilinkai.weixin.qq.com",
      token: result.botToken,
    },
  });
}
```

## Configuration

- `routeTag` is passed via API options
- log directory via `setLogDir()`
- state directory via `setStateDir()`

## Notes

- `sendMessageWeixin` currently uses `text` only.

## Integration Responsibilities

This SDK does not provide framework glue. Integrators must implement:

- Account storage (accountId, token, baseUrl, userId)
- Long-poll monitor loop (`getUpdates` + cursor persistence)
- Context token persistence (`setContextToken` / `getContextToken`)
- Media download/decrypt pipeline (if needed)
- Authorization or pairing logic (own allowlist or policy)
