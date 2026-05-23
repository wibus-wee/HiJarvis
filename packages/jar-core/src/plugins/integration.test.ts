import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { LoadedRuntimeConfig } from "../config.js";
import type { MessageIngressCommand } from "../ingress.js";
import { createHookRegistry } from "../hooks/index.js";
import { executeIngressCommand } from "../execution-service.js";

const createRuntimeConfig = (rootDir: string): LoadedRuntimeConfig => ({
  configFilePath: path.join(rootDir, "jar.toml"),
  logging: { level: "info", stderr: true },
  agent: {
    provider: "openai",
    model: "gpt-4o-mini",
    systemPrompt: "You are Jarvis.",
    thinkingLevel: "minimal",
    providerConfig: {}, // intentionally missing apiKey to avoid real execution
    execution: {
      requestTimeoutMs: 10_000,
      retryAttempts: 0,
      retryInitialDelayMs: 1_000,
      retryBackoffMultiplier: 2,
      retryMaxDelayMs: 1_000,
    },
    compaction: {
      enabled: false,
      triggerRatio: 0.9,
      budgetRatio: 0.9,
      summaryMaxTokens: 256,
    },
    systemPromptOverlays: [],
  },
  skills: {
    enabled: true,
    roots: [],
    entries: [],
    catalog: "",
    errors: [],
    truncatedByLimit: false,
    maxScanDepth: 6,
    maxSkills: 2000,
    maxCatalogChars: 4096,
    maxBodyChars: 4096,
  },
  toolOptions: {
    provider: "openai",
    model: "gpt-4o-mini",
    workspaceRoot: rootDir,
    maxFileBytes: 32768,
    commandTimeoutMs: 30000,
    maxCommandOutputBytes: 32768,
    webRequestTimeoutMs: 30000,
    maxWebResponseBytes: 65536,
  },
  sessions: { rootDir, recordEvents: false },
  memory: {
    enabled: false,
    provider: "filesystem",
    providers: {
      filesystem: {
        rootDir: path.join(rootDir, ".jar", "memory"),
      },
    },
  },
  plugins: [], // plugins are loaded via createPluginManager, not config.plugins
  entities: {
    jarvis: {
      id: "jarvis",
      displayName: "Jarvis",
    },
  },
  platformIdentities: {},
  platform: {},
});

const createCommand = (threadId: string, text: string): MessageIngressCommand => ({
  kind: "message",
  source: { platform: "cli" },
  routing: {
    platform: "cli",
    scope: {
      kind: "local_thread",
      threadId,
    },
  },
  message: { text },
  prompt: text,
  skillTriggerText: text,
  audit: { trigger: "user_input" },
});

test("Plugin skills and hooks are wired into execution when hooks registry is passed directly", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-plugin-integration-"));
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jar-plugin-module-"));
  const skillRoot = path.join(tempDir, "skills");
  const skillDir = path.join(skillRoot, "demo-skill");
  const skillPath = path.join(skillDir, "SKILL.md");
  const pluginPath = path.join(tempDir, "plugin.ts");

  try {
    await mkdir(skillDir, { recursive: true });
    await writeFile(skillPath, `
---
name: demo-skill
description: Demo skill for plugin integration test.
---

# Demo

Use this skill when asked.
    `.trim() + "\n", "utf8");

    await writeFile(pluginPath, `
      globalThis.__pluginPreparedMarker = false;

      export const createPlugin = () => ({
        name: "integration-plugin",
        install({ hooks }) {
          hooks.register({
            point: "prompt:prepared",
            name: "integration-plugin:prepared",
            handler: ({ prepared }) => {
              if (prepared.injectedSkills.includes("demo-skill")) {
                globalThis.__pluginPreparedMarker = true;
              }
            },
          });

          return {
            skillRoots: [${JSON.stringify(skillRoot)}],
          };
        },
      });
    `, "utf8");

    // Build a config that references the plugin module so createPluginManager picks it up.
    const config: LoadedRuntimeConfig = {
      ...createRuntimeConfig(rootDir),
      plugins: [{ module: pluginPath, config: {} }],
    };
    const hooks = createHookRegistry();

    // Pass hooks directly — initStores will call createPluginManager internally.
    // No manual pluginOverrides needed.
    await assert.rejects(
      () => executeIngressCommand({
        config,
        command: createCommand("thread_integration_v2", "please use $demo-skill"),
        hooks,
      }),
      /No API key for provider: openai/i,
    );

    assert.equal((globalThis as any).__pluginPreparedMarker, true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(tempDir, { recursive: true, force: true });
    delete (globalThis as any).__pluginPreparedMarker;
  }
});
