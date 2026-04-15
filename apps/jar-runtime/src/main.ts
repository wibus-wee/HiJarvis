import path from "node:path";
import process from "node:process";

import {
  createHookRegistry,
  createLogger,
  createPluginManager,
  loadRuntimeConfig,
} from "@hijarvis/jar-core";

type CliOptions = {
  configPath: string;
  helpRequested: boolean;
};

const main = async (): Promise<void> => {
  const cliOptions = parseCliOptions(process.argv.slice(2));

  if (cliOptions.helpRequested) {
    printUsage();
    return;
  }

  const config = await loadRuntimeConfig(cliOptions.configPath);
  const logger = createLogger(config.logging).child({ component: "runtime" });
  const hooks = createHookRegistry({ logger });
  const manager = createPluginManager({ config, hooks, logger });

  logger.info("runtime.loading_plugins", {
    configPath: path.resolve(cliOptions.configPath),
    pluginCount: config.plugins.length,
  });

  await manager.load();

  // Register contributions in the service registry so gateway plugins can
  // retrieve them lazily when handling events (after load() completes).
  manager.getServiceRegistry().register("pluginContributions", manager.getContributions());

  const diagnostics = manager.getDiagnostics();
  const errors = diagnostics.filter((d) => d.level === "error");
  if (errors.length > 0) {
    for (const diag of errors) {
      logger.error("runtime.plugin_error", {
        pluginName: diag.pluginName,
        phase: diag.phase,
        message: diag.message,
      });
    }
  }

  logger.info("runtime.started", {
    configPath: path.resolve(cliOptions.configPath),
    pluginCount: config.plugins.length,
  });

  process.stdout.write(
    `Jar Runtime running with ${config.plugins.length} plugin(s) using ${path.resolve(cliOptions.configPath)}\n`,
  );

  await waitForShutdown(logger);

  logger.info("runtime.shutting_down");
  await manager.shutdown();
  logger.info("runtime.stopped");
};

const waitForShutdown = (logger: ReturnType<typeof createLogger>): Promise<void> => {
  return new Promise((resolve) => {
    const onSignal = (): void => {
      logger.info("runtime.signal_received");
      resolve();
    };

    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
};

const parseCliOptions = (argv: string[]): CliOptions => {
  let configPath = "jar.toml";
  let helpRequested = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === "--") {
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      helpRequested = true;
      continue;
    }

    if (argument === "--config" || argument === "-c") {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error("Expected a file path after --config");
      }

      configPath = nextValue;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument "${argument}"`);
  }

  return {
    configPath: path.resolve(configPath),
    helpRequested,
  };
};

const printUsage = (): void => {
  process.stdout.write(`Usage: pnpm --filter @hijarvis/jar-runtime dev -- --config ./jar.toml

Gateways are loaded as plugins declared in the [plugins] section of jar.toml.

Example jar.toml:
  [[plugins]]
  module = "@hijarvis/jar-plugin-slack"

  [[plugins]]
  module = "@hijarvis/jar-plugin-telegram"

Options:
  --config, -c <path>   Path to jar.toml config file (default: jar.toml)
  --help, -h            Show this help message
`);
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
