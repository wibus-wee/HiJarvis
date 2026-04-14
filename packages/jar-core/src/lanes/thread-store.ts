import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type { ThreadMeta } from "./types.js";
import { resolveThreadDir } from "./path-layout.js";
import { materializeLaneView } from "./materializer.js";
import { openTape } from "./tape-store.js";

export type ThreadListItem = {
  threadId: string;
  createdAt: number;
  updatedAt: number;
  provider: string;
  model: string;
};

export const ensureThreadMeta = async (options: {
  rootDir: string;
  threadId: string;
  provider: string;
  model: string;
  routing: ThreadMeta["routing"];
}): Promise<ThreadMeta> => {
  const threadDir = resolveThreadDir(options.rootDir, options.threadId);
  const metaPath = path.join(threadDir, "meta.json");
  await mkdir(threadDir, { recursive: true });

  try {
    const existing = JSON.parse(await readFile(metaPath, "utf8")) as ThreadMeta;
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const now = Date.now();
  const meta: ThreadMeta = {
    v: 1,
    threadId: options.threadId,
    activeLaneId: "main",
    provider: options.provider,
    model: options.model,
    routing: options.routing,
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
};

export const listThreads = async (rootDir: string): Promise<ThreadListItem[]> => {
  const threadsDir = path.join(path.resolve(rootDir), "threads");
  let entries: string[] = [];
  try {
    entries = await readdir(threadsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const threads = await Promise.all(entries.map(async (threadId) => {
    const metaPath = path.join(threadsDir, threadId, "meta.json");
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as ThreadMeta;
      return {
        threadId: meta.threadId,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        provider: meta.provider,
        model: meta.model,
      } satisfies ThreadListItem;
    } catch {
      return null;
    }
  }));

  return threads
    .filter((thread): thread is ThreadListItem => thread !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt);
};

export const touchThread = async (rootDir: string, threadId: string): Promise<void> => {
  const metaPath = path.join(resolveThreadDir(rootDir, threadId), "meta.json");
  const raw = await readFile(metaPath, "utf8");
  const meta = JSON.parse(raw) as ThreadMeta;
  const updated: ThreadMeta = {
    ...meta,
    updatedAt: Date.now(),
  };
  await writeFile(metaPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  const laneMetaPath = path.join(resolveThreadDir(rootDir, threadId), "lanes", meta.activeLaneId, "meta.json");
  try {
    const laneRaw = await readFile(laneMetaPath, "utf8");
    const lane = JSON.parse(laneRaw) as Record<string, unknown>;
    await writeFile(laneMetaPath, `${JSON.stringify({ ...lane, updatedAt: Date.now() }, null, 2)}\n`, "utf8");
  } catch {
    // ignore lane meta touch failures until lane-store is formalized
  }
};

/**
 * Load the materialized message history for a thread without opening a full
 * ConversationHandle. Use this when you only need to read history (e.g. to
 * populate the REPL transcript) rather than to write new messages.
 */
export const loadThreadMessages = async (options: {
  rootDir: string;
  threadId: string;
  provider: string;
  model: string;
}): Promise<AgentMessage[]> => {
  const laneId = "main";
  await mkdir(resolveThreadDir(options.rootDir, options.threadId), { recursive: true });
  const tape = await openTape({
    rootDir: options.rootDir,
    threadId: options.threadId,
    laneId,
  });
  const materialized = await materializeLaneView(tape);
  return [...materialized.messages];
};
