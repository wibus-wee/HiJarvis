import type {
  JarPlugin,
  PluginFactory,
  PluginInstallContext,
  PluginInstallResult,
  Logger,
} from "@hijarvis/core";
import { createLogger } from "@hijarvis/core";
import { startTelegramIdentities, type StopFn } from "./runtime.js";

export const createPlugin: PluginFactory = (_pluginConfig) => {
  const plugin: JarPlugin = {
    name: "jar-gateway-telegram",
    async install({ config, hooks, services, logger }: PluginInstallContext): Promise<PluginInstallResult> {
      const effectiveLogger: Logger = logger ?? createLogger({ level: "info", stderr: true });
      const stops: StopFn[] = await startTelegramIdentities(config, hooks, services, effectiveLogger);
      return {
        cleanup: async () => {
          for (const stop of stops) {
            await stop();
          }
        },
      };
    },
  };
  return plugin;
};
