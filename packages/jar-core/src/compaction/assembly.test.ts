import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompactedMessages,
  shouldCompactFromUsage,
  type CompactionSettings,
} from "./index.js";
import type { Usage } from "@mariozechner/pi-ai";

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

const makeToolCallAssistant = (toolName: string) => ({
  role: "assistant" as const,
  content: [{
    type: "toolCall" as const,
    id: `${toolName}-call`,
    name: toolName,
    arguments: { query: "status" },
  }],
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
  stopReason: "toolUse" as const,
  timestamp: 1,
});

const makeToolResult = (toolName: string, text: string) => ({
  role: "toolResult" as const,
  toolCallId: `${toolName}-call`,
  toolName,
  content: [{ type: "text" as const, text }],
  isError: false,
  timestamp: 1,
});

const settings: CompactionSettings = {
  enabled: true,
  triggerRatio: 0.9,
  budgetRatio: 0.8,
  summaryMaxTokens: 1024,
};

const makeUsage = (input: number): Usage => ({
  input,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
});

test("buildCompactedMessages drops assistant tail during pre-turn compaction", () => {
  const messages = [
    makeUser(makeText("U1:", 80)),
    makeAssistant(makeText("A1:", 80)),
    makeUser(makeText("U2:", 80)),
    makeAssistant(makeText("A2:", 80)),
  ];

  const result = buildCompactedMessages({
    kind: "pre_turn",
    messages,
    summaryText: "Summary.",
    settings,
    contextWindow: 500,
    systemPromptTokens: 0,
  });

  assert.equal(result.length, 3);
  const first = result[0];
  const second = result[1];
  const third = result[2];
  assert.ok(first);
  assert.ok(second);
  assert.ok(third);
  assert.equal(first.role, "user");
  assert.match(first.content as string, new RegExp(SUMMARY_PREFIX));
  assert.equal(second.role, "user");
  assert.match(second.content as string, /U1:/);
  assert.equal(third.role, "user");
  assert.match(third.content as string, /U2:/);
});

test("buildCompactedMessages keeps minimal tool tail during mid-turn compaction", () => {
  const messages = [
    makeUser(makeText("U1:", 80)),
    makeAssistant(makeText("A1:", 40)),
    makeUser(makeText("U2:", 80)),
    makeToolCallAssistant("bash"),
    makeToolResult("bash", makeText("T1:", 20)),
  ];

  const result = buildCompactedMessages({
    kind: "mid_turn",
    messages,
    summaryText: "Summary.",
    settings,
    contextWindow: 500,
    systemPromptTokens: 0,
  });

  const third = result[2];
  const fourth = result[3];
  const fifth = result[4];
  assert.ok(third);
  assert.ok(fourth);
  assert.ok(fifth);
  assert.equal(third.role, "user");
  assert.match(third.content as string, /U2:/);
  assert.equal(fourth.role, "assistant");
  assert.equal(fourth.content[0]?.type, "toolCall");
  assert.equal(fifth.role, "toolResult");
  const first = result[0];
  assert.ok(first);
  assert.equal(first.role, "user");
  assert.match(first.content as string, new RegExp(SUMMARY_PREFIX));
});

test("buildCompactedMessages skips summary when summaryText is null", () => {
  const messages = [
    makeUser(makeText("U1:", 60)),
    makeAssistant(makeText("A1:", 60)),
    makeUser(makeText("U2:", 60)),
  ];

  const result = buildCompactedMessages({
    kind: "pre_turn",
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

test("shouldCompactFromUsage triggers from input tokens only", () => {
  const runtime = {
    model: {
      id: "test-model",
      name: "test-model",
      api: "openai-responses" as const,
      provider: "openai" as const,
      baseUrl: "https://example.com",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 1000,
      maxTokens: 1000,
    },
    settings,
  };

  assert.equal(shouldCompactFromUsage(makeUsage(900), runtime), true);
  assert.equal(shouldCompactFromUsage(makeUsage(899), runtime), false);
  assert.equal(shouldCompactFromUsage(makeUsage(0), runtime), false);
});
