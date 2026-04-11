# Telegram Gateway

本页说明 `apps/jar-telegram` 的运行方式、触发规则、session 映射方式，以及它和现有 Jar runtime 的边界。

## 目标

第一版 Telegram 接入聚焦在“个人助理 bot”这个场景：

- 私聊里，用户发来的文本消息直接进入 Jar runtime；
- 群聊 / 超级群里，只处理显式 `@mention` 或 reply-to-bot 的消息；
- 一个 Telegram chat/topic 对应某个 Jarvis entity 在 Telegram 上的局部 Jar session；
- assistant 回复通过 Telegram draft/message streaming 发送。
- 支持 `/btw <entity> <question>` 侧问，不污染目标 thread 的主历史。

第一版明确**不做**：

- webhook 部署
- Telegram 历史消息回拉
- 多平台统一的外部 gateway state backend
- 多模态输入（图片、语音、文件）解析

## 当前形态

`apps/jar-telegram` 是一个单独的 Node.js daemon，但它现在是一个 Telegram identity supervisor，而不是单 bot daemon。它会为 `platform.telegram.identities.*` 下的每个配置启动一个独立的 Telegram bot。

入口是：

- `apps/jar-telegram/src/main.ts`
- `apps/jar-telegram/src/telegram-runtime.ts`

服务会：

1. 读取 `jar.toml`
2. 读取 `platform.telegram.identities.*`
3. 为每个 Telegram identity 启动一个独立的 grammY bot 和 long polling runner
4. 过滤可处理的 Telegram 消息
5. 将同一 chat/topic 的突发消息合并进各 identity 自己的内存队列
6. 先把消息路由到当前 Telegram identity，再映射到该 identity 绑定 entity 的局部 Jar session
7. 流式把 assistant 输出发回 Telegram

## 运行方式

开发时：

```bash
pnpm dev:telegram
```

显式指定配置文件：

```bash
pnpm --filter @hijarvis/jar-telegram dev -- --config ./jar.toml
```

## 配置来源

Telegram gateway 现在优先从 `jar.toml` 的 `platform.telegram.identities.*` 读取配置。

推荐形态：

```toml
[entities.jarvis]
display_name = "Jarvis"

[entities.pm]
display_name = "PM Jarvis"

[platform.telegram.identities.telegram_main]
entity = "jarvis"
bot_token = "123456:telegram-bot-token"
allowed_chat_ids = [123456789, "-1009876543210"]
allowed_usernames = ["wibus"]

[platform.telegram.identities.telegram_pm]
entity = "pm"
bot_token = "654321:telegram-bot-token"
allowed_chat_ids = [987654321]
allowed_usernames = ["wibus"]

[logging]
level = "info"
stderr = true
file_path = ".jar/logs/runtime.log"
```

环境变量只作为 override：

```bash
TELEGRAM_BOT_TOKEN=123456:telegram-bot-token
JARVIS_TELEGRAM_ALLOWED_CHAT_IDS=123456789,-1009876543210
JARVIS_TELEGRAM_ALLOWED_USERNAMES=wibus,jarvisuser
```

说明：

- `allowed_chat_ids` 适合 identity 级访问控制，用来限制某个 Telegram bot 只服务指定 chat。
- `allowed_usernames` 适合 identity 级访问控制，用来限制某个 Telegram bot 只响应指定 username。
- `JARVIS_TELEGRAM_ALLOWED_CHAT_IDS` 使用逗号分隔。
- `JARVIS_TELEGRAM_ALLOWED_USERNAMES` 使用逗号分隔，支持写成带 `@` 或不带 `@`。

这些环境变量是全进程级 override，不适合长期用于多 bot 生产配置。真正的多 bot 配置应直接写进 `jar.toml`。

## 触发规则

### 1. 私聊

只要是文本消息或带 caption 的媒体消息，就会进入 Jar session。

### 2. 群聊 / 超级群

只有这些情况会触发：

- 文本中显式包含 bot username mention
- 当前消息是对 bot 消息的 reply

第一版不会因为“之前 bot 回过一次”就自动订阅整个群聊上下文。

## Entity 与 Session 映射

Telegram gateway 现在区分三层：

- `platform identity`：真实 Telegram bot 身份，例如 `telegram_main`
- `entity`：该 Telegram bot 绑定的 Jarvis 身份，例如 `jarvis` 或 `pm`
- `session`：该 identity 在某个 Telegram chat/topic 上的局部持续线程

普通 Telegram 消息不再进入默认 entity。它们总是进入当前 Telegram bot identity 绑定的 entity。

`/btw <entity> <question>` 会触发 side query：

1. 解析目标 entity
2. 查找该 entity 最近活跃的 identity-bound thread session
3. 只读地运行一轮短答
4. 把结果回到当前 Telegram chat

side query 不会把这次问答写入目标 thread 的正式 transcript。

## Session 映射

Telegram chat/topic 会映射成：

```text
telegram:{chatId}
```

如果消息属于 forum topic，则会映射成：

```text
telegram:{chatId}:{messageThreadId}
```

Jar 本地 session id 会进一步转成带 identity 前缀的 filesystem-safe 形态：

```text
identity__telegram_main__telegram__chat__{chatId}
identity__telegram_main__telegram__chat__{chatId}__thread__{messageThreadId}
```

这样可以保证：

- 同一个 Telegram identity 的一个 chat 对应一个 session
- 群聊 topic 可以独立维护上下文
- 不同 Telegram bots 即使进入同一个群聊坐标，也不会共享 session

## 上下文组装

Telegram Bot API 不提供像 Slack channel history 那样的“按需回看一小段上下文”能力，所以 Telegram prompt 不会尝试伪造完整历史。

第一版 prompt 只由这些部分组成：

1. 平台说明（private chat 或 group）
2. 当前消息的 reply context（如果存在）
3. 在 bot 处理期间合并进队列的 skipped messages
4. 当前用户消息

更早的长期上下文仍然以 Jar session 为准。

## Streaming 行为

Telegram gateway 使用 `@grammyjs/stream`：

- assistant text delta 会边生成边推送到 Telegram draft/message
- 如果模型这轮没有产生文本，会发一个简短 fallback reply
- 如果本轮失败且还没有发出任何文本，会发一条错误提示

## 为什么 queue 仍然保留在内存

第一版 Telegram gateway 的内存态只承担：

- 同一 chat/topic 的串行处理
- 快速连发消息的批量合并

它**不是** Jar 的长期记忆存储。

当前限制：

- 进程重启后，queue 状态会丢失
- 但 `.jar/sessions` 里的 session 历史仍会保留

## 验证建议

最小验证路径：

1. 启动 `apps/jar-telegram`
2. 在 Telegram 私聊里连续发送两三条消息，确认可以走同一个 session
3. 发送一个较长请求，确认回复以 streaming 方式出现
4. 在群聊里 `@mention` bot，确认它只在被触发时回复
5. 对 bot 的上一条消息 reply，确认可以继续同一个 chat/topic session
6. 重启服务后重新发消息，确认 session 历史仍可继续使用

## 已知限制

- 只支持 long polling，不支持 webhook
- 不做 Telegram 历史消息回看
- 只处理 text / caption 输入
- 群聊 follow-up 仍要求 mention 或 reply-to-bot
