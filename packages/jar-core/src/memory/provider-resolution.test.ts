import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { LoadedRuntimeConfig } from "../config.js";
import { resolveConfiguredMemoryProvider } from "./provider-resolution.js";

const createConfig = (overrides: Partial<LoadedRuntimeConfig["memory"]> = {}): LoadedRuntimeConfig => ({
  configFilePath: "/tmp/jar.toml",
  logging: { level: "info", stderr: true },
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
  sessions: { rootDir: "/tmp/.jar/sessions", recordEvents: false },
  memory: {
    enabled: true,
    provider: "filesystem",
    providers: {
      filesystem: {
        rootDir: "/tmp/.jar/memory",
      },
    },
    ...overrides,
  },
  plugins: [],
  entities: {
    jarvis: { id: "jarvis", displayName: "Jarvis" },
  },
  platformIdentities: {},
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

test("resolveConfiguredMemoryProvider returns the built-in filesystem provider", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-memory-provider-"));

  try {
    const provider = await resolveConfiguredMemoryProvider(createConfig({
      providers: {
        filesystem: { rootDir },
      },
    }));

    const stored = await provider.store("jarvis", { content: "hello memory" });
    const result = await provider.search("jarvis", { text: "hello" });

    assert.equal(result.total, 1);
    assert.equal(result.entries[0]?.id, stored.id);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("resolveConfiguredMemoryProvider loads an external provider module", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jar-memory-plugin-"));
  const modulePath = path.join(tempDir, "memory-provider.ts");

  try {
    await writeFile(modulePath, `
      export const createMemoryProvider = async ({ providerName, providerConfig }) => ({
        async search(entityId, query) {
          return {
            total: 1,
            entries: [{
              id: providerName + '-' + entityId,
              content: String(providerConfig.label ?? query.text ?? 'none'),
              createdAt: 1,
              updatedAt: 1,
            }],
          };
        },
        async store(entityId, input) {
          return {
            id: 'stored-' + entityId,
            content: input.content,
            createdAt: 1,
            updatedAt: 1,
          };
        },
        async update(entityId, id, patch) {
          return {
            id,
            content: String(patch.content ?? entityId),
            createdAt: 1,
            updatedAt: 2,
          };
        },
        async delete() {},
      });
    `, "utf8");

    const provider = await resolveConfiguredMemoryProvider(createConfig({
      provider: "custom",
      providers: {
        custom: {
          module: modulePath,
          label: "external-provider",
        },
      },
    }));

    const result = await provider.search("jarvis", { text: "ignored" });
    assert.equal(result.total, 1);
    assert.equal(result.entries[0]?.id, "custom-jarvis");
    assert.equal(result.entries[0]?.content, "external-provider");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveConfiguredMemoryProvider rejects unknown providers without a module", async () => {
  await assert.rejects(
    () => resolveConfiguredMemoryProvider(createConfig({ provider: "missing", providers: {} })),
    /Unknown memory provider "missing"/,
  );
});

test("resolveConfiguredMemoryProvider rejects modules without createMemoryProvider", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jar-memory-plugin-"));
  const modulePath = path.join(tempDir, "invalid-provider.ts");

  try {
    await writeFile(modulePath, `export const nope = 1;`, "utf8");

    await assert.rejects(
      () => resolveConfiguredMemoryProvider(createConfig({
        provider: "invalid",
        providers: {
          invalid: { module: modulePath },
        },
      })),
      /must export createMemoryProvider\(\)/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
