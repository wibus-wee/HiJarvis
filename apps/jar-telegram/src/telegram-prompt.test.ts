import assert from "node:assert/strict";
import test from "node:test";

import { parseSideQuestionCommand } from "@hijarvis/jar-core";

import { isTelegramSideQuestionCommand } from "./telegram-runtime.js";

import {
  buildTelegramPrompt,
  createTelegramSessionId,
  formatTelegramCurrentMessageBlock,
  formatTelegramQueuedMessagesBlock,
  formatTelegramReplyContextBlock,
  type TelegramMessage,
  type TelegramReplyContext,
} from "./telegram-prompt.js";

const createReplyContext = (input: {
  authorName: string;
  text: string;
  sentAt: string;
}): TelegramReplyContext => {
  return {
    authorId: input.authorName,
    authorName: input.authorName,
    text: input.text,
    sentAt: new Date(input.sentAt),
  };
};

const createMessage = (input: {
  id: string;
  text: string;
  authorName: string;
  sentAt: string;
  chatTitle?: string;
  replyTo?: TelegramReplyContext;
}): TelegramMessage => {
  return {
    id: input.id,
    text: input.text,
    authorId: input.authorName,
    authorName: input.authorName,
    sentAt: new Date(input.sentAt),
    chatTitle: input.chatTitle,
    replyTo: input.replyTo,
  };
};

test("createTelegramSessionId normalizes conversation ids into filesystem-safe session ids", () => {
  assert.equal(
    createTelegramSessionId("telegram:-10012345:77"),
    "telegram__-10012345__77",
  );
});

test("formatTelegramReplyContextBlock renders reply metadata", () => {
  const block = formatTelegramReplyContextBlock(
    createReplyContext({
      authorName: "Alice",
      text: "Please summarize this.",
      sentAt: "2026-04-06T09:00:00.000Z",
    }),
  );

  assert.match(block, /Telegram reply context/);
  assert.match(block, /Alice: Please summarize this\./);
});

test("formatTelegramQueuedMessagesBlock renders skipped Telegram messages", () => {
  const block = formatTelegramQueuedMessagesBlock([
    createMessage({
      id: "2",
      text: "And include action items.",
      authorName: "Wibus",
      sentAt: "2026-04-06T09:01:00.000Z",
    }),
  ]);

  assert.match(block, /Additional Telegram messages/);
  assert.match(block, /Wibus: And include action items\./);
});

test("formatTelegramCurrentMessageBlock renders the active Telegram message", () => {
  const block = formatTelegramCurrentMessageBlock(
    createMessage({
      id: "3",
      text: "Draft the reply for me.",
      authorName: "Wibus",
      sentAt: "2026-04-06T09:02:00.000Z",
    }),
  );

  assert.match(block, /Current Telegram user request/);
  assert.match(block, /Wibus: Draft the reply for me\./);
});

test("buildTelegramPrompt includes private-chat framing and reply context", () => {
  const prompt = buildTelegramPrompt({
    chatType: "private",
    skipped: [],
    message: createMessage({
      id: "4",
      text: "Handle this for me.",
      authorName: "Wibus",
      sentAt: "2026-04-06T09:03:00.000Z",
      replyTo: createReplyContext({
        authorName: "Alice",
        text: "Need an answer today.",
        sentAt: "2026-04-06T09:02:00.000Z",
      }),
    }),
  });

  assert.match(prompt, /Telegram private chat/);
  assert.match(prompt, /Need an answer today\./);
});

test("buildTelegramPrompt includes group framing and chat title", () => {
  const prompt = buildTelegramPrompt({
    chatType: "group",
    skipped: [],
    message: createMessage({
      id: "5",
      text: "Summarize the decision.",
      authorName: "Wibus",
      sentAt: "2026-04-06T09:04:00.000Z",
      chatTitle: "Jarvis Dev",
    }),
  });

  assert.match(prompt, /Telegram group or supergroup conversation/);
  assert.match(prompt, /Telegram chat title: Jarvis Dev/);
});

test("Telegram message text can be parsed as a /btw side question", () => {
  const parsed = parseSideQuestionCommand({
    input: "/btw summarize current status",
    parentThreadId: "thread_main",
    source: { platform: "telegram", identityId: "telegram_main" },
  });
  assert.equal(parsed?.kind, "side_question");
  assert.equal(parsed?.question.text, "summarize current status");
});

test("isTelegramSideQuestionCommand detects /btw commands before queueing", () => {
  assert.equal(isTelegramSideQuestionCommand("/btw summarize current status"), true);
  assert.equal(isTelegramSideQuestionCommand("normal message"), false);
  assert.equal(isTelegramSideQuestionCommand(undefined), false);
});
