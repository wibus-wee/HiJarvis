import assert from "node:assert/strict";
import test from "node:test";

import {
  createSlackSessionId,
  buildSubscribedThreadPrompt,
  createSlackReplyPayload,
  formatCurrentMessageBlock,
  formatObservedContextBlock,
  formatQueuedMessagesBlock,
  type SlackMessage,
} from "./slack-prompt.js";
import {
  classifySlackTrigger,
  hasSeenKey,
  normalizeSlackEvent,
} from "./slack-runtime.js";

const createMessage = (input: {
  id: string;
  text: string;
  authorName: string;
  sentAt: string;
}): SlackMessage => {
  return {
    id: input.id,
    text: input.text,
    authorId: input.authorName,
    authorName: input.authorName,
    sentAt: new Date(input.sentAt),
  };
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
  const block = formatQueuedMessagesBlock([
    createMessage({
      id: "3",
      text: "One more thing",
      authorName: "Wibus",
      sentAt: "2026-04-06T09:02:00.000Z",
    }),
  ]);

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

test("buildSubscribedThreadPrompt keeps thread instructions separate from request content", () => {
  const prompt = buildSubscribedThreadPrompt(
    createMessage({
      id: "5",
      text: "Summarize the thread.",
      authorName: "Wibus",
      sentAt: "2026-04-06T09:04:00.000Z",
    }),
    [
      createMessage({
        id: "6",
        text: "Also mention the deadline.",
        authorName: "Wibus",
        sentAt: "2026-04-06T09:05:00.000Z",
      }),
    ],
  );

  assert.match(prompt, /You are continuing an existing Slack thread conversation\./);
  assert.match(prompt, /Additional user messages that arrived while you were still processing the previous turn:/);
  assert.match(prompt, /Current user request:/);
});

test("createSlackReplyPayload preserves markdown and emits markdown blocks", () => {
  const payload = createSlackReplyPayload("## Title\n**hello**\n*world*\n~~gone~~\n[docs](https://example.com)");

  assert.equal(payload.text, "## Title\n**hello**\n*world*\n~~gone~~\n[docs](https://example.com)");
  assert.equal(payload.blocks?.length, 1);
  assert.deepEqual(payload.blocks?.[0], {
    type: "markdown",
    text: "## Title\n**hello**\n*world*\n~~gone~~\n[docs](https://example.com)",
  });
});

test("createSlackReplyPayload splits markdown blocks on paragraph boundaries", () => {
  const payload = createSlackReplyPayload([
    "## First",
    "",
    "Second paragraph with `code`.",
  ].join("\n"));

  assert.equal(payload.blocks?.length, 2);
  assert.deepEqual(payload.blocks, [
    {
      type: "markdown",
      text: "## First",
    },
    {
      type: "markdown",
      text: "Second paragraph with `code`.",
    },
  ]);
});

test("createSlackReplyPayload splits long replies across multiple markdown blocks", () => {
  const payload = createSlackReplyPayload(`${"a".repeat(2_900)}\n${"b".repeat(200)}`);

  assert.equal(payload.blocks?.length, 2);
  assert.equal(payload.blocks?.[0]?.text.length, 3_000);
  assert.equal(payload.blocks?.[1]?.text.length, 101);
});

test("normalizeSlackEvent strips bot mentions and derives stable keys", () => {
  const normalized = normalizeSlackEvent(
    "app_mention",
    {
      channel: "C123",
      ts: "1743931234.56789",
      text: "<@U_BOT> summarize this thread",
      user: "U_WIBUS",
    },
    "U_BOT",
    "Ev123",
  );

  assert.ok(normalized);
  assert.equal(normalized.text, "summarize this thread");
  assert.equal(normalized.hasBotMention, true);
  assert.equal(normalized.threadKey, "C123:1743931234.56789");
  assert.equal(normalized.messageKey, "C123:1743931234.56789");
  assert.equal(normalized.eventId, "Ev123");
});

test("classifySlackTrigger opens a new subscription for an unsubscribed mention", () => {
  const normalized = normalizeSlackEvent(
    "app_mention",
    {
      channel: "C123",
      ts: "1743931234.56789",
      text: "<@U_BOT> take a look",
      user: "U_WIBUS",
    },
    "U_BOT",
    undefined,
  );

  assert.ok(normalized);
  const decision = classifySlackTrigger(normalized, new Set<string>());
  assert.equal(decision.action, "enqueue");
  if (decision.action !== "enqueue") {
    throw new Error("Expected enqueue decision");
  }

  assert.equal(decision.queueKind, "new_mention");
  assert.equal(decision.shouldSubscribe, true);
  assert.equal(decision.alreadySubscribed, false);
});

test("classifySlackTrigger treats later thread mentions as subscribed follow-ups", () => {
  const normalized = normalizeSlackEvent(
    "app_mention",
    {
      channel: "C123",
      thread_ts: "1743931234.56789",
      ts: "1743931240.00001",
      text: "<@U_BOT> one more thing",
      user: "U_WIBUS",
    },
    "U_BOT",
    undefined,
  );

  assert.ok(normalized);
  const decision = classifySlackTrigger(
    normalized,
    new Set<string>(["C123:1743931234.56789"]),
  );
  assert.equal(decision.action, "enqueue");
  if (decision.action !== "enqueue") {
    throw new Error("Expected enqueue decision");
  }

  assert.equal(decision.queueKind, "subscribed");
  assert.equal(decision.shouldSubscribe, false);
  assert.equal(decision.alreadySubscribed, true);
});

test("message-level dedupe blocks the same Slack message across event types", () => {
  const appMention = normalizeSlackEvent(
    "app_mention",
    {
      channel: "C123",
      thread_ts: "1743931234.56789",
      ts: "1743931240.00001",
      text: "<@U_BOT> one more thing",
      user: "U_WIBUS",
    },
    "U_BOT",
    "EvMention",
  );
  const messageEvent = normalizeSlackEvent(
    "message",
    {
      channel: "C123",
      thread_ts: "1743931234.56789",
      ts: "1743931240.00001",
      text: "<@U_BOT> one more thing",
      user: "U_WIBUS",
    },
    "U_BOT",
    "EvMessage",
  );

  assert.ok(appMention);
  assert.ok(messageEvent);

  const subscriptions = new Set<string>(["C123:1743931234.56789"]);
  const firstDecision = classifySlackTrigger(appMention, subscriptions);
  const secondDecision = classifySlackTrigger(messageEvent, subscriptions);

  assert.equal(firstDecision.action, "enqueue");
  assert.equal(secondDecision.action, "enqueue");
  if (firstDecision.action !== "enqueue" || secondDecision.action !== "enqueue") {
    throw new Error("Expected both decisions to enqueue before message dedupe");
  }

  const seenMessages = new Map<string, number>();
  assert.equal(hasSeenKey(seenMessages, firstDecision.messageKey, 60_000, 0), false);
  assert.equal(hasSeenKey(seenMessages, secondDecision.messageKey, 60_000, 1), true);
});

test("hasSeenKey expires old entries before admitting a new key", () => {
  const seen = new Map<string, number>();

  assert.equal(hasSeenKey(seen, "C123:1", 10, 0), false);
  assert.equal(hasSeenKey(seen, "C123:1", 10, 5), true);
  assert.equal(hasSeenKey(seen, "C123:2", 10, 15), false);
  assert.deepEqual([...seen.keys()], ["C123:2"]);
});
