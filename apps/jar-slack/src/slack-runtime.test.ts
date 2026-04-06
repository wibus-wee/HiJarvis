import assert from "node:assert/strict";
import test from "node:test";

import type { Message } from "chat";

import {
  createSlackSessionId,
  formatCurrentMessageBlock,
  formatObservedContextBlock,
  formatQueuedMessagesBlock,
} from "./slack-prompt.js";

const createMessage = (input: {
  id: string;
  text: string;
  authorName: string;
  sentAt: string;
}): Message => {
  return {
    id: input.id,
    text: input.text,
    author: {
      fullName: input.authorName,
      userId: input.authorName,
      userName: input.authorName,
      isBot: false,
      isMe: false,
    },
    metadata: {
      dateSent: new Date(input.sentAt),
      edited: false,
    },
  } as Message;
};

test("createSlackSessionId normalizes thread ids into filesystem-safe session ids", () => {
  assert.equal(
    createSlackSessionId("slack:C123456:1743931234.56789"),
    "slack__C123456__1743931234.56789",
  );
});

test("formatObservedContextBlock renders ordered message history", () => {
  const block = formatObservedContextBlock([
    createMessage({
      id: "1",
      text: "We should ship on Friday.",
      authorName: "Wibus",
      sentAt: "2026-04-06T09:00:00.000Z",
    }),
    createMessage({
      id: "2",
      text: "We still need the Slack bot.",
      authorName: "Wibus",
      sentAt: "2026-04-06T09:01:00.000Z",
    }),
  ]);

  assert.match(block, /Observed channel context before the mention:/);
  assert.match(block, /Wibus: We should ship on Friday\./);
  assert.match(block, /Wibus: We still need the Slack bot\./);
});

test("formatQueuedMessagesBlock includes skipped messages when queue mode coalesces them", () => {
  const block = formatQueuedMessagesBlock({
    skipped: [
      createMessage({
        id: "3",
        text: "One more thing",
        authorName: "Wibus",
        sentAt: "2026-04-06T09:02:00.000Z",
      }),
    ],
    totalSinceLastHandler: 2,
  });

  assert.match(block, /Additional user messages/);
  assert.match(block, /Wibus: One more thing/);
});

test("formatCurrentMessageBlock renders the active request", () => {
  const block = formatCurrentMessageBlock(
    createMessage({
      id: "4",
      text: "Summarize what I said above.",
      authorName: "Wibus",
      sentAt: "2026-04-06T09:03:00.000Z",
    }),
  );

  assert.match(block, /Current user request:/);
  assert.match(block, /Wibus: Summarize what I said above\./);
});
