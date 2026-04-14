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
import { loadPlugins } from "../plugins/index.js";
import type { StoresContext } from "./types.js";

export const initStores = async (
  config: LoadedRuntimeConfig,
  command: MessageIngressCommand,
  logger?: Logger,
  hooks?: HookRegistry,
  pluginOverrides?: { skills?: SkillEntry[]; overlays?: PromptSection[] },
): Promise<StoresContext> => {
  const pluginSkills = pluginOverrides?.skills;
  const pluginOverlays = pluginOverrides?.overlays;

  // Load plugins early so they can register hooks before the pipeline continues.
  // If the caller provides explicit plugin overrides, skip config-driven plugin loading.
  const loadedPlugins = pluginOverrides === undefined && hooks
    ? await loadPlugins(config, hooks, logger)
    : [];
  const v1Skills = loadedPlugins.flatMap((plugin) => plugin.skills);
  const mergedSkills = [
    ...(pluginSkills ?? []),
    ...v1Skills,
  ];

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
    pluginSkills: mergedSkills.length > 0 ? mergedSkills : undefined,
    pluginOverlays: pluginOverlays && pluginOverlays.length > 0 ? pluginOverlays : undefined,
  };
};
