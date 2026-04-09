# WeChat SDK

`3rd/wechat-sdk` 提供与微信 iLink 机器人 API 交互的基础 SDK。该目录由 openclaw-weixin 的核心 API 代码抽离而来，移除了 OpenClaw 插件入口与运行时依赖，便于其他 bot 直接复用。

**目录位置**
- `3rd/wechat-sdk`

**主要导出**
- API：`getUpdates`、`sendMessage`、`getUploadUrl`、`getConfig`、`sendTyping`
- 登录：`startWeixinLoginWithQr`、`waitForWeixinLogin`
- CDN/媒体：`uploadFileToWeixin`、`uploadVideoToWeixin`、`uploadFileAttachmentToWeixin`、`downloadRemoteImageToTemp`
- 消息发送：`sendMessageWeixin`、`sendWeixinMediaFile`、`StreamingMarkdownFilter`
- 入站解析：`weixinMessageToMsgContext`、`setContextToken`、`getContextToken`

**配置方式**
- `routeTag` 通过 API 参数传入（例如 `getUpdates({ ... , routeTag })`）
- 日志目录通过 `setLogDir()` 设置
- 状态目录通过 `setStateDir()` 设置

**与原插件差异（行为变化）**
- 不再读取 `openclaw.json` 的 `routeTag`，仅支持通过 SDK 参数 `routeTag` 或环境变量注入。
- 日志默认写入 `os.tmpdir()/wechat-sdk/wechat-sdk-YYYY-MM-DD.log`，不再复用 OpenClaw 日志文件。
- 状态目录默认从 `~/.openclaw` 改为 `~/.wechat-sdk`（可用环境变量覆盖）。
- `channel_version` 由 SDK 的 `package.json` 版本号决定；SDK 版本变更会影响该字段。

**类型差异**
- SDK 不再依赖 OpenClaw 的 `ReplyPayload` 类型；内部仅使用 `{ text?: string }` 作为消息载荷。

**使用示例**
```ts
import {
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  sendMessageWeixin,
} from "../3rd/wechat-sdk/index.js";

const start = await startWeixinLoginWithQr({ apiBaseUrl: "https://ilinkai.weixin.qq.com" });
console.log(start.qrcodeUrl);

const result = await waitForWeixinLogin({
  sessionKey: start.sessionKey,
  apiBaseUrl: "https://ilinkai.weixin.qq.com",
});

if (result.connected && result.botToken) {
  await sendMessageWeixin({
    to: "user@im.wechat",
    text: "hello",
    opts: { baseUrl: result.baseUrl || "https://ilinkai.weixin.qq.com", token: result.botToken },
  });
}
```

**接入方需要负责的事项**
- 账户存储（accountId、token、baseUrl、userId）
- 长轮询监控（`getUpdates` + 游标持久化）
- context token 持久化（`setContextToken` / `getContextToken`）
- 媒体下载/解密管线（如需要）
- 授权或 pairing 逻辑（自定义 allowlist 或权限策略）
