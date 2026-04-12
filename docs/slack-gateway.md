# Slack Gateway

本页说明 `apps/jar-slack` 这个第一版 Slack 平台接入的运行方式、上下文组装规则，以及它和现有 Jar thread/lane runtime 的边界。

## 目标

第一版 Slack 接入只解决一件事：

- 在 Slack channel 中 `@mention` Jarvis 时，把请求导入 Jar runtime；
- 所有回复统一进入 Slack thread；
- 顶层 channel mention 和 thread follow-up 各自映射到某个 Jarvis entity 在 Slack 上的局部 thread。

这意味着第一版明确**不做**：

- 频道内短答直回
- Slack DM 支持
- Discord / Telegram 之类的其他平台
- 持久化的 Slack gateway state backend
- 跨 thread / 跨 channel 的共享记忆

## 当前形态

`apps/jar-slack` 是一个单独的 Node.js daemon，但它现在是一个 Slack identity supervisor，而不是单 bot daemon。它会为 `platform.slack.identities.*` 下的每个配置启动一个独立的 Slack Socket Mode runtime。

入口是：

- `apps/jar-slack/src/main.ts`
- `apps/jar-slack/src/slack-runtime.ts`

服务会：

1. 读取 `jar.toml`
2. 读取 `platform.slack.identities.*`
3. 为每个 Slack identity 启动一条独立的 Socket Mode 连接
4. 先把 Slack transport event 归一化成 canonical message
5. 在每个 identity 自己的内存态里维护线程订阅、scope reply timestamp、event dedupe、message dedupe 与队列状态
6. 先把 Slack scope 路由到当前 Slack identity，再映射到该 identity 绑定 entity 的局部本地 thread
7. 在回复发回 Slack 前，把模型原始 Markdown 组织成 Slack `markdown` blocks
8. 输出一层面向开发排障的摘要日志

## 运行方式

开发时：

```bash
pnpm dev:slack
```

显式指定配置文件：

```bash
pnpm --filter @hijarvis/jar-slack dev -- --config ./jar.toml
```

如果你已经在 `jar.toml` 里配置了 `[logging].file_path`，开发时建议直接 `tail -f` 这个文件，而不是只盯着 Slack thread 本身。当前默认是 `stderr` 走 `pino-pretty`，文件走 `pino` JSONL。

## 配置来源

Slack gateway 现在优先从 `jar.toml` 的 `platform.slack.identities.*` 读取配置。

Socket Mode 需要在 Slack App 设置里开启，并生成 `xapp-...` app-level token。这个 token 必须带 `connections:write` 权限，用来调用 `apps.connections.open` 建立 WebSocket 连接。启用后不需要配置 `request_url`，但仍需勾选所需的 Event Subscriptions。

仓库里提供了一份可导入的 manifest：

- `apps/jar-slack/slack-app-manifest.yaml`

注意：

- manifest 不会替你创建 `xapp-...` app-level token。
- `connections:write` 不属于 bot scopes，不能放在 `oauth_config.scopes.bot` 里。
- 仍需在 Slack 后台的 `Basic Information > App-Level Tokens` 里单独生成带 `connections:write` 的 token，并填到 `platform.slack.identities.<identity>.app_token` 或 `SLACK_APP_TOKEN`。

推荐形态：

```toml
[entities.jarvis]
display_name = "Jarvis"

[entities.pm]
display_name = "PM Jarvis"

[platform.slack.identities.slack_main]
entity = "jarvis"
bot_token = "xoxb-..."
app_token = "xapp-..."
signing_secret = "..."
context_lookback_minutes = 15
context_message_limit = 12

[platform.slack.identities.slack_pm]
entity = "pm"
bot_token = "xoxb-..."
app_token = "xapp-..."
signing_secret = "..."
context_lookback_minutes = 15
context_message_limit = 12

[logging]
level = "info"
stderr = true
file_path = ".jar/logs/runtime.log"
```

环境变量现在只作为 override。

