import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";

import {
  appendTapeRecord,
  openTape,
  readTapeRecords,
  type TapeRecord,
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

test("appendTapeRecord assigns monotonic offsets", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-tape-store-"));
  try {
    const tape = await openTape({
      rootDir,
      threadId: "thread_main",
      laneId: "lane_main",
    });

    const first = await appendTapeRecord(tape, {
      type: "message.user",
      payload: {
        message: createUserMessage("hello"),
      },
    });
    const second = await appendTapeRecord(tape, {
      type: "message.assistant",
      payload: {
        message: createAssistantMessage("hi"),
      },
    });

    assert.equal(first.offset, 1);
    assert.equal(second.offset, 2);

    const records = await readTapeRecords(tape);
    assert.deepEqual(records.map((record) => record.offset), [1, 2]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("readTapeRecords tolerates lane checkpoints among message facts", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-tape-records-"));
  try {
    const tape = await openTape({
      rootDir,
      threadId: "thread_main",
      laneId: "lane_main",
    });

    await appendTapeRecord(tape, {
      type: "message.user",
      payload: {
        message: createUserMessage("first"),
      },
    });
    await appendTapeRecord(tape, {
      type: "lane.checkpoint",
      payload: {
        headMessages: [
          createAssistantMessage("summary"),
        ],
        sourceOffsets: [1],
      },
    });
    await appendTapeRecord(tape, {
      type: "message.user",
      payload: {
        message: createUserMessage("after checkpoint"),
      },
    });

    const records = await readTapeRecords(tape);
    assert.equal(records.length, 3);
    assert.equal(records[1]?.type, "lane.checkpoint");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

void (null as unknown as TapeRecord);
