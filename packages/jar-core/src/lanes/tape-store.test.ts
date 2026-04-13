import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { resolveLaneDir } from "./path-layout.js";

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

test("appendTapeRecord uses head lastOffset without replaying the whole tape", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-tape-head-"));
  try {
    const threadId = "thread_main";
    const laneId = "lane_main";
    const laneDir = resolveLaneDir(rootDir, threadId, laneId);
    await mkdir(laneDir, { recursive: true });
    await writeFile(path.join(laneDir, "head.json"), `${JSON.stringify({
      v: 1,
      threadId,
      laneId,
      lastOffset: 7,
      messages: [],
    }, null, 2)}\n`, "utf8");
    const tape = await openTape({
      rootDir,
      threadId,
      laneId,
    });
    await writeFile(tape.tapePath, "{not valid json}\n", "utf8");

    const record = await appendTapeRecord(tape, {
      type: "message.user",
      payload: {
        message: createUserMessage("hello after head"),
      },
    });

    assert.equal(record.offset, 8);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("appendTapeRecord keeps offset state in memory without rewriting head.json", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-tape-offset-cache-"));
  try {
    const threadId = "thread_main";
    const laneId = "lane_main";
    const laneDir = resolveLaneDir(rootDir, threadId, laneId);
    const headPath = path.join(laneDir, "head.json");
    await mkdir(laneDir, { recursive: true });
    const initialHead = `${JSON.stringify({
      v: 1,
      threadId,
      laneId,
      lastOffset: 4,
      messages: [],
    }, null, 2)}\n`;

    await writeFile(headPath, initialHead, "utf8");
    const tape = await openTape({
      rootDir,
      threadId,
      laneId,
    });

    const first = await appendTapeRecord(tape, {
      type: "message.user",
      payload: {
        message: createUserMessage("one"),
      },
    });
    const second = await appendTapeRecord(tape, {
      type: "message.user",
      payload: {
        message: createUserMessage("two"),
      },
    });

    assert.equal(first.offset, 5);
    assert.equal(second.offset, 6);
    assert.equal(await readFileUtf8(headPath), initialHead);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("appendTapeRecord serializes concurrent appends on the same tape handle", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-tape-concurrent-"));
  try {
    const tape = await openTape({
      rootDir,
      threadId: "thread_main",
      laneId: "lane_main",
    });

    const records = await Promise.all([
      appendTapeRecord(tape, {
        type: "message.user",
        payload: { message: createUserMessage("one") },
      }),
      appendTapeRecord(tape, {
        type: "message.user",
        payload: { message: createUserMessage("two") },
      }),
      appendTapeRecord(tape, {
        type: "message.user",
        payload: { message: createUserMessage("three") },
      }),
    ]);

    assert.deepEqual(records.map((record) => record.offset), [1, 2, 3]);
    const persisted = await readTapeRecords(tape);
    assert.deepEqual(persisted.map((record) => record.offset), [1, 2, 3]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("appendTapeRecord surfaces prior append failures", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-tape-error-"));
  try {
    const threadId = "thread_main";
    const laneId = "lane_main";
    const tape = await openTape({
      rootDir,
      threadId,
      laneId,
    });
    const originalTapePath = tape.tapePath;
    tape.tapePath = resolveLaneDir(rootDir, threadId, laneId);

    await assert.rejects(
      async () => {
        await appendTapeRecord(tape, {
          type: "message.user",
          payload: { message: createUserMessage("boom") },
        });
      },
      /EISDIR|illegal operation/, 
    );

    tape.tapePath = originalTapePath;
    await assert.rejects(
      async () => {
        await appendTapeRecord(tape, {
          type: "message.user",
          payload: { message: createUserMessage("retry") },
        });
      },
      /Previous tape write failed/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

const readFileUtf8 = (filePath: string): Promise<string> => readFile(filePath, "utf8");
