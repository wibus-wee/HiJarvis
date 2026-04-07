import path from "node:path";
import process from "node:process";

import {
  createAgent,
  createTools,
  executePromptInSession,
  executePromptWithPolicy,
  listSessions,
  loadRuntimeConfig,
  openSession,
  preparePromptWithSkills,
  stripMemoryExcludedPromptContextFromMessage,
} from "@hijarvis/jar-core";
import { runRepl } from "@hijarvis/jar-repl-ink";

import { renderAgentEvent } from "./render-agent-event.js";

type CliOptions = {
  configPath: string;
  prompt?: string;
  helpRequested: boolean;
  repl: boolean;
  sessionId?: string;
  listSessions: boolean;
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
  if (cliOptions.listSessions) {
    const sessions = await listSessions(config.sessions.rootDir);
    if (sessions.length === 0) {
      process.stdout.write("No sessions found.\n");
      return;
    }
    for (const session of sessions) {
      const count =
        session.messageCount === undefined ? "unknown" : String(session.messageCount);
      process.stdout.write(
        `${session.sessionId} (${session.provider}/${session.model}) messages=${count} updated=${new Date(
          session.updatedAt,
        ).toISOString()}\n`,
      );
    }
    return;
  }
  if (cliOptions.repl) {
    const session = await openSession({
      rootDir: config.sessions.rootDir,
      provider: config.runtime.provider,
      model: config.runtime.model,
      ...(cliOptions.sessionId !== undefined
        ? { sessionId: cliOptions.sessionId }
        : {}),
    });
    const agent = createAgent({
      ...config.runtime,
      compactionEventSink: (event) => {
        void session.appendEvent(event);
      },
      tools: createTools(config.toolOptions),
    });

    agent.sessionId = session.sessionId;
    agent.state.messages = session.messages;
    agent.subscribe(async (event, signal) => {
      if (signal.aborted) {
        return;
      }
      await session.appendEvent(event);
      if (event.type === "message_end") {
        await session.appendMessage(stripMemoryExcludedPromptContextFromMessage(event.message));
      }
      if (event.type === "agent_end") {
        await session.writeSnapshot(
          agent.state.messages.map(stripMemoryExcludedPromptContextFromMessage),
        );
      }
    });

    const prompt = await readPrompt(cliOptions.prompt);
    await runRepl({
      agent,
      executePrompt: async (
        input: string,
        writers: { stderr: Pick<NodeJS.WriteStream, "write"> },
      ) => {
        const prepared = await preparePromptWithSkills(input, {
          skills: config.runtime.skills,
          triggerText: input,
        });
        await executePromptWithPolicy(
          agent,
          prepared.prompt,
          config.runtime.execution,
          writers,
        );
      },
      ...(prompt !== undefined ? { initialPrompt: prompt } : {}),
    });
    return;
  }

  const prompt = await readPrompt(cliOptions.prompt);
  if (prompt === undefined) {
    printUsage();
    throw new Error("Missing prompt. Pass text as an argument or pipe it through stdin.");
  }

  if (cliOptions.sessionId !== undefined) {
    await executePromptInSession({
      ...config.runtime,
      toolOptions: config.toolOptions,
      sessionsRootDir: config.sessions.rootDir,
      sessionId: cliOptions.sessionId,
      prompt,
      skillTriggerText: prompt,
      writers: {
        stderr: process.stderr,
      },
      onEvent: (event) => {
        renderAgentEvent(event, { stdout: process.stdout, stderr: process.stderr });
      },
    });
  } else {
    const agent = createAgent({
      ...config.runtime,
      tools: createTools(config.toolOptions),
    });
    agent.subscribe((event) => {
      renderAgentEvent(event, { stdout: process.stdout, stderr: process.stderr });
    });
    const prepared = await preparePromptWithSkills(prompt, {
      skills: config.runtime.skills,
      triggerText: prompt,
    });
    await executePromptWithPolicy(agent, prepared.prompt, config.runtime.execution, {
      stderr: process.stderr,
    });
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
  let sessionId: string | undefined;
  let listSessionsFlag = false;

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

    if (argument === "--session" || argument === "-s") {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error("Expected a session id after --session");
      }
      sessionId = nextValue;
      index += 1;
      continue;
    }

    if (argument === "--repl") {
      repl = true;
      continue;
    }

    if (argument === "--list-sessions") {
      listSessionsFlag = true;
      continue;
    }

    promptSegments.push(argument);
  }

  const cliOptions: CliOptions = {
    configPath: path.resolve(configPath),
    helpRequested,
    repl,
    listSessions: listSessionsFlag,
    ...(sessionId !== undefined ? { sessionId } : {}),
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
       pnpm dev -- --config ./apps/jar-cli/jar.toml --session my-session "Continue this session"
       pnpm dev -- --config ./apps/jar-cli/jar.toml --list-sessions

Examples:
  pnpm dev -- --config ./apps/jar-cli/jar.toml "Read package.json and summarize the scripts."
  echo "Run git status and explain the workspace state." | pnpm dev -- --config ./apps/jar-cli/jar.toml
  pnpm dev -- --config ./apps/jar-cli/jar.toml --repl
  pnpm dev -- --config ./apps/jar-cli/jar.toml --session my-session --repl
  pnpm dev -- --config ./apps/jar-cli/jar.toml --list-sessions
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
