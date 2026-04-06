import path from "node:path";
import process from "node:process";

import { startSlackGateway } from "./slack-runtime.js";

type CliOptions = {
  configPath: string;
  helpRequested: boolean;
  host?: string;
  port?: number;
};

const main = async (): Promise<void> => {
  const cliOptions = parseCliOptions(process.argv.slice(2));

  if (cliOptions.helpRequested) {
    printUsage();
    return;
  }

  await startSlackGateway({
    configPath: cliOptions.configPath,
    ...(cliOptions.host !== undefined ? { host: cliOptions.host } : {}),
    ...(cliOptions.port !== undefined ? { port: cliOptions.port } : {}),
  });
};

const parseCliOptions = (argv: string[]): CliOptions => {
  let configPath = "jar.toml";
  let helpRequested = false;
  let host: string | undefined;
  let port: number | undefined;

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

    if (argument === "--host") {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error("Expected a host value after --host");
      }

      host = nextValue;
      index += 1;
      continue;
    }

    if (argument === "--port") {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error("Expected a numeric port after --port");
      }

      const parsed = Number(nextValue);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid port "${nextValue}"`);
      }

      port = parsed;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument "${argument}"`);
  }

  return {
    configPath: path.resolve(configPath),
    helpRequested,
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
  };
};

const printUsage = (): void => {
  process.stdout.write(`Usage: pnpm --filter @hijarvis/jar-slack dev -- --config ./jar.toml
       pnpm --filter @hijarvis/jar-slack dev -- --config ./jar.toml --port 3100

Config-first fields in [platform.slack]:
  bot_name
  bot_token
  app_token
  signing_secret
  context_lookback_minutes
  context_message_limit
  host
  port

Environment overrides:
  SLACK_BOT_TOKEN
  SLACK_APP_TOKEN
  SLACK_SIGNING_SECRET
  JARVIS_SLACK_BOT_NAME
  JARVIS_SLACK_CONTEXT_LOOKBACK_MINUTES
  JARVIS_SLACK_CONTEXT_MESSAGE_LIMIT
  PORT
  HOST
`);
};

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
