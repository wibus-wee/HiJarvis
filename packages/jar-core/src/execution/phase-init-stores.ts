import type { AgentTool } from "@mariozechner/pi-agent-core";
import os from "node:os";
import path from "node:path";

import type { LoadedRuntimeConfig } from "../config.js";
import type { HookRegistry } from "../hooks/index.js";
import type { Logger } from "../logger.js";
import type { MessageIngressCommand } from "../ingress.js";
import type { PromptSection } from "../prompt-builder.js";
import type { SkillEntry, SkillsRuntime } from "../skills.js";
import { loadSkillsFromRoots, renderSkillsCatalog } from "../skills.js";
import {
  createFileSystemConversationStateStore,
  createFileSystemEventLogStore,
  createFileSystemExecutionAuditStore,
  createFileSystemUsageStore,
} from "../persistence.js";
import { createPluginManager } from "../plugins/index.js";
import type { StoresContext } from "./types.js";

export const initStores = async (
  config: LoadedRuntimeConfig,
  command: MessageIngressCommand,
  logger?: Logger,
  hooks?: HookRegistry,
  pluginOverrides?: {
    skillRoots?: string[];
    overlays?: PromptSection[];
    tools?: AgentTool[];
    memoryProvider?: StoresContext["pluginMemoryProvider"];
  },
): Promise<StoresContext> => {
  let pluginSkillRoots: string[] | undefined;
  let pluginOverlays: PromptSection[] | undefined;
  let pluginTools: AgentTool[] | undefined;
  let pluginMemoryProvider: StoresContext["pluginMemoryProvider"];

  if (pluginOverrides !== undefined) {
    // Caller provided explicit overrides — use them directly, skip config-driven loading.
    pluginSkillRoots = pluginOverrides.skillRoots && pluginOverrides.skillRoots.length > 0
      ? pluginOverrides.skillRoots
      : undefined;
    pluginOverlays = pluginOverrides.overlays && pluginOverrides.overlays.length > 0
      ? pluginOverrides.overlays
      : undefined;
    pluginTools = pluginOverrides.tools && pluginOverrides.tools.length > 0
      ? pluginOverrides.tools
      : undefined;
    pluginMemoryProvider = pluginOverrides.memoryProvider;
  } else if (hooks) {
    // Load plugins from config and collect all contributions.
    const manager = createPluginManager({ config, hooks, logger });
    await manager.load();
    const contributions = manager.getContributions();

    pluginSkillRoots = contributions.skillRoots.length > 0 ? contributions.skillRoots : undefined;
    pluginOverlays = contributions.overlays.length > 0 ? contributions.overlays : undefined;
    pluginTools = contributions.tools.length > 0 ? contributions.tools : undefined;
    pluginMemoryProvider = contributions.memoryProvider;
  }

  const skills = await resolveExecutionSkillsRuntime(config.skills, pluginSkillRoots, config.configFilePath);

  return {
    config,
    skills,
    command,
    logger,
    hooks,
    stateStore: createFileSystemConversationStateStore(),
    auditStore: createFileSystemExecutionAuditStore(),
    eventStore: createFileSystemEventLogStore(),
    usageStore: createFileSystemUsageStore(config.sessions.rootDir),
    startTime: Date.now(),
    pluginOverlays,
    pluginTools,
    pluginMemoryProvider,
  };
};

const resolveExecutionSkillsRuntime = async (
  base: SkillsRuntime,
  pluginSkillRoots: string[] | undefined,
  configFilePath: string,
): Promise<SkillsRuntime> => {
  if (!base.enabled) {
    return base;
  }

  if (!pluginSkillRoots || pluginSkillRoots.length === 0) {
    return base;
  }

  const configDirectory = path.dirname(configFilePath);
  const resolvedPluginRoots = pluginSkillRoots.map((root) => resolveSkillRootPath(root, configDirectory));
  const mergedRoots = mergeRootPaths([...base.roots, ...resolvedPluginRoots]);

  const remainingSkills = Math.max(0, base.maxSkills - base.entries.length);
  const pluginLoad = remainingSkills === 0
    ? { entries: [] satisfies SkillEntry[], errors: [], truncatedByLimit: true }
    : await loadSkillsFromRoots({
        roots: resolvedPluginRoots,
        maxScanDepth: base.maxScanDepth,
        maxSkills: remainingSkills,
      });

  const mergedEntries = mergeSkillEntries(base.entries, pluginLoad.entries);
  const entries = mergedEntries
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  const catalog = renderSkillsCatalog(entries, base.maxCatalogChars);

  return {
    ...base,
    roots: mergedRoots,
    entries,
    catalog,
    errors: [...base.errors, ...pluginLoad.errors],
    truncatedByLimit: base.truncatedByLimit || pluginLoad.truncatedByLimit,
  };
};

const resolveSkillRootPath = (root: string, configDirectory: string): string => {
  if (root === "~") {
    return os.homedir();
  }
  if (root.startsWith("~/")) {
    return path.resolve(os.homedir(), root.slice(2));
  }
  if (path.isAbsolute(root)) {
    return root;
  }
  return path.resolve(configDirectory, root);
};

const mergeRootPaths = (roots: string[]): string[] => {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const resolved = path.resolve(root);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    merged.push(root);
  }
  return merged;
};

const mergeSkillEntries = (base: SkillEntry[], extras: SkillEntry[]): SkillEntry[] => {
  const merged = base.slice();
  const seen = new Set<string>(base.map((entry) => path.resolve(entry.path)));
  for (const entry of extras) {
    const key = path.resolve(entry.path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(entry);
  }
  return merged;
};
