import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";

import {
  appendTapeRecord,
  materializeLaneView,
  openTape,
} from "./index.js";

const createUserMessage = (content: string): AgentMessage => ({
  role: "user",
  content,
  timestamp: Date.now(),
});

const createAssistantMessage = (content: string): AgentMessage => ({
  role: "assistant",
  content: [{ type: "text", text: content }],
  api: "openai-responses",
  provider: "openai",
  model: "gpt-4o-mini",
  usage: emptyUsage(),
  timestamp: Date.now(),
  stopReason: "stop",
} satisfies AssistantMessage);

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

const summarizeMessages = (messages: AgentMessage[]): unknown[] => {
  return messages.map((message) => {
    if (message.role === "user") {
      return {
        role: message.role,
        content: message.content,
      };
    }

    return {
      role: message.role,
      content: message.content,
    };
  });
};

test("materializeLaneView replays messages when no checkpoint exists", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-lane-view-"));
  try {
    const tape = await openTape({
      rootDir,
      threadId: "thread_main",
      laneId: "lane_main",
    });

    await appendTapeRecord(tape, {
      type: "message.user",
      payload: {
        message: createUserMessage("hello"),
      },
    });
    await appendTapeRecord(tape, {
      type: "message.assistant",
      payload: {
        message: createAssistantMessage("world"),
      },
    });

    const view = await materializeLaneView(tape);
    assert.deepEqual(summarizeMessages(view.messages), [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("materializeLaneView rebuilds from latest checkpoint plus suffix", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-lane-checkpoint-"));
  try {
    const tape = await openTape({
      rootDir,
      threadId: "thread_main",
      laneId: "lane_main",
    });

    await appendTapeRecord(tape, {
      type: "message.user",
      payload: {
        message: createUserMessage("old one"),
      },
    });
    await appendTapeRecord(tape, {
      type: "message.assistant",
      payload: {
        message: createAssistantMessage("old two"),
      },
    });
    await appendTapeRecord(tape, {
      type: "lane.checkpoint",
      payload: {
        headMessages: [
          createAssistantMessage("checkpoint summary"),
        ],
        sourceOffsets: [1, 2],
      },
    });
    await appendTapeRecord(tape, {
      type: "message.user",
      payload: {
        message: createUserMessage("new tail"),
      },
    });

    const view = await materializeLaneView(tape);
    assert.deepEqual(summarizeMessages(view.messages), [
      { role: "assistant", content: [{ type: "text", text: "checkpoint summary" }] },
      { role: "user", content: "new tail" },
    ]);
    assert.equal(view.checkpointOffset, 3);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
