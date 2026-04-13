import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import {
  _resetLiveThreadRegistryForTest,
  captureLiveThreadForSideQuestion,
  getLiveThreadRegistrySize,
  registerLiveThreadForSideQuestion,
  unregisterLiveThreadForSideQuestion,
  updateLiveThreadCaptureForSideQuestion,
} from "./live-thread-registry.js";

const createUserMessage = (content: string): AgentMessage => ({
  role: "user",
  content,
  timestamp: Date.now(),
});

test.beforeEach(() => {
  _resetLiveThreadRegistryForTest();
});

test.afterEach(() => {
  _resetLiveThreadRegistryForTest();
});

test("captureLiveThreadForSideQuestion returns the latest immutable live snapshot", () => {
  registerLiveThreadForSideQuestion({
    threadId: "thread_main",
    laneId: "main",
  });

  const initialMessages = [createUserMessage("first")];
  updateLiveThreadCaptureForSideQuestion("thread_main", {
    threadId: "thread_main",
    laneId: "main",
    capturedAt: 1,
    messages: initialMessages.map((message) => structuredClone(message)),
  });

  initialMessages.push(createUserMessage("mutated after publish"));

  const capture = captureLiveThreadForSideQuestion("thread_main");
  assert.deepEqual(capture?.messages.map((message) => message.content), ["first"]);

  unregisterLiveThreadForSideQuestion("thread_main");
});

test("captureLiveThreadForSideQuestion returns null for missing threads", () => {
  assert.equal(captureLiveThreadForSideQuestion("missing-thread"), null);
});

test("stale live thread entries are swept lazily", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00.000Z") });

  registerLiveThreadForSideQuestion({
    threadId: "stale-thread",
    laneId: "main",
  });
  assert.equal(getLiveThreadRegistrySize(), 1);

  t.mock.timers.setTime(Date.now() + 30 * 60 * 1000 + 1);

  assert.equal(captureLiveThreadForSideQuestion("stale-thread"), null);
  assert.equal(getLiveThreadRegistrySize(), 0);
});
