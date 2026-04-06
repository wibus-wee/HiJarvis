# Slack Gateway

本页说明 `apps/jar-slack` 这个第一版 Slack 平台接入的运行方式、上下文组装规则，以及它和现有 Jar session/runtime 的边界。

## 目标

第一版 Slack 接入只解决一件事：

- 在 Slack channel 中 `@mention` Jarvis，或直接给 Jarvis 发 DM 时，把请求导入 Jar runtime；
- 所有回复统一进入 Slack thread；
- 一个 Slack thread 对应一个 Jar session。

这意味着第一版明确**不做**：

- 频道内短答直回
- Discord / Telegram 之类的其他平台
- 持久化的 Chat SDK state backend
- 跨 thread / 跨 channel 的共享记忆

## 当前形态

`apps/jar-slack` 是一个单独的 Node.js HTTP 服务，而不是 CLI 参数扩展。

入口是：

- `apps/jar-slack/src/main.ts`
- `apps/jar-slack/src/slack-runtime.ts`

服务会：

1. 读取 `jar.toml`
2. 创建 Chat SDK `Chat` 实例
3. 注册 Slack adapter
4. 用 `@chat-adapter/state-memory` 保存 thread subscriptions 和 queue state
5. 监听 `POST /webhooks/slack`
6. 把 Slack message 映射到 Jar session

## 运行方式

开发时：

```bash
pnpm dev:slack
```

显式指定配置文件和端口：

```bash
pnpm --filter @hijarvis/jar-slack dev -- --config ./jar.toml --port 3100
```

健康检查：

```bash
curl http://127.0.0.1:3000/healthz
```

## 配置来源

Slack gateway 现在优先从 `jar.toml` 的 `[platform.slack]` 读取配置。

推荐形态：

```toml
[platform.slack]
bot_name = "jarvis"
bot_token = "xoxb-..."
signing_secret = "..."
context_lookback_minutes = 15
context_message_limit = 12
host = "0.0.0.0"
port = 3000
```

环境变量现在只作为 override。

Slack adapter 兼容的 override：

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
```

Jar Slack gateway 自己支持的 override：

```bash
JARVIS_SLACK_BOT_NAME=jarvis
JARVIS_SLACK_CONTEXT_LOOKBACK_MINUTES=15
JARVIS_SLACK_CONTEXT_MESSAGE_LIMIT=12
HOST=0.0.0.0
PORT=3000
```

说明：

- `JARVIS_SLACK_BOT_NAME`：覆盖 `platform.slack.bot_name`。
- `JARVIS_SLACK_CONTEXT_LOOKBACK_MINUTES`：首次 mention 时，回看 channel 顶层消息的时间窗。
- `JARVIS_SLACK_CONTEXT_MESSAGE_LIMIT`：首次 mention 时，最多带入多少条顶层消息。
- `HOST` / `PORT`：覆盖 webhook HTTP 服务监听地址。

## 交互规则

### 1. 新的 channel mention

当用户在一个**尚未订阅**的 Slack 线程上下文中 `@mention` Jarvis：

1. `onNewMention` 被触发
2. `thread.subscribe()` 被调用
3. Jarvis 从当前 channel 拉取 mention 之前的一小段顶层消息
4. 用这些消息构造 observed context prompt
5. 通过 `packages/jar-core/src/session-executor.ts` 执行一次 session-bound prompt
6. 把结果发回当前 Slack thread

这里的 observed context 是**临时上下文**，不是长期记忆真相。

### 2. 已订阅 thread 中的后续消息

当用户继续在同一个 Slack thread 里说话：

1. `onSubscribedMessage` 被触发
2. 不再重新拉取 channel 顶层历史
3. 直接把当前消息导入该 thread 对应的 Jar session
4. 在同一个 thread 中回复

这个阶段的长期记忆真相来自 Jar session，而不是 Slack channel 历史。

### 3. 直接消息

当用户直接给 Jarvis 发 DM：

1. `onDirectMessage` 被触发
2. 该 DM thread 会被订阅
3. 不回看 channel 顶层历史
4. 直接进入 Jar session，并在同一个 DM thread 里回复

## Session 映射

Slack thread id 由 Chat SDK 统一编码成：

```text
slack:{channelId}:{threadTs}
```

第一版会把它转换成 Jar session id：

```text
slack__{channelId}__{threadTs}
```

这样做的目的：

- 保持可读性
- 避免直接把 `/` 之类的平台分隔符带入本地文件路径
- 保证“一个 Slack thread = 一个 Jar session”

## 上下文组装

### 首次 mention

首次 mention 的 prompt 由三部分组成：

1. 平台说明
2. observed channel context
3. 当前用户请求

如果在上一轮处理期间，同一个 thread 又来了多条消息，Chat SDK `queue` 策略会把中间消息作为 `context.skipped` 传进来；这些消息也会被附加到 prompt 中。

### 后续 thread 消息

后续 thread 消息的 prompt 更简单：

1. 说明“你正在继续一个已有 thread 对话”
2. 附加 `context.skipped`
3. 附加当前用户消息

不再重复注入 channel 顶层历史。

## 为什么 state 先用 memory

第一版的 Chat SDK state 只承担：

- thread subscription
- queue / lock
- SDK 内部缓存

这层**不是** Jar 的长期记忆存储。

因此当前选择 `@chat-adapter/state-memory`，理由是：

- 本地开发最快
- 单进程验证足够
- 不会把 Redis/PG 提前引入成架构前提

当前限制：

- 进程重启后，Chat SDK 的 thread subscription 会丢失
- 但 Jar session 文件仍然保留在 `.jar/sessions`

如果后续需要多实例部署或重启后保留 subscriptions，再切到 Redis / PostgreSQL。

## 验证建议

最小验证路径：

1. 启动 `apps/jar-slack`
2. 配好 Slack Event Subscriptions 到 `/webhooks/slack`
3. 在一个 channel 中连续发几条顶层消息
4. `@mention` Jarvis，确认它在 thread 中回复，并能引用 mention 前的内容
5. 继续在该 thread 中追问，确认它沿用同一个 session
6. 重启服务后重新 mention，确认新的 thread 仍然可用

## 已知限制

- 只支持 Slack
- 所有回复统一进入 thread
- observed context 只看 channel 顶层消息，不看其他 thread
- state-memory 不会跨进程持久化 Chat SDK subscriptions
- 还没有做 streaming reply、cards、modals 或 slash commands
