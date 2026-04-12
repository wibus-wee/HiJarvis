import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

import type { Logger } from "../logger.js";
import {
  generateThreadItemId,
  generateThreadRunId,
  generateThreadTurnId,
  type CompactionEvent,
  type ThreadItem,
  type ThreadRun,
  type ThreadTurn,
} from "../execution-types.js";
import { resolveLaneDir, resolveThreadDir } from "./path-layout.js";
import { materializeLaneView } from "./materializer.js";
import { appendTapeRecord, openTape } from "./tape-store.js";

export type ConversationHandle = {
  threadId: string;
  laneId: string;
  messages: AgentMessage[];
  appendMessage: (message: AgentMessage) => Promise<void>;
  appendEvent: (event: AgentEvent | CompactionEvent) => Promise<void>;
  appendTurn: (turn: ThreadTurn) => Promise<void>;
  appendRun: (run: ThreadRun) => Promise<void>;
  appendItem: (item: ThreadItem) => Promise<void>;
  appendLaneCheckpoint: (messages: AgentMessage[], sourceOffsets: number[]) => Promise<void>;
  flush: () => Promise<void>;
};

type OpenConversationHandleOptions = {
  rootDir: string;
  threadId: string;
  provider: string;
  model: string;
  logger?: Logger;
};

export const openConversationHandle = async (
  options: OpenConversationHandleOptions,
): Promise<ConversationHandle> => {
  const threadDir = resolveThreadDir(options.rootDir, options.threadId);
  const laneId = "main";
  const laneDir = resolveLaneDir(options.rootDir, options.threadId, laneId);
  await mkdir(threadDir, { recursive: true });
  await mkdir(laneDir, { recursive: true });

  const threadMetaPath = path.join(threadDir, "meta.json");
  const laneMetaPath = path.join(laneDir, "meta.json");
  const eventsPath = path.join(laneDir, "events.jsonl");
  const turnsPath = path.join(laneDir, "turns.jsonl");
  const runsPath = path.join(laneDir, "runs.jsonl");
  const itemsPath = path.join(laneDir, "items.jsonl");
  const headPath = path.join(laneDir, "head.json");

  const now = Date.now();
  await writeJsonIfMissing(threadMetaPath, {
    v: 1,
    threadId: options.threadId,
    activeLaneId: laneId,
    provider: options.provider,
    model: options.model,
    routing: {
      identityId: "unknown",
      platform: "cli",
      scope: options.threadId,
    },
    createdAt: now,
    updatedAt: now,
  });
  await writeJsonIfMissing(laneMetaPath, {
    v: 1,
    laneId,
    threadId: options.threadId,
    kind: "main",
    status: "active",
    startOffset: 1,
    createdAt: now,
    updatedAt: now,
  });

  const tape = await openTape({
    rootDir: options.rootDir,
    threadId: options.threadId,
    laneId,
  });
  const materialized = await materializeLaneView(tape);
  const messages = [...materialized.messages];
  let lastOffset = materialized.lastOffset;

  return {
    threadId: options.threadId,
    laneId,
    messages,
    appendMessage: async (message) => {
      messages.push(message);
      const record = await appendTapeRecord(tape, {
        type: message.role === "user" ? "message.user" : "message.assistant",
        payload: { message },
      });
      lastOffset = record.offset;
    },
    appendEvent: async (event) => {
      await appendJsonLine(eventsPath, {
        v: 1,
        type: "event",
        threadId: options.threadId,
        laneId,
        recordedAt: Date.now(),
        event,
      });
    },
    appendTurn: async (turn) => {
      await appendJsonLine(turnsPath, {
        v: 1,
        type: "turn",
        threadId: options.threadId,
        laneId,
        recordedAt: Date.now(),
        turn,
      });
    },
    appendRun: async (run) => {
      await appendJsonLine(runsPath, {
        v: 1,
        type: "run",
        threadId: options.threadId,
        laneId,
        recordedAt: Date.now(),
        run,
      });
    },
    appendItem: async (item) => {
      await appendJsonLine(itemsPath, {
        v: 1,
        type: "item",
        threadId: options.threadId,
        laneId,
        recordedAt: Date.now(),
        item,
      });
    },
    appendLaneCheckpoint: async (checkpointMessages, sourceOffsets) => {
      messages.length = 0;
      messages.push(...checkpointMessages);
      const record = await appendTapeRecord(tape, {
        type: "lane.checkpoint",
        payload: {
          headMessages: checkpointMessages,
          sourceOffsets,
        },
      });
      lastOffset = record.offset;
      await writeFile(headPath, `${JSON.stringify({
        v: 1,
        threadId: options.threadId,
        laneId,
        lastOffset,
        messages: checkpointMessages,
      }, null, 2)}\n`, "utf8");
    },
    flush: async () => {
      await writeFile(headPath, `${JSON.stringify({
        v: 1,
        threadId: options.threadId,
        laneId,
        lastOffset,
        messages,
      }, null, 2)}\n`, "utf8");
    },
  };
};

const writeJsonIfMissing = async (filePath: string, value: object): Promise<void> => {
  try {
    await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
};

const appendJsonLine = async (filePath: string, value: object): Promise<void> => {
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
};
