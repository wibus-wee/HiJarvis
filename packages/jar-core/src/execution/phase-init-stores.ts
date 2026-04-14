import type { LoadedRuntimeConfig } from "../config.js";
import type { HookRegistry } from "../hooks/index.js";
import type { Logger } from "../logger.js";
import type { MessageIngressCommand } from "../ingress.js";
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
): Promise<StoresContext> => {
  // Load plugins early so they can register hooks before the pipeline continues
  const loadedPlugins = hooks ? await loadPlugins(config, hooks, logger) : [];
  const pluginSkills = loadedPlugins.flatMap((plugin) => plugin.skills);

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
    pluginSkills: pluginSkills.length > 0 ? pluginSkills : undefined,
  };
};
