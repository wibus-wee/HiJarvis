# Telegram Gateway

本页说明 `apps/jar-telegram` 的运行方式、触发规则、session 映射方式，以及它和现有 Jar runtime 的边界。

## 目标

第一版 Telegram 接入聚焦在“个人助理 bot”这个场景：

- 私聊里，用户发来的文本消息直接进入 Jar runtime；
- 群聊 / 超级群里，只处理显式 `@mention` 或 reply-to-bot 的消息；
- 一个 Telegram chat/topic 对应一个 Jar session；
- assistant 回复通过 Telegram draft/message streaming 发送。

第一版明确**不做**：

- webhook 部署
- Telegram 历史消息回拉
- 多平台统一的外部 gateway state backend
- 多模态输入（图片、语音、文件）解析

## 当前形态

`apps/jar-telegram` 是一个单独的 Node.js daemon，基于 `grammy` long polling 接收 update。

入口是：

- `apps/jar-telegram/src/main.ts`
- `apps/jar-telegram/src/telegram-runtime.ts`

服务会：

1. 读取 `jar.toml`
2. 启动 grammY bot 和 long polling runner
3. 过滤可处理的 Telegram 消息
4. 将同一 chat/topic 的突发消息合并进内存队列
5. 把消息映射到 Jar session
6. 流式把 assistant 输出发回 Telegram

## 运行方式

开发时：

```bash
pnpm dev:telegram
```

显式指定配置文件和健康检查端口：

```bash
pnpm --filter @hijarvis/jar-telegram dev -- --config ./jar.toml --port 3101
```

健康检查：

```bash
curl http://127.0.0.1:3001/healthz
```

## 配置来源

Telegram gateway 现在优先从 `jar.toml` 的 `[platform.telegram]` 读取配置。

推荐形态：

```toml
[platform.telegram]
bot_token = "123456:telegram-bot-token"
allowed_chat_ids = [123456789, "-1009876543210"]
allowed_usernames = ["wibus"]
host = "0.0.0.0"
port = 3001

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
JARVIS_TELEGRAM_HOST=0.0.0.0
JARVIS_TELEGRAM_PORT=3001
```

说明：

- `allowed_chat_ids` 适合个人助理场景，用来限制 bot 只服务指定 chat。
- `allowed_usernames` 适合个人助理场景，用来限制 bot 只响应指定 username。
- `JARVIS_TELEGRAM_ALLOWED_CHAT_IDS` 使用逗号分隔。
- `JARVIS_TELEGRAM_ALLOWED_USERNAMES` 使用逗号分隔，支持写成带 `@` 或不带 `@`。

## 触发规则

### 1. 私聊

只要是文本消息或带 caption 的媒体消息，就会进入 Jar session。

### 2. 群聊 / 超级群

只有这些情况会触发：

- 文本中显式包含 bot username mention
- 当前消息是对 bot 消息的 reply

第一版不会因为“之前 bot 回过一次”就自动订阅整个群聊上下文。

## Session 映射

Telegram chat/topic 会映射成：

```text
telegram:{chatId}
```

如果消息属于 forum topic，则会映射成：

```text
telegram:{chatId}:{messageThreadId}
```

Jar 本地 session id 会进一步转成 filesystem-safe 形态：

```text
telegram__{chatId}
telegram__{chatId}__{messageThreadId}
```

这样可以保证：

- 私聊一个 chat 对应一个 session
- 群聊 topic 可以独立维护上下文

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
