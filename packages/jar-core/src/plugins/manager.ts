import path from "node:path";
import { access, readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import type { AgentTool } from "@mariozechner/pi-agent-core";

import type { LoadedRuntimeConfig } from "../config.js";
import type { HookRegistry } from "../hooks/index.js";
import type { MemoryProviderFactory } from "../memory/index.js";
import type { PromptSection } from "../prompt-builder.js";
import type {
  JarPlugin,
  PluginContribution,
  PluginDiagnostic,
  PluginManager,
  PluginManagerFailureMode,
  PluginManagerOptions,
  PluginFactory,
  ServiceRegistry,
} from "./types.js";
import { createServiceRegistry } from "./types.js";

type PluginModule = {
  createPlugin?: PluginFactory;
  default?: JarPlugin;
};

type InstalledPlugin = {
  name: string;
  modulePath: string;
  skillRoots: string[];
  overlays: PromptSection[];
  tools: AgentTool[];
  memoryProvider?: MemoryProviderFactory;
  cleanup?: () => void | Promise<void>;
};

export const createPluginManager = (options: PluginManagerOptions): PluginManager => {
  const config: LoadedRuntimeConfig = options.config;
  const hooks: HookRegistry = options.hooks;
  const logger = options.logger;
  const failureMode: PluginManagerFailureMode = options.defaultFailureMode ?? "isolate";
  const pluginEntries = options.plugins ?? config.plugins;
  const serviceRegistry: ServiceRegistry = options.serviceRegistry ?? createServiceRegistry();

  let loaded = false;
  let shutdown = false;

  const diagnostics: PluginDiagnostic[] = [];
  const installed: InstalledPlugin[] = [];
  const pluginNames = new Set<string>();

  const record = (diag: PluginDiagnostic): void => {
    diagnostics.push(diag);
    const eventName = `plugin.v2.${diag.phase}`;
    if (diag.level === "error") {
      logger?.error?.(eventName, diag);
    } else if (diag.level === "warn") {
      logger?.warn?.(eventName, diag);
    } else {
      logger?.info?.(eventName, diag);
    }
  };

  const isolate = async (fn: () => Promise<void>): Promise<void> => {
    if (failureMode === "fail_fast") {
      await fn();
      return;
    }
    try {
      await fn();
    } catch {
      // Diagnostics should already include the failure details.
    }
  };

  const manager: PluginManager = {
    async load(): Promise<void> {
      if (shutdown) {
        throw new Error("PluginManager.load() called after shutdown().");
      }
      if (loaded) {
        return;
      }
      loaded = true;

      for (const entry of pluginEntries) {
        const modulePath = entry.module;
        const pluginConfig = entry.config;

        await isolate(async () => {
          let plugin: JarPlugin;
          try {
            plugin = await loadPluginFromModule(modulePath, pluginConfig, config.configFilePath);
          } catch (error) {
            record({
              modulePath,
              phase: "import",
              level: "error",
              message: toErrorMessage(error, `Failed to import plugin module "${modulePath}"`),
            });
            throw error;
          }

          if (pluginNames.has(plugin.name)) {
            record({
              pluginName: plugin.name,
              modulePath,
              phase: "contribution_merge",
              level: "warn",
              message: `Duplicate plugin name "${plugin.name}" detected. Skipping module "${modulePath}".`,
            });
            return;
          }
          pluginNames.add(plugin.name);

          let result: Awaited<ReturnType<JarPlugin["install"]>>;
          try {
            result = await plugin.install({ config, hooks, services: serviceRegistry, logger: logger as any }); // logger type is a structural subset of Logger
          } catch (error) {
            record({
              pluginName: plugin.name,
              modulePath,
              phase: "install",
              level: "error",
              message: toErrorMessage(error, `Plugin "${plugin.name}" install() failed`),
            });
            throw error;
          }

          installed.push({
            name: plugin.name,
            modulePath,
            skillRoots: result.skillRoots ?? [],
            overlays: result.overlays ?? [],
            tools: result.tools ?? [],
            memoryProvider: result.memoryProvider,
            cleanup: result.cleanup,
          });

          record({
            pluginName: plugin.name,
            modulePath,
            phase: "install",
            level: "info",
            message: `Plugin "${plugin.name}" installed.`,
          });
        });
      }
    },

    getContributions(): PluginContribution {
      const skillRoots: string[] = [];
      const overlays: PromptSection[] = [];
      const tools: AgentTool[] = [];
      let memoryProvider: MemoryProviderFactory | undefined;

      for (const plugin of installed) {
        skillRoots.push(...plugin.skillRoots);
        overlays.push(...plugin.overlays);
        tools.push(...plugin.tools);
        if (plugin.memoryProvider !== undefined) {
          memoryProvider = plugin.memoryProvider; // last-wins
        }
      }

      return { skillRoots, overlays, tools, memoryProvider };
    },

    getDiagnostics(): PluginDiagnostic[] {
      return diagnostics.slice();
    },

    getServiceRegistry(): ServiceRegistry {
      return serviceRegistry;
    },

    async shutdown(): Promise<void> {
      if (shutdown) {
        return;
      }
      shutdown = true;

      for (let index = installed.length - 1; index >= 0; index -= 1) {
        const plugin = installed[index];
        if (!plugin?.cleanup) {
          continue;
        }

        await isolate(async () => {
          try {
            await plugin.cleanup?.();
          } catch (error) {
            record({
              pluginName: plugin.name,
              modulePath: plugin.modulePath,
              phase: "shutdown",
              level: "error",
              message: toErrorMessage(error, `Plugin "${plugin.name}" cleanup() failed`),
            });
            throw error;
          }

          record({
            pluginName: plugin.name,
            modulePath: plugin.modulePath,
            phase: "shutdown",
            level: "info",
            message: `Plugin "${plugin.name}" cleanup() completed.`,
          });
        });
      }
    },
  };

  return manager;
};

const loadPluginFromModule = async (
  modulePath: string,
  pluginConfig: Record<string, unknown>,
  configFilePath: string,
): Promise<JarPlugin> => {
  const importTarget = await resolvePluginImportTarget(modulePath, configFilePath);

  let mod: PluginModule;
  try {
    mod = await import(importTarget) as PluginModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to import plugin module "${modulePath}": ${message}`);
  }

  if (typeof mod.createPlugin === "function") {
    let plugin: unknown;
    try {
      plugin = await mod.createPlugin(pluginConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Plugin factory createPlugin() in "${modulePath}" failed: ${message}`);
    }
    assertPlugin(plugin, modulePath);
    return plugin as JarPlugin;
  }

  if (mod.default !== undefined && mod.default !== null) {
    assertPlugin(mod.default, modulePath);
    return mod.default as JarPlugin;
  }

  throw new Error(
    `Plugin module "${modulePath}" must export either createPlugin() or a default JarPlugin object`,
  );
};

