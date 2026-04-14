import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "@mariozechner/pi-ai";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";

import type { LoadedRuntimeConfig } from "../config.js";

import {
  executeSideQuestion,
  normalizeSideQuestionPromptToMessages,
} from "./execute-side-question.js";
import {
  _resetLiveThreadRegistryForTest,
  captureLiveThreadForSideQuestion,
  registerLiveThreadForSideQuestion,
  unregisterLiveThreadForSideQuestion,
  updateLiveThreadCaptureForSideQuestion,
} from "./live-thread-registry.js";

const createUserMessage = (content: string): AgentMessage => ({
  role: "user",
  content,
  timestamp: Date.now(),
});

test.beforeEach(() => {
  _resetLiveThreadRegistryForTest();
});

test.afterEach(() => {
  _resetLiveThreadRegistryForTest();
});

test("executeSideQuestion captures parent state once and appends the question only to the ephemeral prompt", async () => {
  registerLiveThreadForSideQuestion({
    threadId: "thread_live_parent",
    laneId: "main",
  });
  updateLiveThreadCaptureForSideQuestion("thread_live_parent", {
    threadId: "thread_live_parent",
    laneId: "main",
    capturedAt: 1,
    messages: [structuredClone(createUserMessage("parent state v1"))],
  });

  const before = captureLiveThreadForSideQuestion("thread_live_parent");
  assert.deepEqual(
    before?.messages.map((message) => message.role === "user" ? message.content : message.role),
    ["parent state v1"],
  );

  await assert.rejects(
    executeSideQuestion({
      config: createRuntimeConfig(),
      parentThreadId: "thread_live_parent",
      question: "What are you doing?",
    }),
    /No API key for provider: openai/i,
  );

  updateLiveThreadCaptureForSideQuestion("thread_live_parent", {
    threadId: "thread_live_parent",
    laneId: "main",
    capturedAt: 2,
    messages: [structuredClone(createUserMessage("parent state v2"))],
  });

  const after = captureLiveThreadForSideQuestion("thread_live_parent");
  assert.deepEqual(
    after?.messages.map((message) => message.role === "user" ? message.content : message.role),
    ["parent state v2"],
  );

  unregisterLiveThreadForSideQuestion("thread_live_parent");
});

test("normalizeSideQuestionPromptToMessages returns a single user turn for plain text questions", () => {
  const messages = normalizeSideQuestionPromptToMessages("What changed?");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[0]?.content, "What changed?");
});

test("executeSideQuestion fails clearly when the parent thread is not live", async () => {
  await assert.rejects(
    executeSideQuestion({
      config: createRuntimeConfig(),
      parentThreadId: "missing-thread",
      question: "What are you doing?",
    }),
    /No live parent thread available for missing-thread/,
  );
});

test("executeSideQuestion accepts opt-in tools", async () => {
  registerLiveThreadForSideQuestion({
    threadId: "thread_with_tools",
    laneId: "main",
  });
  updateLiveThreadCaptureForSideQuestion("thread_with_tools", {
    threadId: "thread_with_tools",
    laneId: "main",
    capturedAt: 1,
    messages: [structuredClone(createUserMessage("parent state"))],
  });

  const tools = [{
    name: "readonly_probe",
    label: "Readonly Probe",
    description: "Read-only probe",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => ({
      content: [{ type: "text", text: "ok" }],
      details: { ok: true },
    }),
  }] satisfies AgentTool[];

  await assert.rejects(
    executeSideQuestion({
      config: createRuntimeConfig(),
      parentThreadId: "thread_with_tools",
      question: "Use the tool if needed",
      tools,
    }),
    /No API key for provider: openai/i,
  );
});

const createRuntimeConfig = (): LoadedRuntimeConfig => ({
  configFilePath: "/tmp/jar.toml",
  logging: { level: "info", stderr: true },
  agent: {
    provider: "openai",
    model: "gpt-4o-mini",
    systemPrompt: "You are Jarvis.",
    thinkingLevel: "minimal",
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
    systemPromptOverlays: [],
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
    provider: "openai",
    model: "gpt-4o-mini",
    workspaceRoot: "/tmp",
    maxFileBytes: 32768,
    commandTimeoutMs: 30000,
    maxCommandOutputBytes: 32768,
    webRequestTimeoutMs: 30000,
    maxWebResponseBytes: 65536,
  },
  sessions: { rootDir: "/tmp" },
  memory: {
    enabled: true,
    provider: "filesystem",
    providers: {
      filesystem: {
        rootDir: "/tmp/.jar/memory",
      },
    },
  },
  plugins: [],
  entities: {
    jarvis: {
      id: "jarvis",
      displayName: "Jarvis",
    },
  },
  platformIdentities: {},
  platform: {},
});
