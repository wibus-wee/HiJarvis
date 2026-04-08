import assert from "node:assert/strict";
import test from "node:test";

import { partialCompactHistoryNow, type CompactionRuntime } from "./index.js";

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

const runtime: CompactionRuntime = {
  model: {
    id: "test-model",
    name: "test-model",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://example.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 4000,
    maxTokens: 1000,
  },
  systemPrompt: "You are Jarvis.",
  settings: {
    enabled: true,
    triggerRatio: 0.9,
    budgetRatio: 0.8,
    summaryMaxTokens: 128,
  },
};

test("partialCompactHistoryNow returns a safe no-op result when compaction is disabled", async () => {
  const messages = [
    makeUser("U1"),
    makeAssistant("A1"),
    makeUser("U2"),
    makeAssistant("A2"),
  ];

  const disabledRuntime: CompactionRuntime = {
    ...runtime,
    settings: {
      ...runtime.settings,
      enabled: false,
    },
  };

  const result = await partialCompactHistoryNow(messages, 2, "from", disabledRuntime);
  assert.equal(result.direction, "from");
  assert.equal(result.splitIndex, 2);
  assert.equal(result.stageCount, 0);
  assert.deepEqual(result.messages, messages);
});
