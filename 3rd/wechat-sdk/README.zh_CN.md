# WeChat SDK

[English](./README.md)

从 OpenClaw Weixin 渠道中抽离的 WeChat iLink API SDK，覆盖：

- 二维码登录
- getUpdates 长轮询
- sendMessage 与 CDN 上传
- 入站消息解析
- 通用 ReplyPayload 类型

## 使用示例

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

## 配置方式

- `routeTag` 通过 API 参数传入
- 日志目录通过 `setLogDir()` 设置
- 状态目录通过 `setStateDir()` 设置

## 备注

- `sendMessageWeixin` 目前仅消费 `text` 字段。

## 接入方需要负责的事项

SDK 不包含任何框架 glue，接入方需自行实现：

- 账户存储（accountId、token、baseUrl、userId）
- 长轮询监控（`getUpdates` + 游标持久化）
- context token 持久化（`setContextToken` / `getContextToken`）
- 媒体下载/解密管线（如需要）
- 授权或 pairing 逻辑（自定义 allowlist 或权限策略）
