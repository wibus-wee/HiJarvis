import type {
  JarPlugin,
  PluginFactory,
  PluginInstallContext,
  PluginInstallResult,
  Logger,
} from "@hijarvis/core";
import { createLogger } from "@hijarvis/core";
import { startSlackIdentities, type StopFn } from "./runtime.js";

export const createPlugin: PluginFactory = (_pluginConfig) => {
  const plugin: JarPlugin = {
    name: "jar-gateway-slack",
    async install({ config, hooks, services, logger }: PluginInstallContext): Promise<PluginInstallResult> {
      const effectiveLogger: Logger = logger ?? createLogger({ level: "info", stderr: true });
      const stops: StopFn[] = await startSlackIdentities(config, hooks, services, effectiveLogger);
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
