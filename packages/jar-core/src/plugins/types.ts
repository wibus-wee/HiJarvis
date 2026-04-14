import type { LoadedRuntimeConfig } from "../config.js";
import type { HookRegistry } from "../hooks/index.js";
import type { SkillEntry } from "../skills.js";

// ── Plugin context ───────────────────────────────────

/**
 * Context passed to a plugin's `install()` method.
 *
 * - `config` — the fully loaded runtime config (read-only reference)
 * - `hooks` — the shared hook registry; call `hooks.register()` here to attach handlers
 */
export type PluginInstallContext = {
  config: LoadedRuntimeConfig;
  hooks: HookRegistry;
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
   * Optional teardown function.
   *
   * Called when the plugin is unloaded (e.g. on process exit or config reload).
   * Use this to close connections, flush buffers, etc.
   */
  cleanup?: () => void | Promise<void>;
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

// ── Loaded plugin ────────────────────────────────────

/**
 * Internal record of a successfully loaded and installed plugin.
 */
export type LoadedPlugin = {
  /** Plugin name, as returned by `JarPlugin.name`. */
  name: string;
  /** Skills contributed by this plugin (may be empty). */
  skills: SkillEntry[];
  /** Optional cleanup function to call on teardown. */
  cleanup?: () => void | Promise<void>;
};