const resolvePluginImportTarget = async (
  modulePath: string,
  configFilePath: string,
): Promise<string> => {
  if (path.isAbsolute(modulePath)) {
    return pathToFileURL(modulePath).href;
  }

  try {
    await import(modulePath);
    return modulePath;
  } catch (error) {
    const workspaceModulePath = await resolveWorkspacePluginModule(modulePath, configFilePath);
    if (workspaceModulePath !== null) {
      return pathToFileURL(workspaceModulePath).href;
    }
    throw error;
  }
};

const resolveWorkspacePluginModule = async (
  packageName: string,
  configFilePath: string,
): Promise<string | null> => {
  if (packageName.startsWith(".") || packageName.startsWith("/") || packageName.includes(":")) {
    return null;
  }

  const workspaceRoot = await findWorkspaceRoot(path.dirname(configFilePath));
  if (workspaceRoot === null) {
    return null;
  }

  for (const workspaceDirectory of ["packages", "apps", "3rd"]) {
    const manifestPath = await findWorkspacePackageManifest(
      path.join(workspaceRoot, workspaceDirectory),
      packageName,
    );
    if (manifestPath === null) {
      continue;
    }

    const entryPath = await resolvePluginEntryFromManifest(manifestPath);
    if (entryPath !== null) {
      return entryPath;
    }
  }

  return null;
};

const findWorkspaceRoot = async (startDirectory: string): Promise<string | null> => {
  let currentDirectory = path.resolve(startDirectory);

  while (true) {
    try {
      await access(path.join(currentDirectory, "pnpm-workspace.yaml"));
      return currentDirectory;
    } catch {
      // Keep walking upward.
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return null;
    }
    currentDirectory = parentDirectory;
  }
};

const findWorkspacePackageManifest = async (
  baseDirectory: string,
  packageName: string,
): Promise<string | null> => {
  try {
    const entries = await readdir(baseDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const manifestPath = path.join(baseDirectory, entry.name, "package.json");
      const manifest = await readPackageManifest(manifestPath);
      if (manifest?.name === packageName) {
        return manifestPath;
      }
    }
  } catch {
    return null;
  }

  return null;
};

const resolvePluginEntryFromManifest = async (manifestPath: string): Promise<string | null> => {
  const manifest = await readPackageManifest(manifestPath);
  if (manifest === null) {
    return null;
  }

  const packageDirectory = path.dirname(manifestPath);
  const exportRoot = typeof manifest.exports === "object" && manifest.exports !== null
    ? manifest.exports["."]
    : undefined;
  const candidates = [
    typeof manifest.exports === "string" ? manifest.exports : undefined,
    typeof exportRoot === "string" ? exportRoot : undefined,
    typeof manifest.main === "string" ? manifest.main : undefined,
    "./src/plugin.ts",
    "./src/index.ts",
    "./dist/plugin.js",
    "./dist/index.js",
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of candidates) {
    const resolvedPath = path.resolve(packageDirectory, candidate);
    try {
      await access(resolvedPath);
      return resolvedPath;
    } catch {
      // Try next candidate.
    }
  }

  return null;
};

const readPackageManifest = async (
  manifestPath: string,
): Promise<{ name?: string; main?: string; exports?: string | Record<string, unknown> } | null> => {
  try {
    const content = await readFile(manifestPath, "utf8");
    return JSON.parse(content) as { name?: string; main?: string; exports?: string | Record<string, unknown> };
  } catch {
    return null;
  }
};

const assertPlugin = (value: unknown, modulePath: string): void => {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as JarPlugin).name === "string" &&
    (value as JarPlugin).name.trim().length > 0 &&
    typeof (value as JarPlugin).install === "function"
  ) {
    return;
  }

  throw new Error(
    `Plugin module "${modulePath}" did not return a valid JarPlugin (requires non-empty name and install function)`,
  );
};

const toErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error) {
    return `${fallback}: ${error.message}`;
  }
  return `${fallback}: ${String(error)}`;
};

// PluginManager intentionally does not render a skills catalog overlay.
// Skills discovery is unified in the core pipeline so config roots and plugin
// roots share a single catalog/render/injection implementation.
