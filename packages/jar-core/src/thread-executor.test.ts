import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";

import {
  _resetLiveThreadRegistryForTest,
  captureLiveThreadForSideQuestion,
  registerLiveThreadForSideQuestion,
  unregisterLiveThreadForSideQuestion,
  updateLiveThreadCaptureForSideQuestion,
} from "./side-question/index.js";

test.beforeEach(() => {
  _resetLiveThreadRegistryForTest();
});

test.afterEach(() => {
  _resetLiveThreadRegistryForTest();
});

test("captureLiveThreadForSideQuestion remains detached from later parent mutations", () => {
  const parentMessages = [createAssistantMessage("parent v1")];
  registerLiveThreadForSideQuestion({
    threadId: "thread_live",
    laneId: "main",
  });
  updateLiveThreadCaptureForSideQuestion("thread_live", {
    threadId: "thread_live",
    laneId: "main",
    capturedAt: Date.now(),
    messages: parentMessages.map((message) => structuredClone(message)),
  });

  parentMessages.push(createAssistantMessage("parent v2"));

  const capture = captureLiveThreadForSideQuestion("thread_live");
  assert.deepEqual(capture?.messages.map((message) => readMessageText(message)), ["parent v1"]);

  unregisterLiveThreadForSideQuestion("thread_live");
});

const createAssistantMessage = (content: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: content }],
  api: "openai-responses",
  provider: "openai",
  model: "gpt-4o-mini",
  usage: emptyUsage(),
  timestamp: Date.now(),
  stopReason: "stop",
});

const readMessageText = (message: AgentMessage): string => {
  if (message.role !== "assistant") {
    return typeof message.content === "string" ? message.content : "";
  }

  return message.content
    .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("");
};

const emptyUsage = (): Usage => ({
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
});
