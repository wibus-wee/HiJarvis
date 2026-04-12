import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import {
  captureLiveThreadForSideQuestion,
  registerLiveThreadForSideQuestion,
  unregisterLiveThreadForSideQuestion,
  updateLiveThreadCaptureForSideQuestion,
} from "./live-thread-registry.js";

const createUserMessage = (content: string): AgentMessage => ({
  role: "user",
  content,
  timestamp: Date.now(),
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
    messages: initialMessages,
  });

  initialMessages.push(createUserMessage("mutated after publish"));

  const capture = captureLiveThreadForSideQuestion("thread_main");
  assert.deepEqual(capture?.messages.map((message) => message.content), ["first"]);

  unregisterLiveThreadForSideQuestion("thread_main");
});

test("captureLiveThreadForSideQuestion returns null for missing threads", () => {
  assert.equal(captureLiveThreadForSideQuestion("missing-thread"), null);
});
