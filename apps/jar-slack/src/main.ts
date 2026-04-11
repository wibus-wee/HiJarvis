import path from "node:path";
import process from "node:process";

import { startSlackGateway } from "./slack-runtime.js";

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

  await startSlackGateway({
    configPath: cliOptions.configPath,
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
  process.stdout.write(`Usage: pnpm --filter @hijarvis/jar-slack dev -- --config ./jar.toml

Config-first fields in [platform.slack.identities.<identity>]:
  entity
  bot_token
  app_token
  signing_secret
  context_lookback_minutes
  context_message_limit

Environment overrides:
  SLACK_BOT_TOKEN
  SLACK_APP_TOKEN
  SLACK_SIGNING_SECRET
  JARVIS_SLACK_CONTEXT_LOOKBACK_MINUTES
  JARVIS_SLACK_CONTEXT_MESSAGE_LIMIT
`);
};

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
