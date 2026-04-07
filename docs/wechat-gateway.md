# WeChat Gateway

本页说明 `apps/jar-wechat` 的运行方式、session 映射方式，以及它和现有 Jar runtime 的边界。

## Overview

`apps/jar-wechat` 是一个单独的 Node.js daemon，基于 `@pinixai/weixin-bot` 接入 WeChat iLink Bot API。

入口与核心模块：

- `apps/jar-wechat/src/main.ts`
- `apps/jar-wechat/src/wechat-runtime.ts`
- `apps/jar-wechat/src/wechat-config.ts`
- `apps/jar-wechat/src/wechat-prompt.ts`

它复用了现有的 `packages/jar-core`，所以：

- provider/model 解析仍然走同一套 `jar.toml`
- tool 能力、timeout/retry、session 持久化与 CLI/Slack/Telegram 一致
- adapter 只负责平台事件接入、prompt 组装和 reply 回传

## Run

开发态：

```bash
pnpm dev:wechat
```

或直接运行 app：

```bash
pnpm --filter @hijarvis/jar-wechat dev -- --config ./jar.toml --port 3102
```

首次启动如果本地没有登录态，SDK 会触发二维码登录流程；成功后会把 credentials 写到 `platform.wechat.token_path`，或 SDK 默认路径。

## Config

WeChat gateway 优先从 `jar.toml` 的 `[platform.wechat]` 读取配置。

```toml
[platform.wechat]
base_url = "https://api-bot.hzxww.net"
token_path = ".jar/wechat/credentials.json"
coalesce_window_ms = 2500
host = "0.0.0.0"
port = 3002
```

字段说明：

- `base_url`: 可选 iLink API base URL 覆盖项。
- `token_path`: 可选 credentials 文件路径。
- `coalesce_window_ms`: 聚合同一用户连续消息的窗口。默认 `2500` ms。
- `host`: health check 服务监听地址。默认 `0.0.0.0`。
- `port`: health check 服务监听端口。默认 `3002`。

环境变量覆盖：

- `JARVIS_WECHAT_BASE_URL`
- `JARVIS_WECHAT_TOKEN_PATH`
- `JARVIS_WECHAT_HOST`
- `JARVIS_WECHAT_PORT`

## Message Flow

WeChat adapter 的主路径如下：

1. 启动时加载 `jar.toml`，初始化 `WeixinBot`，然后执行 `bot.login()`。
2. `bot.onMessage()` 收到入站消息后，会解析 message items，保留文本内容和图片 URL。
3. 同一 `userId` 的消息进入同一个内存队列，并等待一个短暂的 coalesce window，把“先发图，再补一句文字”合并成同一个 Jar turn。
4. 如果当前模型支持 image input，adapter 会下载聚合窗口里的图片，并把它们作为真正的 image block 附加到当前 user message；文字部分会保留图片引用顺序。
5. 如果窗口结束后只有图片没有文字，adapter 不会立刻触发 LLM，而是回一条 follow-up 提示，让用户补一句“你想让我看什么”。
6. `executePromptInSession()` 使用 `wechat:{userId}` 生成稳定 session id，并复用 `packages/jar-core` 的 session 存储。
7. 生成回复后，通过 `bot.reply()` 回发到原消息上下文。

## Session Mapping

每个 WeChat 用户对应一个 Jar session：

```text
wechat:{userId}
```

落盘时会被转换成文件系统安全形式：

```text
wechat__{userId}
```

这意味着：

- 同一用户的多轮对话会持续复用同一个 Jar session
- 当前实现不区分子线程或群聊上下文
- 会话历史仍以 `.jar/sessions/<sessionId>` 目录结构持久化
- session 里只保留文本轨迹和图片引用，不保留原始 base64 图片内容

## Health Check

adapter 会额外起一个简单 HTTP server：

- `GET /healthz` -> `200 {"ok":true}`

这和 Telegram 的健康检查模式一致，主要用于本地守护或容器探活。

## Logging

`apps/jar-wechat` 会通过 `packages/jar-core/src/logger.ts` 输出摘要日志，主要包括：

- `wechat.gateway_initialized`
- `wechat.event_received`
- `wechat.queue_enqueued`
- `wechat.queue_draining`
- `wechat.request_started`
- `wechat.reply_posted`
- `wechat.reply_failed`

这些日志只记录阶段边界，不镜像所有 token delta。

## Current Boundaries

- 当前只处理 `bot.onMessage()` 暴露的 direct message 模型
- 回复回传是整段文本，不做 token streaming
- typing indicator 会在 LLM 执行前后尝试开启/关闭，但不影响主流程成功与否
- 图片下载目前只抓取 URL 可访问的 image item，单轮最多附带 4 张图
- SDK 登录态与轮询细节由 `@pinixai/weixin-bot` 内部管理

如果以后要支持群聊、消息引用上下文或更细粒度的消息类型，应同步更新本页和 `apps/jar-wechat/src/wechat-runtime.ts`。
