import crypto from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

export type SessionMeta = {
  v: 1;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  provider: string;
  model: string;
};

export type SessionSnapshot = {
  v: 1;
  sessionId: string;
  updatedAt: number;
  lastSequence: number;
  messages: AgentMessage[];
};

export type SessionRecord = {
  v: 1;
  type: "message";
  sessionId: string;
  sequence: number;
  recordedAt: number;
  message: AgentMessage;
};

export type SessionEventRecord = {
  v: 1;
  type: "event";
  sessionId: string;
  sequence: number;
  recordedAt: number;
  event: AgentEvent;
};

export type SessionPaths = {
  rootDir: string;
  sessionDir: string;
  metaPath: string;
  messagesPath: string;
  snapshotPath: string;
  eventsPath: string;
};

export type OpenSessionOptions = {
  rootDir: string;
  sessionId?: string;
  provider: string;
  model: string;
};

export type SessionHandle = {
  sessionId: string;
  paths: SessionPaths;
  meta: SessionMeta;
  messages: AgentMessage[];
  appendMessage: (message: AgentMessage) => Promise<void>;
  appendEvent: (event: AgentEvent) => Promise<void>;
  writeSnapshot: (messages: AgentMessage[]) => Promise<void>;
};

type ParsedTranscript = {
  records: SessionRecord[];
  maxSequence: number;
};

type ParsedEvents = {
  maxSequence: number;
};

export type SessionListItem = {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  provider: string;
  model: string;
  messageCount?: number;
};

export const openSession = async (
  options: OpenSessionOptions,
): Promise<SessionHandle> => {
  const sessionId = options.sessionId ?? generateSessionId();
  assertValidSessionId(sessionId);

  const rootDir = path.resolve(options.rootDir);
  const sessionDir = path.join(rootDir, sessionId);
  const paths: SessionPaths = {
    rootDir,
    sessionDir,
    metaPath: path.join(sessionDir, "meta.json"),
    messagesPath: path.join(sessionDir, "messages.jsonl"),
    snapshotPath: path.join(sessionDir, "session.json"),
    eventsPath: path.join(sessionDir, "events.jsonl"),
  };

  await mkdir(paths.sessionDir, { recursive: true });

  const now = Date.now();
  const meta = await loadOrInitMeta(paths.metaPath, {
    v: 1,
    sessionId,
    createdAt: now,
    updatedAt: now,
    provider: options.provider,
    model: options.model,
  });

  const snapshot = await loadSnapshot(paths.snapshotPath);
  const transcript = await loadTranscript(paths.messagesPath);
  const events = await loadEvents(paths.eventsPath);

  const snapshotMessages = snapshot?.messages ?? [];
  const lastSequence = snapshot?.lastSequence ?? 0;

  const replayMessages = transcript.records
    .filter((record) => record.sequence > lastSequence)
    .sort((left, right) => left.sequence - right.sequence)
    .map((record) => record.message);

  const messages = snapshotMessages.concat(replayMessages);
  const maxSequence = Math.max(lastSequence, transcript.maxSequence);
  let nextSequence = maxSequence + 1;
  let nextEventSequence = events.maxSequence + 1;

  let writeQueue = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    writeQueue = writeQueue.then(task, task);
    return writeQueue;
  };

  const appendMessage = async (message: AgentMessage): Promise<void> => {
    await enqueue(async () => {
      const record: SessionRecord = {
        v: 1,
        type: "message",
        sessionId,
        sequence: nextSequence,
        recordedAt: Date.now(),
        message,
      };

      nextSequence += 1;
      await appendFile(paths.messagesPath, `${JSON.stringify(record)}\n`, "utf8");
    });
  };

  const appendEvent = async (event: AgentEvent): Promise<void> => {
    await enqueue(async () => {
      const record: SessionEventRecord = {
        v: 1,
        type: "event",
        sessionId,
        sequence: nextEventSequence,
        recordedAt: Date.now(),
        event,
      };

      nextEventSequence += 1;
      await appendFile(paths.eventsPath, `${JSON.stringify(record)}\n`, "utf8");
    });
  };

  const writeSnapshot = async (currentMessages: AgentMessage[]): Promise<void> => {
    await enqueue(async () => {
      const snapshotRecord: SessionSnapshot = {
        v: 1,
        sessionId,
        updatedAt: Date.now(),
        lastSequence: Math.max(0, nextSequence - 1),
        messages: currentMessages,
      };

      meta.updatedAt = snapshotRecord.updatedAt;
      meta.provider = options.provider;
      meta.model = options.model;

      await writeFile(
        paths.snapshotPath,
        `${JSON.stringify(snapshotRecord, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        paths.metaPath,
        `${JSON.stringify(meta, null, 2)}\n`,
        "utf8",
      );
    });
  };

  return {
    sessionId,
    paths,
    meta,
    messages,
    appendMessage,
    appendEvent,
    writeSnapshot,
  };
};

const generateSessionId = (): string => {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    pad2(now.getMonth() + 1),
    pad2(now.getDate()),
  ].join("");
  const time = [pad2(now.getHours()), pad2(now.getMinutes()), pad2(now.getSeconds())].join("");
  const suffix = crypto.randomBytes(3).toString("hex");

  return `sess_${stamp}_${time}_${suffix}`;
};

const pad2 = (value: number): string => value.toString().padStart(2, "0");

const assertValidSessionId = (sessionId: string): void => {
  if (sessionId.trim().length === 0) {
    throw new Error("Session id must not be empty");
  }

  if (sessionId.includes(path.sep) || sessionId.includes(path.posix.sep)) {
    throw new Error(`Session id "${sessionId}" must not contain path separators`);
  }
};

const loadOrInitMeta = async (
  metaPath: string,
  defaults: SessionMeta,
): Promise<SessionMeta> => {
  const existing = await readJsonFile<SessionMeta>(metaPath);
  if (!existing) {
    await writeFile(metaPath, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
    return defaults;
  }

  const updated: SessionMeta = {
    ...existing,
    updatedAt: defaults.updatedAt,
    provider: defaults.provider,
    model: defaults.model,
  };

  await writeFile(metaPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
};

const loadSnapshot = async (
  snapshotPath: string,
): Promise<SessionSnapshot | null> => {
  const snapshot = await readJsonFile<SessionSnapshot>(snapshotPath);
  if (!snapshot) {
    return null;
  }

  if (snapshot.v !== 1) {
    throw new Error(`Unsupported session snapshot version: ${snapshot.v}`);
  }

  return snapshot;
};

const loadTranscript = async (messagesPath: string): Promise<ParsedTranscript> => {
  const content = await readTextFile(messagesPath);
  if (content === null) {
    return { records: [], maxSequence: 0 };
  }

  const records: SessionRecord[] = [];
  let maxSequence = 0;
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.trim().length === 0) {
      continue;
    }

    try {
      const record = JSON.parse(line) as SessionRecord;
      if (record.type !== "message" || record.v !== 1) {
        continue;
      }
      records.push(record);
      maxSequence = Math.max(maxSequence, record.sequence);
    } catch (error) {
      if (index === lines.length - 1) {
        break;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse session transcript at line ${index + 1}: ${message}`);
    }
  }

  return { records, maxSequence };
};

