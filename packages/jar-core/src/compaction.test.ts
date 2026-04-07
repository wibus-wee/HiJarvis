import assert from "node:assert/strict";
import test from "node:test";

import { buildCompactedMessages, type CompactionSettings } from "./compaction.js";

const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process.";

const makeText = (label: string, tokens: number): string =>
  `${label}${"x".repeat(tokens * 4)}`;

const makeUser = (text: string) => ({
  role: "user" as const,
  content: text,
  timestamp: 1,
});

const makeAssistant = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
  api: "openai-responses" as const,
  provider: "openai" as const,
  model: "gpt-test",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  },
  stopReason: "stop" as const,
  timestamp: 1,
});

const settings: CompactionSettings = {
  enabled: true,
  triggerRatio: 0.9,
  budgetRatio: 0.8,
  tailRatio: 0.1,
  summaryMaxTokens: 1024,
};

test("buildCompactedMessages keeps recent user messages, summary, and tail", () => {
  const messages = [
    makeUser(makeText("U1:", 80)),
    makeAssistant(makeText("A1:", 80)),
    makeUser(makeText("U2:", 80)),
    makeAssistant(makeText("A2:", 80)),
    makeUser(makeText("U3:", 80)),
  ];

  const result = buildCompactedMessages({
    messages,
    summaryText: "Summary.",
    settings,
    contextWindow: 500,
    systemPromptTokens: 0,
  });

  assert.equal(result.length, 4);
  const first = result[0];
  const second = result[1];
  const third = result[2];
  const fourth = result[3];
  assert.ok(first);
  assert.ok(second);
  assert.ok(third);
  assert.ok(fourth);
  assert.equal(first.role, "user");
  assert.match(first.content as string, /U1:/);
  assert.equal(second.role, "user");
  assert.match(second.content as string, /U2:/);
  assert.equal(third.role, "user");
  assert.match(third.content as string, new RegExp(SUMMARY_PREFIX));
  assert.equal(fourth.role, "user");
  assert.match(fourth.content as string, /U3:/);
});

test("buildCompactedMessages skips summary when summaryText is null", () => {
  const messages = [
    makeUser(makeText("U1:", 60)),
    makeAssistant(makeText("A1:", 60)),
    makeUser(makeText("U2:", 60)),
  ];

  const result = buildCompactedMessages({
    messages,
    summaryText: null,
    settings,
    contextWindow: 300,
    systemPromptTokens: 0,
  });

  assert.equal(result.some((message) => {
    if (message.role !== "user") {
      return false;
    }
    return (message.content as string).startsWith(SUMMARY_PREFIX);
  }), false);
});
