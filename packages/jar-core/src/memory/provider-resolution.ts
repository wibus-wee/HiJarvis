import path from "node:path";
import { pathToFileURL } from "node:url";

import type { LoadedRuntimeConfig } from "../config.js";
import { FileSystemMemoryProvider } from "./fs-provider.js";
import type {
  CreateMemoryProviderContext,
  MemoryProvider,
  MemoryProviderFactory,
} from "./types.js";

type MemoryProviderModule = {
  createMemoryProvider?: MemoryProviderFactory;
};

const builtInMemoryProviderFactories: Record<string, MemoryProviderFactory> = {
  filesystem: ({ providerName, providerConfig }) => {
    const rootDir = providerConfig.rootDir;
    if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
      throw new Error(
        `Memory provider "${providerName}" requires a non-empty rootDir setting`,
      );
    }
    return new FileSystemMemoryProvider({ rootDir });
  },
};

export const resolveConfiguredMemoryProvider = async (
  config: LoadedRuntimeConfig,
): Promise<MemoryProvider> => {
  const providerName = config.memory.provider;
  const providerConfig = config.memory.providers[providerName];
  if (providerConfig === undefined) {
    throw new Error(
      `Unknown memory provider "${providerName}". Registered providers: ${Object.keys(config.memory.providers).join(", ") || "none"}`,
    );
  }

  const context: CreateMemoryProviderContext = {
    providerName,
    providerConfig,
  };

  const builtInFactory = builtInMemoryProviderFactories[providerName];
  if (builtInFactory !== undefined) {
    return assertMemoryProvider(await builtInFactory(context), providerName);
  }

  const modulePath = providerConfig.module;
  if (typeof modulePath !== "string" || modulePath.trim().length === 0) {
    throw new Error(
      `Unknown memory provider "${providerName}". Registered providers: ${Object.keys(builtInMemoryProviderFactories).join(", ")}`,
    );
  }

  const loadedModule = await loadMemoryProviderModule(providerName, modulePath);
  if (typeof loadedModule.createMemoryProvider !== "function") {
    throw new Error(
      `Memory provider module "${modulePath}" for provider "${providerName}" must export createMemoryProvider()`,
    );
  }

  return assertMemoryProvider(
    await loadedModule.createMemoryProvider(context),
    providerName,
  );
};

const loadMemoryProviderModule = async (
  providerName: string,
  modulePath: string,
): Promise<MemoryProviderModule> => {
  try {
    const importTarget = path.isAbsolute(modulePath)
      ? pathToFileURL(modulePath).href
      : modulePath;
    return await import(importTarget) as MemoryProviderModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load memory provider module "${modulePath}" for provider "${providerName}": ${message}`,
    );
  }
};

const assertMemoryProvider = (
  provider: unknown,
  providerName: string,
): MemoryProvider => {
  if (
    provider !== null &&
    typeof provider === "object" &&
    typeof (provider as MemoryProvider).search === "function" &&
    typeof (provider as MemoryProvider).store === "function" &&
    typeof (provider as MemoryProvider).update === "function" &&
    typeof (provider as MemoryProvider).delete === "function"
  ) {
    return provider as MemoryProvider;
  }

  throw new Error(
    `Memory provider "${providerName}" did not return a valid MemoryProvider instance`,
  );
};
