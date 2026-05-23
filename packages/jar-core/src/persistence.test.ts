import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";

import {
  createFileSystemConversationStateStore,
  createFileSystemEventLogStore,
} from "./persistence.js";
import type { LoadedRuntimeConfig } from "./config.js";

test("disabled event log store does not create events.jsonl", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-event-log-disabled-"));
  try {
    const stateStore = createFileSystemConversationStateStore();
    const session = await stateStore.load({
      platform: "cli",
      scope: {
        kind: "local_thread",
        threadId: "thread_disabled",
      },
    }, createRuntimeConfig(rootDir));
    const eventStore = createFileSystemEventLogStore({ recordEvents: false });

    await eventStore.appendEvent(session.threadId, createMessageUpdateEvent("hello"));

    const eventsPath = path.join(rootDir, "threads", "thread_disabled", "lanes", "main", "events.jsonl");
    await assert.rejects(() => stat(eventsPath), /ENOENT/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("enabled event log store writes events.jsonl", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-event-log-enabled-"));
  try {
    const stateStore = createFileSystemConversationStateStore();
    const session = await stateStore.load({
      platform: "cli",
      scope: {
        kind: "local_thread",
        threadId: "thread_enabled",
      },
    }, createRuntimeConfig(rootDir));
    const eventStore = createFileSystemEventLogStore({ recordEvents: true });

    await eventStore.appendEvent(session.threadId, createMessageUpdateEvent("hello"));

    const eventsPath = path.join(rootDir, "threads", "thread_enabled", "lanes", "main", "events.jsonl");
    const lines = (await readFile(eventsPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.ok(line);
    assert.equal(JSON.parse(line)?.event?.type, "message_update");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

const createMessageUpdateEvent = (
  delta: string,
): Extract<AgentEvent, { type: "message_update" }> => {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: delta }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4o-mini",
    usage: emptyUsage(),
    timestamp: Date.now(),
    stopReason: "stop",
  };

  return {
    type: "message_update",
    message,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta,
      partial: message,
    },
  };
};

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

const createRuntimeConfig = (rootDir: string): LoadedRuntimeConfig => ({
  configFilePath: path.join(rootDir, "jar.toml"),
  logging: { level: "info" as const, stderr: true },
  agent: {
    provider: "openai" as const,
    model: "gpt-4o-mini",
    systemPrompt: "You are Jarvis.",
    thinkingLevel: "minimal" as const,
    providerConfig: {},
    execution: {
      requestTimeoutMs: 120_000,
      retryAttempts: 0,
      retryInitialDelayMs: 1_000,
      retryBackoffMultiplier: 2,
      retryMaxDelayMs: 30_000,
    },
    compaction: {
      enabled: true,
      triggerRatio: 0.9,
      budgetRatio: 0.9,
      summaryMaxTokens: 1024,
    },
  },
  skills: {
    enabled: false,
    roots: [],
    entries: [],
    catalog: "",
    errors: [],
    truncatedByLimit: false,
    maxScanDepth: 0,
    maxSkills: 0,
    maxCatalogChars: 0,
    maxBodyChars: 0,
  },
  toolOptions: {
    provider: "openai" as const,
    model: "gpt-4o-mini",
    workspaceRoot: rootDir,
    maxFileBytes: 32_768,
    commandTimeoutMs: 30_000,
    maxCommandOutputBytes: 32_768,
    webRequestTimeoutMs: 30_000,
    maxWebResponseBytes: 65_536,
    maxConcurrentShells: 10,
  },
  sessions: { rootDir, recordEvents: false },
  memory: {
    enabled: true,
    provider: "filesystem" as const,
    providers: {
      filesystem: {
        rootDir: path.join(rootDir, ".jar", "memory"),
      },
    },
  },
  plugins: [],
  entities: {},
  platformIdentities: {},
  platform: {},
});
