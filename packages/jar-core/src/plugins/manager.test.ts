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
  sessions: { rootDir: "/tmp", recordEvents: false },
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

test("PluginManager resolves workspace package plugin modules by package name", async () => {
  const hooks = createHookRegistry();
  const manager = createPluginManager({
    config: {
      ...createRuntimeConfig(),
      configFilePath: path.resolve(process.cwd(), "../../jar.toml"),
    },
    hooks,
    plugins: [
      { module: "@hijarvis/jar-plugin-slack", config: {} },
    ],
  });

  await manager.load();
  const diagnostics = manager.getDiagnostics();
  assert.ok(
    diagnostics.some(
      (d) => d.phase === "install"
        && d.pluginName === "jar-gateway-slack"
        && d.modulePath === "@hijarvis/jar-plugin-slack",
    ),
  );
});

test("PluginManager collects tools contributed by plugins", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jar-plugin-tools-"));
  const pluginPath = path.join(tempDir, "tools-plugin.ts");

  try {
    await writeFile(pluginPath, `
      export const createPlugin = () => ({
        name: "tools-plugin",
        install() {
          return {
            tools: [
              {
                name: "my_tool",
                description: "A test tool",
                parameters: { type: "object", properties: {}, required: [] },
                execute: async () => "result",
              },
            ],
          };
        },
      });
    `, "utf8");

    const hooks = createHookRegistry();
    const manager = createPluginManager({
      config: createRuntimeConfig(),
      hooks,
      plugins: [{ module: pluginPath, config: {} }],
    });

    await manager.load();
    const contributions = manager.getContributions();
    assert.equal(contributions.tools.length, 1);
    assert.equal(contributions.tools[0]?.name, "my_tool");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("PluginManager uses last-wins for memoryProvider contributions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jar-plugin-memory-"));
  const pluginAPath = path.join(tempDir, "memory-a.ts");
  const pluginBPath = path.join(tempDir, "memory-b.ts");

  try {
    await writeFile(pluginAPath, `
      export const createPlugin = () => ({
        name: "memory-a",
        install() {
          return {
            memoryProvider: () => ({ tag: "provider-a", search: async () => ({ entries: [], total: 0 }), store: async () => ({}), update: async () => ({}), delete: async () => {} }),
          };
        },
      });
    `, "utf8");

    await writeFile(pluginBPath, `
      export const createPlugin = () => ({
        name: "memory-b",
        install() {
          return {
            memoryProvider: () => ({ tag: "provider-b", search: async () => ({ entries: [], total: 0 }), store: async () => ({}), update: async () => ({}), delete: async () => {} }),
          };
        },
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
    const contributions = manager.getContributions();
    assert.ok(contributions.memoryProvider !== undefined, "memoryProvider should be set");
    // last-wins: provider-b should be the active one
    const provider = await contributions.memoryProvider!({ providerName: "test", providerConfig: {} });
    assert.equal((provider as any).tag, "provider-b");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ServiceRegistry throws when registering a duplicate service name", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jar-plugin-service-"));
  const pluginAPath = path.join(tempDir, "service-a.ts");
  const pluginBPath = path.join(tempDir, "service-b.ts");

  try {
    await writeFile(pluginAPath, `
      export const createPlugin = () => ({
        name: "service-a",
        install({ services }) {
          services.register("shared-db", { connection: "a" });
          return {};
        },
      });
    `, "utf8");

    await writeFile(pluginBPath, `
      export const createPlugin = () => ({
        name: "service-b",
        install({ services }) {
          services.register("shared-db", { connection: "b" });
          return {};
        },
      });
    `, "utf8");

    const hooks = createHookRegistry();
    const manager = createPluginManager({
      config: createRuntimeConfig(),
      hooks,
      defaultFailureMode: "fail_fast",
      plugins: [
        { module: pluginAPath, config: {} },
        { module: pluginBPath, config: {} },
      ],
    });

    await assert.rejects(
      () => manager.load(),
      /Service "shared-db" is already registered/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ServiceRegistry allows plugins to share instances across install() calls", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jar-plugin-service-share-"));
  const pluginAPath = path.join(tempDir, "provider.ts");
  const pluginBPath = path.join(tempDir, "consumer.ts");

  try {
    await writeFile(pluginAPath, `
      globalThis.__serviceConsumerSaw = undefined;
      export const createPlugin = () => ({
        name: "provider",
        install({ services }) {
          services.register("my-client", { value: 42 });
          return {};
        },
      });
    `, "utf8");

    await writeFile(pluginBPath, `
      export const createPlugin = () => ({
        name: "consumer",
        install({ services }) {
          const client = services.get("my-client");
          globalThis.__serviceConsumerSaw = client?.value;
          return {};
        },
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
    assert.equal((globalThis as any).__serviceConsumerSaw, 42);

    const registry = manager.getServiceRegistry();
    assert.equal(registry.get<{ value: number }>("my-client")?.value, 42);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    delete (globalThis as any).__serviceConsumerSaw;
  }
});
