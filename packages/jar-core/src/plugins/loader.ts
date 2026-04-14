import path from "node:path";
import { pathToFileURL } from "node:url";

import type { LoadedRuntimeConfig } from "../config.js";
import type { HookRegistry } from "../hooks/index.js";
import type { Logger } from "../logger.js";
import type {
  JarPlugin,
  LoadedPlugin,
  PluginFactory,
} from "./types.js";

type PluginModule = {
  createPlugin?: PluginFactory;
  default?: JarPlugin;
};

/**
 * Load and install all plugins declared in `config.plugins`.
 *
 * Each plugin module is dynamically imported, then its `install()` method is
 * called with the shared hook registry. Hook registrations made during install
 * take effect immediately for all subsequent pipeline executions.
 *
 * Failures are logged as warnings and never propagate — a broken plugin must
 * not crash the runtime.
 */
export const loadPlugins = async (
  config: LoadedRuntimeConfig,
  hooks: HookRegistry,
  logger?: Logger,
): Promise<LoadedPlugin[]> => {
  if (config.plugins.length === 0) {
    return [];
  }

  const loaded: LoadedPlugin[] = [];

  for (const entry of config.plugins) {
    const modulePath = entry.module;
    const pluginConfig = entry.config;

    let plugin: JarPlugin;
    try {
      plugin = await loadPluginFromModule(modulePath, pluginConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn("plugin.load_failed", { modulePath, message });
      continue;
    }

    let result: Awaited<ReturnType<JarPlugin["install"]>>;
    try {
      result = await plugin.install({ config, hooks });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn("plugin.install_failed", { pluginName: plugin.name, message });
      continue;
    }

    loaded.push({
      name: plugin.name,
      skills: result.skills ?? [],
      cleanup: result.cleanup,
    });

    logger?.info("plugin.loaded", { pluginName: plugin.name, skillCount: result.skills?.length ?? 0 });
  }

  return loaded;
};

const loadPluginFromModule = async (
  modulePath: string,
  pluginConfig: Record<string, unknown>,
): Promise<JarPlugin> => {
  const importTarget = path.isAbsolute(modulePath)
    ? pathToFileURL(modulePath).href
    : modulePath;

  let mod: PluginModule;
  try {
    mod = await import(importTarget) as PluginModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to import plugin module "${modulePath}": ${message}`);
  }

  // Prefer named export `createPlugin` (factory pattern)
  if (typeof mod.createPlugin === "function") {
    const plugin = await mod.createPlugin(pluginConfig);
    assertPlugin(plugin, modulePath);
    return plugin as JarPlugin;
  }

  // Fall back to default export (pre-instantiated plugin object)
  if (mod.default !== undefined && mod.default !== null) {
    assertPlugin(mod.default, modulePath);
    return mod.default as JarPlugin;
  }

  throw new Error(
    `Plugin module "${modulePath}" must export either createPlugin() or a default JarPlugin object`,
  );
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
