/**
 * memory-workspace plugin
 *
 * A minimal workspace memory plugin:
 * - resolves the current entity for each request
 * - reads `{dir}/{entityId}/MEMORY.md`
 * - prepends it to the current turn prompt
 *
 * The plugin intentionally does not add memory-specific tools. Persistent
 * memory editing should happen through the normal workspace/file tools instead
 * of a bespoke workflow wrapper.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolveEntityMemoryScope } from "../execution/resolve-tools.js";
import type { JarPlugin, PluginFactory } from "../plugins/types.js";

export const createPlugin: PluginFactory = (pluginConfig) => {
  const baseDir = (pluginConfig["dir"] as string | undefined) ?? ".jar/memory";

  const plugin: JarPlugin = {
    name: "memory-workspace",

    async install({ config, hooks }) {
      const configDir = path.dirname(config.configFilePath);
      const workspaceRoot = path.resolve(configDir, baseDir);

      hooks.register({
        point: "prompt:transform",
        name: "memory-workspace:prompt",
        handler: async ({ config: cfg, command, prompt, skillTriggerText }) => {
          const entityId = resolveEntityMemoryScope(cfg, command);
          const entityDir = path.join(workspaceRoot, entityId);
          const memoryMdPath = path.join(entityDir, "MEMORY.md");

          try {
            const content = await readFile(memoryMdPath, "utf8");
            const trimmed = content.trim();
            if (trimmed.length === 0) {
              return { prompt, skillTriggerText };
            }

            const injected = [
              "Memory & Knowledge:",
              trimmed,
              "",
              typeof prompt === "string" ? prompt : "",
            ]
              .filter((segment, index) => index < 3 || segment.length > 0)
              .join("\n\n");

            if (typeof prompt === "string") {
              return { prompt: injected, skillTriggerText };
            }

            if (Array.isArray(prompt)) {
              return {
                prompt: [{ role: "user", content: `Memory & Knowledge:\n${trimmed}`, timestamp: Date.now() }, ...prompt],
                skillTriggerText,
              };
            }

            return {
              prompt: [{ role: "user", content: `Memory & Knowledge:\n${trimmed}`, timestamp: Date.now() }, prompt],
              skillTriggerText,
            };
          } catch {
            return { prompt, skillTriggerText };
          }
        },
      });

      return {};
    },
  };

  return plugin;
};
