import path from "node:path";
import process from "node:process";

import { startTelegramGateway } from "./telegram-runtime.js";

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

  await startTelegramGateway({
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
  process.stdout.write(`Usage: pnpm --filter @hijarvis/jar-telegram dev -- --config ./jar.toml

Config-first fields in [platform.telegram.identities.<identity>]:
  entity
  bot_token
  allowed_chat_ids
  allowed_usernames

Environment overrides:
  TELEGRAM_BOT_TOKEN
  JARVIS_TELEGRAM_ALLOWED_CHAT_IDS
  JARVIS_TELEGRAM_ALLOWED_USERNAMES
`);
};

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
