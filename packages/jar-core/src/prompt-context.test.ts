import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import {
  getPromptTextInput,
  injectPromptContextFragments,
  stripMemoryExcludedPromptContext,
  stripMemoryExcludedPromptContextFromHistory,
  stripMemoryExcludedPromptContextFromMessage,
  type PromptContextFragment,
} from "./prompt-context.js";

const sampleSkillFragment: PromptContextFragment = {
  kind: "skill",
  persistence: "memory_excluded",
  name: "demo",
  path: "/tmp/demo/SKILL.md",
  body: "# Demo\nUse demo.",
};

const makeAssistantMessage = (text: string): AgentMessage => ({
  role: "assistant",
  content: [{
    type: "text",
    text,
  }],
  api: "openai-responses",
  provider: "openai",
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
  stopReason: "stop",
  timestamp: 2,
});

test("injectPromptContextFragments prepends rendered fragments to string prompts", () => {
  const prompt = injectPromptContextFragments("User request", [sampleSkillFragment]);

  assert.equal(typeof prompt, "string");
  assert.match(prompt as string, /<skill>/);
  assert.match(prompt as string, /<name>demo<\/name>/);
  assert.match(prompt as string, /User request/);
});

test("getPromptTextInput reads only user text blocks", () => {
  const prompt = getPromptTextInput([
    makeAssistantMessage("ignore assistant"),
    {
      role: "user",
      content: [{
        type: "text",
        text: "hello",
      }, {
        type: "image",
        data: "ZmFrZQ==",
        mimeType: "image/png",
      }, {
        type: "text",
        text: "world",
      }],
      timestamp: 1,
    },
  ]);

  assert.equal(prompt, "hello\nworld");
});

test("stripMemoryExcludedPromptContext helpers remove older contextual fragments only", () => {
  const rendered = injectPromptContextFragments("User request", [sampleSkillFragment]) as string;
  const history: AgentMessage[] = [
    {
      role: "user",
      content: rendered,
      timestamp: 1,
    },
    makeAssistantMessage("answer"),
    {
      role: "user",
      content: rendered,
      timestamp: 3,
    },
  ];

  assert.equal(stripMemoryExcludedPromptContext(rendered), "User request");
  assert.deepEqual(
    stripMemoryExcludedPromptContextFromMessage(history[0]!),
    {
      role: "user",
      content: "User request",
      timestamp: 1,
    },
  );

  const strippedHistory = stripMemoryExcludedPromptContextFromHistory(history);
  assert.equal((strippedHistory[0] as Extract<AgentMessage, { role: "user" }>).content, "User request");
  assert.equal(strippedHistory[2], history[2]);
});
