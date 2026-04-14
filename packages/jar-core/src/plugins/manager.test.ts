import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHookRegistry } from "../hooks/index.js";
import type { LoadedRuntimeConfig } from "../config.js";
import { createPluginManager } from "./manager.js";

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
    maxCatalogChars: 4096,
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
    enabled: false,
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

test("PluginManager.load is idempotent and shutdown runs cleanups once in reverse order", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jar-plugin-manager-"));
  const pluginAPath = path.join(tempDir, "plugin-a.ts");
  const pluginBPath = path.join(tempDir, "plugin-b.ts");

  try {
    await writeFile(pluginAPath, `
      globalThis.__pluginTestLog = globalThis.__pluginTestLog ?? [];
      globalThis.__pluginInstallCount = globalThis.__pluginInstallCount ?? 0;
      export const createPlugin = () => ({
        name: "plugin-a",
        install() {
          globalThis.__pluginInstallCount += 1;
          return {
            cleanup: () => { globalThis.__pluginTestLog.push("a"); },
          };
        },
      });
    `, "utf8");

    await writeFile(pluginBPath, `
      globalThis.__pluginTestLog = globalThis.__pluginTestLog ?? [];
      export default {
        name: "plugin-b",
        install() {
          return {
            cleanup: () => { globalThis.__pluginTestLog.push("b"); },
          };
        },
      };
    `, "utf8");

    const hooks = createHookRegistry();
    const manager = createPluginManager({
      config: createRuntimeConfig(),
      hooks,
      plugins: [
        { module: pluginAPath, config: {} },
        { module: pluginBPath, config: {} },
      ],
    });

    await manager.load();
    await manager.load();

    assert.equal((globalThis as any).__pluginInstallCount, 1);

    await manager.shutdown();
    await manager.shutdown();

    assert.deepEqual((globalThis as any).__pluginTestLog, ["b", "a"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    delete (globalThis as any).__pluginTestLog;
    delete (globalThis as any).__pluginInstallCount;
  }
});

test("PluginManager records a deterministic diagnostic for duplicate plugin names", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jar-plugin-manager-"));
  const pluginAPath = path.join(tempDir, "dup-a.ts");
  const pluginBPath = path.join(tempDir, "dup-b.ts");

  try {
    await writeFile(pluginAPath, `
      export const createPlugin = () => ({
        name: "dup",
        install() { return {}; },
      });
    `, "utf8");

    await writeFile(pluginBPath, `
      export const createPlugin = () => ({
        name: "dup",
        install() { return {}; },
      });
    `, "utf8");

    const hooks = createHookRegistry();
    const manager = createPluginManager({
      config: createRuntimeConfig(),
      hooks,
      plugins: [
        { module: pluginAPath, config: {} },
        { module: pluginBPath, config: {} },
      ],
    });

    await manager.load();
    const diagnostics = manager.getDiagnostics();
    assert.ok(diagnostics.some((d) => d.phase === "contribution_merge" && /Duplicate plugin name/.test(d.message)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("PluginManager isolates import failures by default and records diagnostics", async () => {
  const hooks = createHookRegistry();
  const manager = createPluginManager({
    config: createRuntimeConfig(),
    hooks,
    plugins: [
      { module: "/tmp/does-not-exist-plugin.ts", config: {} },
    ],
  });

  await manager.load();
  const diagnostics = manager.getDiagnostics();
  assert.ok(diagnostics.some((d) => d.phase === "import" && d.level === "error"));
});

