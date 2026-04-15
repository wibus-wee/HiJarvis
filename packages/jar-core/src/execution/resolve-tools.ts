import type { AgentTool } from "@mariozechner/pi-agent-core";

import type { LoadedRuntimeConfig } from "../config.js";
import type { MessageIngressCommand } from "../ingress.js";
import {
  type MemoryProvider,
  type MemoryProviderFactory,
  resolveConfiguredMemoryProvider,
} from "../memory/index.js";
import { createDefaultTools, createMemoryTools } from "../tools.js";

export const resolveEntityMemoryScope = (
  config: LoadedRuntimeConfig,
  command: MessageIngressCommand,
): string => {
  const identityId = command.routing.identityId;
  if (identityId !== undefined) {
    const identity = config.platformIdentities[identityId];
    if (identity !== undefined) {
      return identity.entityId;
    }
  }

  const firstEntity = Object.keys(config.entities)[0];
  return firstEntity ?? "default";
};

export const resolveMessageTools = async (
  config: LoadedRuntimeConfig,
  command: MessageIngressCommand,
  pluginExtensions?: {
    tools?: AgentTool[];
    memoryProvider?: MemoryProviderFactory;
  },
  dependencies: {
    createDefaultTools?: typeof createDefaultTools;
    createMemoryTools?: (entityId: string, provider: MemoryProvider) => AgentTool[];
    resolveMemoryProvider?: (config: LoadedRuntimeConfig) => Promise<MemoryProvider> | MemoryProvider;
  } = {},
): Promise<AgentTool[]> => {
  const defaultTools = (dependencies.createDefaultTools ?? createDefaultTools)(config.toolOptions);
  if (!config.memory.enabled) {
    return [...defaultTools, ...(pluginExtensions?.tools ?? [])];
  }

  const entityId = resolveEntityMemoryScope(config, command);

  // Plugin-contributed memory provider takes precedence over the built-in resolution path.
  let provider: MemoryProvider;
  if (pluginExtensions?.memoryProvider !== undefined) {
    provider = await pluginExtensions.memoryProvider({
      providerName: config.memory.provider,
      providerConfig: config.memory.providers[config.memory.provider] ?? {},
    });
  } else {
    provider = await (dependencies.resolveMemoryProvider ?? resolveConfiguredMemoryProvider)(config);
  }

  const memoryTools = (dependencies.createMemoryTools ?? createMemoryTools)(entityId, provider);
  return [...defaultTools, ...memoryTools, ...(pluginExtensions?.tools ?? [])];
};