const loadEvents = async (eventsPath: string): Promise<ParsedEvents> => {
  const content = await readTextFile(eventsPath);
  if (content === null) {
    return { maxSequence: 0 };
  }

  let maxSequence = 0;
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.trim().length === 0) {
      continue;
    }

    try {
      const record = JSON.parse(line) as SessionEventRecord;
      if (record.type !== "event" || record.v !== 1) {
        continue;
      }
      maxSequence = Math.max(maxSequence, record.sequence);
    } catch (error) {
      if (index === lines.length - 1) {
        break;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse session events at line ${index + 1}: ${message}`);
    }
  }

  return { maxSequence };
};

export const listSessions = async (
  rootDir: string,
): Promise<SessionListItem[]> => {
  const resolvedRoot = path.resolve(rootDir);
  let entries: string[] = [];

  try {
    entries = await readdir(resolvedRoot);
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const items: SessionListItem[] = [];

  for (const entry of entries) {
    const sessionDir = path.join(resolvedRoot, entry);
    let stats: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      stats = await stat(sessionDir);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) {
      continue;
    }

    const meta = await readJsonFile<SessionMeta>(path.join(sessionDir, "meta.json"));
    if (!meta) {
      continue;
    }

    const snapshot = await readJsonFile<SessionSnapshot>(path.join(sessionDir, "session.json"));
    const messagesPath = path.join(sessionDir, "messages.jsonl");
    let messageCount: number | undefined;

    if (snapshot) {
      messageCount = snapshot.messages.length;
    } else {
      messageCount = await countMessages(messagesPath);
    }

    items.push({
      sessionId: meta.sessionId,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      provider: meta.provider,
      model: meta.model,
      ...(messageCount !== undefined ? { messageCount } : {}),
    });
  }

  items.sort((left, right) => right.updatedAt - left.updatedAt);
  return items;
};

const countMessages = async (messagesPath: string): Promise<number | undefined> => {
  const content = await readTextFile(messagesPath);
  if (content === null) {
    return 0;
  }

  let count = 0;
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.trim().length === 0) {
      continue;
    }
    try {
      const record = JSON.parse(line) as SessionRecord;
      if (record.type === "message" && record.v === 1) {
        count += 1;
      }
    } catch (error) {
      if (index === lines.length - 1) {
        break;
      }
      return undefined;
    }
  }

  return count;
};
const readTextFile = async (filePath: string): Promise<string | null> => {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  const content = await readTextFile(filePath);
  if (content === null) {
    return null;
  }
  return JSON.parse(content) as T;
};
