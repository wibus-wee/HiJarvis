import assert from "node:assert/strict";
import test from "node:test";

import { extractCompactionArtifacts, renderArtifactMessages } from "./artifacts.js";
import type { CompactionRuntime } from "./types.js";

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
  recentSkillNames: ["execplan"],
};

test("extractCompactionArtifacts captures tool and skill restoration state", () => {
  const artifacts = extractCompactionArtifacts([
    {
      role: "toolResult",
      toolCallId: "tool_1",
      toolName: "bash",
      content: [{ type: "text", text: "git status output" }],
      isError: false,
      timestamp: 1,
    },
  ], runtime);

  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0]?.kind, "tool_state");
  assert.equal(artifacts[1]?.kind, "skill_state");
});

test("renderArtifactMessages converts artifacts into structured restoration messages", () => {
  const messages = renderArtifactMessages([
    {
      kind: "tool_state",
      label: "Last tool result: bash",
      content: "git status output",
    },
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "user");
  assert.match(String(messages[0]?.content), /Structured restoration state/);
});
