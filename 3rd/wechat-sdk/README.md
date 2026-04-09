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

## Environment Variables

- `WECHAT_SDK_ROUTE_TAG` / `WECHAT_ROUTE_TAG`: send `SKRouteTag` header
- `WECHAT_SDK_LOG_DIR` / `WECHAT_LOG_DIR`: log directory
- `WECHAT_SDK_STATE_DIR` / `WECHAT_STATE_DIR`: state directory

## Notes

- `sendMessageWeixin` currently uses `text` only.
- Plugin-only files remain in this folder but are excluded from SDK builds.
