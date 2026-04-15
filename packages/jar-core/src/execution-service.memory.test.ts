import assert from "node:assert/strict";
import test from "node:test";

import type { AgentTool } from "@mariozechner/pi-agent-core";

import { resolveEntityMemoryScope, resolveMessageTools } from "./execution-service.js";
import type { LoadedMemoryConfig, LoadedRuntimeConfig } from "./config.js";
import type { MemoryProvider } from "./memory/index.js";
import type { MessageIngressCommand } from "./ingress.js";

const createConfig = (memory: Partial<LoadedMemoryConfig> = {}): LoadedRuntimeConfig => ({
  configFilePath: "/tmp/jar.toml",
  logging: {
    level: "info",
    stderr: true,
  },
  agent: {
    provider: "openai",
    model: "gpt-4o-mini",
    systemPrompt: "You are Jarvis",
    thinkingLevel: "minimal",
    providerConfig: {},
    execution: {
      requestTimeoutMs: 120_000,
      retryAttempts: 5,
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
  toolOptions: {
    provider: "openai",
    model: "gpt-4o-mini",
    workspaceRoot: "/tmp",
    maxFileBytes: 32_768,
    commandTimeoutMs: 30_000,
    maxCommandOutputBytes: 32_768,
    webRequestTimeoutMs: 30_000,
    maxWebResponseBytes: 65_536,
  },
  sessions: {
    rootDir: "/tmp/.jar/sessions",
  },
  memory: {
    enabled: true,
    provider: "filesystem",
    providers: {
      filesystem: {
        rootDir: "/tmp/.jar/memory",
      },
    },
    ...memory,
  },
  plugins: [],
  entities: {
    jarvis: {
      id: "jarvis",
      displayName: "Jarvis",
    },
    pm: {
      id: "pm",
      displayName: "PM",
    },
  },
  platformIdentities: {
    slack_main: {
      id: "slack_main",
      platform: "slack",
      entityId: "jarvis",
    },
  },
  platform: {},
  skills: {
    enabled: false,
    roots: [],
    maxScanDepth: 0,
    maxSkills: 0,
    maxCatalogChars: 0,
    maxBodyChars: 0,
    entries: [],
    catalog: null,
    errors: [],
    truncatedByLimit: false,
  },
});

const createCommand = (identityId?: string): MessageIngressCommand => ({
  kind: "message",
  source: {
    platform: identityId === undefined ? "cli" : "slack",
    identityId,
  },
  routing: {
    platform: identityId === undefined ? "cli" : "slack",
    identityId,
    scope: identityId === undefined
      ? { kind: "local_thread", threadId: "thread-1" }
      : { kind: "slack", channelId: "C123" },
  },
  message: {
    text: "hello",
  },
  prompt: "hello",
  audit: {
    trigger: "user_input",
  },
});

test("resolveEntityMemoryScope uses the routed platform identity entity", () => {
  const entityId = resolveEntityMemoryScope(createConfig(), createCommand("slack_main"));
  assert.equal(entityId, "jarvis");
});

test("resolveEntityMemoryScope falls back to the first configured entity for CLI turns", () => {
  const entityId = resolveEntityMemoryScope(createConfig(), createCommand());
  assert.equal(entityId, "jarvis");
});

test("resolveMessageTools adds memory tools only when memory is enabled", () => {
  const defaultTools = [{ name: "read_file" }] as AgentTool[];
  const memoryTools = [{ name: "memory_search" }] as AgentTool[];
  const provider = {} as MemoryProvider;

  const withMemory = resolveMessageTools(createConfig(), createCommand("slack_main"), undefined, {
    createDefaultTools: () => defaultTools,
    resolveMemoryProvider: async () => provider,
    createMemoryTools: (_entityId: string, _provider: MemoryProvider) => memoryTools,
  });
  return withMemory.then((resolvedTools) => {
    assert.deepEqual(resolvedTools.map((tool) => tool.name), ["read_file", "memory_search"]);
  });

});

test("resolveMessageTools skips provider resolution when memory is disabled", async () => {
  const defaultTools = [{ name: "read_file" }] as AgentTool[];
  let resolveCalled = false;

  const withoutMemory = await resolveMessageTools(createConfig({ enabled: false }), createCommand("slack_main"), undefined, {
    createDefaultTools: () => defaultTools,
    resolveMemoryProvider: async () => {
      resolveCalled = true;
      throw new Error("should not resolve provider");
    },
    createMemoryTools: (_entityId: string, _provider: MemoryProvider) => [],
  });
  assert.deepEqual(withoutMemory.map((tool) => tool.name), ["read_file"]);
  assert.equal(resolveCalled, false);
});
