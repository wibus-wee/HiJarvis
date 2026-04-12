import assert from "node:assert/strict";
import test from "node:test";

import {
  buildThreadIdFromScope,
  parseSideQuestionCommand,
  type IngressCommand,
} from "./index.js";

test("buildThreadIdFromScope derives stable Slack and Telegram thread ids from structured scope", () => {
  assert.equal(
    buildThreadIdFromScope({
      platform: "slack",
      identityId: "slack_main",
      scope: {
        kind: "slack",
        channelId: "C123",
        threadTs: "1743931234.56789",
      },
    }),
    "identity__slack_main__slack__channel__C123__thread__1743931234.56789",
  );

  assert.equal(
    buildThreadIdFromScope({
      platform: "telegram",
      identityId: "telegram_main",
      scope: {
        kind: "telegram",
        chatId: "10001",
        messageThreadId: "55",
      },
    }),
    "identity__telegram_main__telegram__chat__10001__thread__55",
  );
});

test("parseSideQuestionCommand converts /btw input into an ingress command", () => {
  const parsed = parseSideQuestionCommand({
    input: "/btw what changed?",
    parentThreadId: "thread_main",
    source: {
      platform: "cli",
    },
  });

  assert.ok(parsed);
  assert.equal(parsed?.kind, "side_question");
  assert.equal(parsed?.question.text, "what changed?");
  assert.equal(parsed?.parentThreadId, "thread_main");
});

test("message ingress commands preserve structured audit metadata", () => {
  const command: IngressCommand = {
    kind: "message",
    source: {
      platform: "slack",
      identityId: "slack_main",
      transportEventId: "evt-1",
    },
    routing: {
      platform: "slack",
      identityId: "slack_main",
      scope: {
        kind: "slack",
        channelId: "C123",
      },
    },
    actor: {
      userId: "U1",
      displayName: "Wibus",
    },
    message: {
      text: "hello",
    },
    context: {
      queuedMessages: [],
    },
    prompt: "hello",
    audit: {
      trigger: "platform_event",
      triggerKind: "app_mention",
      metadata: {
        channel: "C123",
      },
    },
  };

  if (command.kind !== "message") {
    throw new Error("expected message command");
  }
  assert.equal(command.audit.triggerKind, "app_mention");
  assert.deepEqual(command.audit.metadata, { channel: "C123" });
});
