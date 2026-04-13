import { appendFile, mkdir, readFile } from "node:fs/promises";
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
  const tapePath = resolveTapePath(options.rootDir, options.threadId, options.laneId);
  const headPath = path.join(laneDir, "head.json");

  return {
    rootDir: options.rootDir,
    threadId: options.threadId,
    laneId: options.laneId,
    tapePath,
    state: {
      nextOffset: await resolveNextOffset(tapePath, headPath),
      writeChain: Promise.resolve(),
      lastError: undefined,
    },
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
  if (tape.state.lastError) {
    throw tape.state.lastError;
  }
  const recordPromise = tape.state.writeChain.then(
    async () => {
      const record: TapeRecord = {
        v: 1,
        offset: tape.state.nextOffset,
        threadId: tape.threadId,
        laneId: tape.laneId,
        recordedAt: Date.now(),
        type: input.type,
        payload: input.payload,
      };
      await appendFile(tape.tapePath, `${JSON.stringify(record)}\n`, "utf8");
      tape.state.nextOffset += 1;
      return record;
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const wrapped = new Error(`Previous tape write failed: ${message}`);
      tape.state.lastError = wrapped;
      throw wrapped;
    },
  );
  tape.state.writeChain = recordPromise.then(
    () => undefined,
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const wrapped = new Error(`Previous tape write failed: ${message}`);
      tape.state.lastError = wrapped;
      return undefined;
    },
  );
  return recordPromise;
};

const resolveNextOffset = async (
  tapePath: string,
  headPath: string,
): Promise<number> => {
  const lastOffset = await readHeadLastOffset(headPath) ?? await readTapeLastOffset(tapePath) ?? 0;
  return lastOffset + 1;
};

const readHeadLastOffset = async (headPath: string): Promise<number | undefined> => {
  try {
    const raw = await readFile(headPath, "utf8");
    const head = JSON.parse(raw) as { lastOffset?: unknown };
    return typeof head.lastOffset === "number" ? head.lastOffset : undefined;
  } catch (error) {
    if (isEnoentError(error)) {
      return undefined;
    }
    throw error;
  }
};

const readTapeLastOffset = async (tapePath: string): Promise<number | undefined> => {
  try {
    const raw = await readFile(tapePath, "utf8");
    let lastOffset: number | undefined;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const record = JSON.parse(trimmed) as TapeRecord;
      lastOffset = record.offset;
    }
    return lastOffset;
  } catch (error) {
    if (isEnoentError(error)) {
      return undefined;
    }
    throw error;
  }
};

const isEnoentError = (error: unknown): error is NodeJS.ErrnoException => {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
};
