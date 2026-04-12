import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveLaneDir, resolveTapePath } from "./path-layout.js";
import type { TapeHandle, TapeRecord } from "./types.js";

export const openTape = async (options: {
  rootDir: string;
  threadId: string;
  laneId: string;
}): Promise<TapeHandle> => {
  const laneDir = resolveLaneDir(options.rootDir, options.threadId, options.laneId);
  await mkdir(laneDir, { recursive: true });

  return {
    rootDir: options.rootDir,
    threadId: options.threadId,
    laneId: options.laneId,
    tapePath: resolveTapePath(options.rootDir, options.threadId, options.laneId),
  };
};

export const readTapeRecords = async (
  tape: TapeHandle,
): Promise<TapeRecord[]> => {
  let raw = "";
  try {
    raw = await readFile(tape.tapePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const lines = raw.split("\n");
  const records: TapeRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    records.push(JSON.parse(trimmed) as TapeRecord);
  }
  return records;
};

export const appendTapeRecord = async (
  tape: TapeHandle,
  input: Omit<TapeRecord, "v" | "offset" | "threadId" | "laneId" | "recordedAt">,
): Promise<TapeRecord> => {
  const laneDir = resolveLaneDir(tape.rootDir, tape.threadId, tape.laneId);
  const headPath = path.join(laneDir, "head.json");
  const nextOffset = (await readHeadLastOffset(headPath) ?? 0) + 1;
  const record: TapeRecord = {
    v: 1,
    offset: nextOffset,
    threadId: tape.threadId,
    laneId: tape.laneId,
    recordedAt: Date.now(),
    type: input.type,
    payload: input.payload,
  };
  await appendFile(tape.tapePath, `${JSON.stringify(record)}\n`, "utf8");
  await writeHeadLastOffset(headPath, tape, nextOffset);
  return record;
};

const readHeadLastOffset = async (headPath: string): Promise<number | undefined> => {
  try {
    const raw = await readFile(headPath, "utf8");
    const head = JSON.parse(raw) as { lastOffset?: unknown };
    return typeof head.lastOffset === "number" ? head.lastOffset : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

const writeHeadLastOffset = async (
  headPath: string,
  tape: TapeHandle,
  lastOffset: number,
): Promise<void> => {
  const existing = await readHeadFile(headPath);
  const nextHead = {
    v: 1,
    threadId: tape.threadId,
    laneId: tape.laneId,
    ...existing,
    lastOffset,
  };
  await writeFile(headPath, `${JSON.stringify(nextHead, null, 2)}\n`, "utf8");
};

const readHeadFile = async (headPath: string): Promise<Record<string, unknown>> => {
  try {
    const raw = await readFile(headPath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
};
