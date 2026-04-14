import path from "node:path";
import process from "node:process";

import {
  buildDefaultSkillTriggerText,
  executeIngressCommand,
  maybeExecuteSideQuestionIngress,
  listThreads,
  loadRuntimeConfig,
  loadThreadMessages,
  preparePromptWithSkills,
  type MessageIngressCommand,
} from "@hijarvis/jar-core";
import { runRepl } from "@hijarvis/jar-repl-ink";

import { renderAgentEvent } from "./render-agent-event.js";

type CliOptions = {
  configPath: string;
  prompt?: string;
  helpRequested: boolean;
  repl: boolean;
  threadId?: string;
  listThreads: boolean;
};

const main = async (): Promise<void> => {
  const cliOptions = parseCliOptions(process.argv.slice(2));

  if (cliOptions.helpRequested) {
    printUsage();
    return;
  }

  if (cliOptions.repl && !process.stdin.isTTY) {
    throw new Error("REPL mode requires a TTY stdin.");
  }

  const config = await loadRuntimeConfig(cliOptions.configPath);
  if (cliOptions.listThreads) {
    const threads = await listThreads(config.sessions.rootDir);
    if (threads.length === 0) {
      process.stdout.write("No threads found.\n");
      return;
    }
    for (const thread of threads) {
      process.stdout.write(
        `${thread.threadId} (${thread.provider}/${thread.model}) updated=${new Date(
          thread.updatedAt,
        ).toISOString()}\n`,
      );
    }
    return;
  }
  if (cliOptions.repl) {
    const threadId = cliOptions.threadId ?? "main";
    const initialMessages = await loadThreadMessages({
      rootDir: config.sessions.rootDir,
      provider: config.agent.provider,
      model: config.agent.model,
      threadId,
    });

    const prompt = await readPrompt(cliOptions.prompt);
    await runRepl({
      initialMessages,
      executePrompt: async (
        input: string,
        _writers: { stderr: Pick<NodeJS.WriteStream, "write"> },
        onEvent,
      ) => {
        const sideQuestion = await maybeExecuteSideQuestionIngress({
          config,
          parentThreadId: threadId,
          input,
          source: { platform: "cli" },
        });
        if (sideQuestion.handled) {
          process.stdout.write(`${sideQuestion.result.outputText.trim() || "I do not have a side-question reply."}\n`);
          return;
        }

        const command: MessageIngressCommand = {
          kind: "message",
          source: { platform: "cli" },
          routing: {
            platform: "cli",
            scope: {
              kind: "local_thread",
              threadId,
            },
          },
          message: {
            text: input,
          },
          prompt: input,
          audit: {
            trigger: "user_input",
          },
          execution: {
            onEvent,
          },
        };

        await executeIngressCommand({
          config,
          command,
        });
      },
      initialPrompt: prompt,
    });
    return;
  }

  const prompt = await readPrompt(cliOptions.prompt);
  if (prompt === undefined) {
    printUsage();
    throw new Error("Missing prompt. Pass text as an argument or pipe it through stdin.");
  }

  if (cliOptions.threadId !== undefined) {
    const sideQuestion = await maybeExecuteSideQuestionIngress({
      config,
      parentThreadId: cliOptions.threadId,
      input: prompt,
      source: { platform: "cli" },
    });
    if (sideQuestion.handled) {
      process.stdout.write(`${sideQuestion.result.outputText.trim() || "I do not have a side-question reply."}`);
    } else {
      await executeIngressCommand({
        config,
        command: {
          kind: "message",
          source: { platform: "cli" },
          routing: {
            platform: "cli",
            scope: {
              kind: "local_thread",
              threadId: cliOptions.threadId,
            },
          },
          message: { text: prompt },
          prompt,
          audit: { trigger: "user_input" },
          execution: {
            onEvent: (event) => {
              renderAgentEvent(event, { stdout: process.stdout, stderr: process.stderr });
            },
          },
        },
      });
    }
  } else {
    const prepared = await preparePromptWithSkills(prompt, {
      skills: config.skills,
      triggerText: prompt,
    });
    const oneShotThreadId = `oneshot__${Date.now()}`;
    const command: MessageIngressCommand = {
      kind: "message",
      source: { platform: "cli" },
      routing: {
        platform: "cli",
        scope: {
          kind: "local_thread",
          threadId: oneShotThreadId,
        },
      },
      message: { text: prompt },
      prompt: prepared.prompt,
      skillTriggerText: buildDefaultSkillTriggerText({
        kind: "message",
        source: { platform: "cli" },
        routing: {
          platform: "cli",
          scope: { kind: "local_thread", threadId: oneShotThreadId },
        },
        message: { text: prompt },
        prompt,
        audit: { trigger: "user_input" },
      }),
      audit: { trigger: "user_input" },
      execution: {
        onEvent: (event) => {
          renderAgentEvent(event, { stdout: process.stdout, stderr: process.stderr });
        },
      },
    };
    await executeIngressCommand({ config, command });
  }
  if (!process.stdout.write("\n")) {
    await onceDrain();
  }
};

const parseCliOptions = (argv: string[]): CliOptions => {
  let configPath = "jar.toml";
  const promptSegments: string[] = [];
  let helpRequested = false;
  let repl = false;
  let threadId: string | undefined;
  let listThreadsFlag = false;

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

    if (argument === "--thread" || argument === "-t") {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error("Expected a thread id after --thread");
      }
      threadId = nextValue;
      index += 1;
      continue;
    }

    if (argument === "--repl") {
      repl = true;
      continue;
    }

    if (argument === "--list-threads") {
      listThreadsFlag = true;
      continue;
    }

    promptSegments.push(argument);
  }

  const cliOptions: CliOptions = {
    configPath: path.resolve(configPath),
    helpRequested,
    repl,
    listThreads: listThreadsFlag,
    threadId,
  };

  if (promptSegments.length > 0) {
    cliOptions.prompt = promptSegments.join(" ");
  }

  return cliOptions;
};

const readPrompt = async (inlinePrompt?: string): Promise<string | undefined> => {
  if (inlinePrompt !== undefined) {
    return inlinePrompt;
  }

  if (process.stdin.isTTY) {
    return undefined;
  }

  const stdinChunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    stdinChunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : chunk,
    );
  }

  const stdinPrompt = Buffer.concat(stdinChunks).toString("utf8").trim();
  return stdinPrompt.length > 0 ? stdinPrompt : undefined;
};

const printUsage = (): void => {
  process.stdout.write(`Usage: pnpm dev -- --config ./apps/jar-cli/jar.toml "Your prompt here"
       pnpm dev -- --config ./apps/jar-cli/jar.toml --repl
       pnpm dev -- --config ./apps/jar-cli/jar.toml --thread my-thread "Continue this thread"
       pnpm dev -- --config ./apps/jar-cli/jar.toml --list-threads

Examples:
  pnpm dev -- --config ./apps/jar-cli/jar.toml "Read package.json and summarize the scripts."
  echo "Run git status and explain the workspace state." | pnpm dev -- --config ./apps/jar-cli/jar.toml
  pnpm dev -- --config ./apps/jar-cli/jar.toml --repl
  pnpm dev -- --config ./apps/jar-cli/jar.toml --thread my-thread --repl
  pnpm dev -- --config ./apps/jar-cli/jar.toml --list-threads
`);
};

const onceDrain = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    process.stdout.once("drain", resolve);
  });
};

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