Slack Socket Mode 需要的 override：

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
```

Jar Slack gateway 自己支持的 override：

```bash
JARVIS_SLACK_CONTEXT_LOOKBACK_MINUTES=15
JARVIS_SLACK_CONTEXT_MESSAGE_LIMIT=12
```

说明：

- `JARVIS_SLACK_CONTEXT_LOOKBACK_MINUTES`：当 channel scope 里还没有 Jarvis 上一轮回复时，bootstrap fallback 的回看时间窗。
- `JARVIS_SLACK_CONTEXT_MESSAGE_LIMIT`：每轮 channel-scope prompt 最多带入多少条顶层消息。
- `SLACK_APP_TOKEN` 对应的是 app-level token，不是 bot token；创建时需要勾选 `connections:write`。

这些环境变量是全进程级 override，不适合长期用于多 identity 生产配置。真正的多 bot 配置应直接写进 `jar.toml`，否则多个 Slack identity 会被同一套环境变量覆盖。

## 运行日志

Slack gateway 现在会输出一层摘要型运行日志，用于回答“这条请求现在跑到哪一步了”。

推荐把这层日志理解成开发排障视图，而不是最终审计真相：

- 审计真相：`.jar/threads/<threadId>/lanes/main/events.jsonl`
- 开发视图：`[logging].file_path` 对应的 runtime log

默认 `info` 级会覆盖这些关键阶段：

- `slack.event_received`
- `slack.queue_enqueued`
- `slack.queue_draining`
- `slack.context_collected`
- `session.prompt_started`
- `session.tool_started`
- `session.tool_finished`
- `session.prompt_finished`
- `slack.reply_posted`

`debug` 会额外输出一些低层事件，例如被忽略或被去重的 Slack event。它适合排查边缘问题，但不建议长期常开。

## 交互规则

Slack gateway 现在明确把输入处理拆成三层：

1. transport event
2. canonical message
3. conversation trigger

原因是：Slack 可能会针对同一条用户消息同时发出 `app_mention` 和 `message.*`。如果直接把 transport event 当成用户请求，就会把同一条消息执行两次。

当前 intake 规则：

- `event_id` dedupe：只负责挡住 Slack 对同一个事件的重投
- `channel + ts` message dedupe：保证同一条 Slack 消息只进入业务处理一次
- trigger classifier：统一判断这条 canonical message 是 `new_mention`、`subscribed` 还是 `ignore`

### 1. 顶层 channel mention

当用户在频道顶层 `@mention` Jarvis：

1. 收到 `app_mention` 事件
2. 把当前频道顶层主线视为一个独立 scope
3. 如果 Jarvis 之前已经在这个 channel scope 里回复过，就只拉取“上次 Jarvis 回复之后，到这次 mention 之前”的顶层 channel 消息
4. 如果这是这个 channel scope 的第一次回复，才退回一个很小的 bootstrap window
5. 用这些顶层消息构造 prompt
6. 通过 `packages/jar-core/src/thread-executor.ts` 执行一次 thread-bound prompt
7. 把结果发回当前 Slack thread，并订阅这个 thread 的后续消息

补充说明：

- 顶层 channel scope 的本地 thread id 按 `channel:{channelId}` 生成。
- 如果同一条消息同时以 `app_mention` 和 `message.channels` 到达，最终也只会被接受一次。

### 2. 已订阅 thread 中的后续消息

当用户继续在同一个 Slack thread 里说话：

1. 收到 thread 内的后续消息
2. 不再重新拉取 channel 顶层历史
3. 只把“Jarvis 上次在该 thread 回复之后新增的 thread 消息”送进这一轮 prompt
4. 直接把这些消息写入该 thread 对应的本地 thread/lane
5. 在同一个 thread 中回复

补充规则：

- 已订阅 thread 里的消息统一按 follow-up 处理。
- 即使这条 follow-up 再次 `@mention` Jarvis，也不会额外触发第二条并行处理路径。
- 如果 Jarvis 是第一次在一个已经存在的 thread 中被 `@mention`，当前实现不会回补更早的 thread replies；这一轮只能从当前 mention 开始建立 thread 上下文。

### 3. 直接消息

当前实现直接忽略 Slack DM。只有 channel 顶层 mention 和已订阅 thread 内的后续消息会进入 Jar runtime。

## Entity 与 Session 映射

Slack gateway 现在不再把 Slack scope 直接当成“Jarvis 自己”。

真实形态是：

- `platform identity`：真实 Slack bot/app 身份，例如 `slack_main`
- `entity`：该 Slack bot 绑定的 Jarvis 身份，例如 `jarvis` 或 `pm`
- `scope`：Slack channel/thread 上的一个局部表面坐标
- `thread`：该 identity 在该 scope 上的本地持续 thread

普通消息不再路由到默认 entity。它们总是路由到当前 Slack runtime identity 绑定的 entity。

## Thread 映射

顶层 channel scope 统一编码成：

```text
slack:channel:{channelId}
```

thread scope 统一编码成：

```text
slack:thread:{channelId}:{threadTs}
```

最终会转换成带 identity 前缀的本地 thread id，例如：

```text
identity__slack_main__slack__channel__{channelId}
identity__slack_main__slack__thread__{channelId}__{threadTs}
```

这样做的目的：

- 保持可读性
- 避免直接把 `/` 之类的平台分隔符带入本地文件路径
- 保证“同一个 Slack identity 上的一个 scope = 一个本地 thread”
- 保证不同 Slack bot 即使落在同一个 channel/thread 坐标，也不会共享 thread

## 上下文组装

Slack adapter 只负责组装每一轮的 turn prompt，不负责 system prompt。system prompt 的最终文本由 `packages/jar-core/src/prompt-builder.ts` 在 runtime 层统一构造；Slack 通过同一个模块里的 `buildTurnPrompt()` 组装平台上下文。

## 回复格式化

Slack gateway 现在优先使用 Slack 官方 `markdown` block，而不是把标准 Markdown 先转换成 `mrkdwn` 再塞进 `section`。

当前策略是：

- 顶层 `text` 继续保留原始 reply 的截断版本，作为 fallback
- `blocks` 使用原始 Markdown 内容
- 发送前按段落分块，避免把整段长回复塞进一个 block

之前“总是 collapse”的直接原因，是我们发的是 `section` block；`section` 在文本较长时，Slack 会显示 `see more`。切到 `markdown` block 后，格式转换交给 Slack 自己处理；但如果整条消息在 Slack 客户端里依然被折叠，那就是 Slack UI 的长消息展示策略，不再是我们这层 `mrkdwn` 适配造成的。

### 顶层 channel mention

顶层 mention 的 prompt 由三部分组成：

1. 平台说明
2. 与本轮相关的顶层 channel 消息
3. 当前用户请求

如果在上一轮处理期间，同一个 channel scope 又来了多条顶层 mention，gateway 会把中间消息作为 `skipped` 上下文附加到 prompt 中。

### 后续 thread 消息

后续 thread 消息的 prompt 更简单：

1. 说明“你正在继续一个已有 thread 对话”
2. 附加 processing 期间积累的 `skipped`
3. 附加当前用户消息

不再重复注入 channel 顶层历史。

## 为什么 state 先用内存

第一版的 gateway state 只承担：

- thread subscription
- scope 最近一次回复时间
- queue / lock
- 本地缓存

这层**不是** Jar 的长期记忆存储。

因此当前选择内存态，理由是：

- 本地开发最快
- 单进程验证足够
- 不会把 Redis/PG 提前引入成架构前提

当前限制：

- 进程重启后，thread subscription 会丢失
- 但本地 thread/lane 文件仍然保留在 `.jar/threads`

如果后续需要多实例部署或重启后保留 subscriptions / scope reply timestamp，再切到 Redis / PostgreSQL。

## 验证建议

最小验证路径：

1. 启动 `apps/jar-slack`
2. 在 Slack App 中启用 Socket Mode，并配置 `SLACK_APP_TOKEN`
3. 在一个 channel 中连续发几条顶层消息
4. `@mention` Jarvis，确认它在 thread 中回复，并能引用上一次 Jarvis channel 回复之后的顶层消息
5. 继续在该 thread 中追问，确认它沿用同一个本地 thread
6. 重启服务后重新 mention，确认新的 thread 仍然可用

## 已知限制

- 只支持 Slack
- 所有回复统一进入 thread
- 顶层 channel scope 只看频道顶层消息，不看其他 thread
- 第一次在一个既有 thread 中被 `@mention` 时，不会回补更早的 thread replies
- 内存态不会跨进程持久化 thread subscriptions 或最近回复时间
- 还没有做 streaming reply、cards、modals 或 slash commands
