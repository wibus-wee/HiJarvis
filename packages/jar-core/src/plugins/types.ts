import type { AgentTool } from "@mariozechner/pi-agent-core";

import type { LoadedRuntimeConfig } from "../config.js";
import type { HookRegistry } from "../hooks/index.js";
import type { Logger } from "../logger.js";
import type { MemoryProviderFactory } from "../memory/index.js";
import type { SkillEntry } from "../skills.js";
import type { PromptSection } from "../prompt-builder.js";

// ── Service registry ─────────────────────────────────

/**
 * A simple in-process service registry for sharing instances between plugins.
 *
 * Plugins can register named services during `install()` and retrieve services
 * registered by other plugins (provided load order is respected).
 *
 * @example
 * ```ts
 * // Plugin A registers a Redis client
 * install({ services }) {
 *   services.register("redis", redisClient);
 *   return {};
 * }
 *
 * // Plugin B retrieves it
 * install({ services }) {
 *   const redis = services.get<Redis>("redis");
 *   return {};
 * }
 * ```
 */
export type ServiceRegistry = {
  /** Register a named service. Throws if the name is already taken. */
  register<T>(name: string, instance: T): void;
  /** Retrieve a service by name, or `undefined` if not registered. */
  get<T>(name: string): T | undefined;
  /** Check whether a service is registered. */
  has(name: string): boolean;
};

export const createServiceRegistry = (): ServiceRegistry => {
  const store = new Map<string, unknown>();
  return {
    register<T>(name: string, instance: T): void {
      if (store.has(name)) {
        throw new Error(`Service "${name}" is already registered`);
      }
      store.set(name, instance);
    },
    get<T>(name: string): T | undefined {
      return store.get(name) as T | undefined;
    },
    has(name: string): boolean {
      return store.has(name);
    },
  };
};

// ── Plugin context ───────────────────────────────────

/**
 * Context passed to a plugin's `install()` method.
 *
 * - `config` — the fully loaded runtime config (read-only reference)
 * - `hooks` — the shared hook registry; call `hooks.register()` here to attach handlers
 * - `services` — in-process service registry for sharing instances between plugins
 * - `logger` — optional logger for plugin diagnostics
 */
export type PluginInstallContext = {
  config: LoadedRuntimeConfig;
  hooks: HookRegistry;
  services: ServiceRegistry;
  logger?: Logger;
};

// ── Plugin result ────────────────────────────────────

/**
 * What a plugin may return from `install()`.
 *
 * All fields are optional — a plugin that only registers hooks can return `{}`.
 */
export type PluginInstallResult = {
  /**
   * Additional `SkillEntry` objects to inject into the skills catalog.
   *
   * These are merged with the file-system-scanned skills before the catalog
   * is rendered, so they appear in the agent's system prompt overlay.
   *
   * Useful for npm packages that embed their own `SKILL.md` content and want
   * to expose it without requiring the user to configure a `skillRoots` path.
   */
  skills?: SkillEntry[];

  /**
   * Additional prompt overlay sections to inject into the system prompt.
   *
   * This is intentionally low-level: it is a plain prompt section that is
   * appended at agent creation time (opt-in by the caller).
   */
  overlays?: PromptSection[];

  /**
   * Additional `AgentTool` objects to make available to the agent.
   *
   * These are merged with the default tools (file, bash, patch, web) and any
   * memory tools before the agent is created.
   */
  tools?: AgentTool[];

  /**
   * A `MemoryProviderFactory` that overrides the configured memory provider.
   *
   * When multiple plugins contribute a memory provider, the last one loaded
   * wins. Use this to replace the built-in `filesystem` provider with a
   * custom implementation (e.g. Redis, SQLite).
   *
   * The factory receives the same `{ providerName, providerConfig }` context
   * that the built-in resolution path uses, so it can read provider-specific
   * config from `jarvis.toml`.
   */
  memoryProvider?: MemoryProviderFactory;

  /**
   * Optional teardown function.
   *
   * Called when the plugin is unloaded (e.g. on process exit or config reload).
   * Use this to close connections, flush buffers, etc.
   */
  cleanup?: () => void | Promise<void>;
};

// ── v2: manager-facing diagnostics and contributions ─────────

export type PluginContribution = {
  skills: SkillEntry[];
  overlays: PromptSection[];
  tools: AgentTool[];
  memoryProvider?: MemoryProviderFactory;
};

export type PluginDiagnosticPhase =
  | "import"
  | "create"
  | "install"
  | "contribution_merge"
  | "shutdown";

export type PluginDiagnosticLevel = "info" | "warn" | "error";

export type PluginDiagnostic = {
  pluginName?: string;
  modulePath: string;
  phase: PluginDiagnosticPhase;
  level: PluginDiagnosticLevel;
  message: string;
};

export type PluginManagerFailureMode = "isolate" | "fail_fast";

export type PluginManagerOptions = {
  config: LoadedRuntimeConfig;
  hooks: HookRegistry;
  logger?: { info?: (msg: string, fields?: any) => void; warn?: (msg: string, fields?: any) => void; error?: (msg: string, fields?: any) => void };
  defaultFailureMode?: PluginManagerFailureMode;
  plugins?: Array<{ module: string; config: Record<string, unknown> }>;
  serviceRegistry?: ServiceRegistry;
};

export type PluginManager = {
  load(): Promise<void>;
  getContributions(): PluginContribution;
  getDiagnostics(): PluginDiagnostic[];
  getServiceRegistry(): ServiceRegistry;
  shutdown(): Promise<void>;
};

// ── Plugin interface ─────────────────────────────────

/**
 * The core plugin contract.
 *
 * A plugin is a plain object with a `name` and an `install()` method.
 * The install method receives the shared hook registry and may:
 *   - Register hook handlers via `context.hooks.register()`
 *   - Return additional `SkillEntry` objects to inject into the catalog
 *   - Return a `cleanup` function for teardown
 *
 * @example
 * ```ts
 * export const createPlugin = (): JarPlugin => ({
 *   name: "my-plugin",
 *   install({ hooks }) {
 *     hooks.register({
 *       point: "response:complete",
 *       name: "my-plugin:log",
 *       handler: ({ result }) => console.log(result.outputText),
 *     });
 *     return {};
 *   },
 * });
 * ```
 */
export interface JarPlugin {
  /** Unique identifier used in logs and error messages. */
  name: string;

  /**
   * Called once when the plugin is loaded.
   *
   * Hook registrations made here take effect for all subsequent pipeline
   * executions in the same process lifetime.
   */
  install(context: PluginInstallContext): PluginInstallResult | Promise<PluginInstallResult>;
}

// ── Plugin factory ───────────────────────────────────

/**
 * A function that creates a `JarPlugin` from a config object.
 *
 * This is the expected export shape for plugin modules:
 *
 * ```ts
 * // my-plugin.ts
 * export const createPlugin: PluginFactory = (cfg) => ({
 *   name: "my-plugin",
 *   install({ hooks }) { ... },
 * });
 * ```
 *
 * The `pluginConfig` argument is the `config` sub-table from the TOML entry,
 * or `{}` if the plugin was declared as a plain string.
 */
export type PluginFactory = (
  pluginConfig: Record<string, unknown>,
) => JarPlugin | Promise<JarPlugin>;
