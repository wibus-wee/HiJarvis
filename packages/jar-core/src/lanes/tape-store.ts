import { appendFile, mkdir, readFile } from "node:fs/promises";

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
  const existing = await readTapeRecords(tape);
  const nextOffset = (existing.at(-1)?.offset ?? 0) + 1;
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
  return record;
};
