import type { AgentTool } from "@mariozechner/pi-agent-core";

import type { LoadedRuntimeConfig } from "../config.js";
import type { HookRegistry } from "../hooks/index.js";
import type { Logger } from "../logger.js";
import type { MessageIngressCommand } from "../ingress.js";
import type { PromptSection } from "../prompt-builder.js";
import type { SkillEntry } from "../skills.js";
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
  pluginOverrides?: { skills?: SkillEntry[]; overlays?: PromptSection[]; tools?: AgentTool[] },
): Promise<StoresContext> => {
  let pluginSkills: SkillEntry[] | undefined;
  let pluginOverlays: PromptSection[] | undefined;
  let pluginTools: AgentTool[] | undefined;
  let pluginMemoryProvider: StoresContext["pluginMemoryProvider"];

  if (pluginOverrides !== undefined) {
    // Caller provided explicit overrides — use them directly, skip config-driven loading.
    pluginSkills = pluginOverrides.skills && pluginOverrides.skills.length > 0
      ? pluginOverrides.skills
      : undefined;
    pluginOverlays = pluginOverrides.overlays && pluginOverrides.overlays.length > 0
      ? pluginOverrides.overlays
      : undefined;
    pluginTools = pluginOverrides.tools && pluginOverrides.tools.length > 0
      ? pluginOverrides.tools
      : undefined;
  } else if (hooks) {
    // Load plugins from config and collect all contributions.
    const manager = createPluginManager({ config, hooks, logger });
    await manager.load();
    const contributions = manager.getContributions();

    pluginSkills = contributions.skills.length > 0 ? contributions.skills : undefined;
    pluginOverlays = contributions.overlays.length > 0 ? contributions.overlays : undefined;
    pluginTools = contributions.tools.length > 0 ? contributions.tools : undefined;
    pluginMemoryProvider = contributions.memoryProvider;
  }

  return {
    config,
    command,
    logger,
    hooks,
    stateStore: createFileSystemConversationStateStore(),
    auditStore: createFileSystemExecutionAuditStore(),
    eventStore: createFileSystemEventLogStore(),
    usageStore: createFileSystemUsageStore(config.sessions.rootDir),
    startTime: Date.now(),
    pluginSkills,
    pluginOverlays,
    pluginTools,
    pluginMemoryProvider,
  };
};
