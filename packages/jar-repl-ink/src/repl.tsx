import process from "node:process";

import type { Agent } from "@mariozechner/pi-agent-core";
import { TextInput } from "@inkjs/ui";
import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import { startTransition, useCallback, useEffect, useReducer, useRef } from "react";

import { clampBlock, truncateLine } from "./tui/format.js";
import {
  createReplState,
  replReducer,
  type TranscriptEntry,
} from "./tui/state.js";

type PromptWriters = {
  stderr: Pick<NodeJS.WriteStream, "write">;
};

export type ReplOptions = {
  agent: Agent;
  executePrompt?: (input: string, writers: PromptWriters) => Promise<void>;
  initialPrompt?: string;
};

export const runRepl = async (options: ReplOptions): Promise<void> => {
  const instance = render(<ReplApp options={options} />, {
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  try {
    await instance.waitUntilExit();
  } finally {
    instance.cleanup();
  }
};

const ReplApp = ({ options }: { options: ReplOptions }) => {
  const [state, dispatch] = useReducer(replReducer, options.agent.state.messages, createReplState);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const hasHandledInitialPrompt = useRef(false);
  const isRunningRef = useRef(state.isRunning);

  useEffect(() => {
    isRunningRef.current = state.isRunning;
  }, [state.isRunning]);

  useEffect(() => {
    const unsubscribe = options.agent.subscribe((event) => {
      startTransition(() => {
        dispatch({ type: "agent_event", event });
      });
    });

    return unsubscribe;
  }, [options.agent]);

  const submitPrompt = useCallback(async (rawValue: string): Promise<void> => {
    const trimmed = rawValue.trim();
    if (trimmed.length === 0 || isRunningRef.current) {
      return;
    }

    if (isExitCommand(trimmed)) {
      exit();
      return;
    }

    const executePrompt =
      options.executePrompt ??
      (async (input: string) => {
        await options.agent.prompt(input);
      });

    startTransition(() => {
      dispatch({ type: "reset_composer" });
      dispatch({ type: "set_running", value: true });
    });

    try {
      await executePrompt(trimmed, {
        stderr: {
          write: () => true,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      startTransition(() => {
        dispatch({ type: "append_diagnostic", level: "error", message });
      });
    } finally {
      startTransition(() => {
        dispatch({ type: "set_running", value: false });
      });
    }
  }, [exit, options.agent, options.executePrompt]);

  const handleDraftChange = useCallback((value: string) => {
    dispatch({ type: "set_draft", value });
  }, []);

  const handleDraftSubmit = useCallback((value: string) => {
    void submitPrompt(value);
  }, [submitPrompt]);

  useEffect(() => {
    if (options.initialPrompt === undefined || hasHandledInitialPrompt.current) {
      return;
    }

    hasHandledInitialPrompt.current = true;
    void submitPrompt(options.initialPrompt);
  }, [options.initialPrompt, submitPrompt]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (isRunningRef.current) {
        options.agent.abort();
        return;
      }

      exit();
    }
  });

  const terminalWidth = Math.max(40, (stdout.columns ?? 80) - 4);
  const terminalHeight = stdout.rows ?? 24;
  const visibleMessages = takeTail(
    state.transcript.filter((entry) => entry.role !== "tool"),
    Math.max(4, terminalHeight - 8),
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        {visibleMessages.length === 0 ? (
          <Text color="gray">No messages yet.</Text>
        ) : (
          visibleMessages.map((entry) => (
            <MessageBlock key={entry.id} entry={entry} width={terminalWidth} />
          ))
        )}
        {state.streamingAssistantText.trim().length > 0 ? (
          <MessageBlock
            entry={{
              id: "streaming-assistant",
              role: "assistant",
              title: "Jar",
              body: state.streamingAssistantText,
              pending: true,
            }}
            width={terminalWidth}
          />
        ) : null}
      </Box>

      <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
        {state.isRunning ? <Text color="yellow">Thinking...</Text> : null}
        <TextInput
          key={state.composerVersion}
          isDisabled={state.isRunning}
          defaultValue={state.draftValue}
          placeholder="Type a message"
          onChange={handleDraftChange}
          onSubmit={handleDraftSubmit}
        />
        <Text color="gray" wrap="truncate-end">
          Enter submit | Ctrl+C abort/exit | type `exit` to leave
        </Text>
      </Box>
    </Box>
  );
};

const MessageBlock = ({ entry, width }: { entry: TranscriptEntry; width: number }) => {
  const label = entry.role === "user" ? "You" : "Jar";
  const lines = clampBlock(entry.body, {
    width,
    maxLines: entry.pending ? 10 : 12,
  });

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={entry.role === "user" ? "cyan" : "green"} bold>
        {truncateLine(`${label}${entry.pending ? " | streaming" : ""}`, width)}
      </Text>
      {lines.map((line, index) => (
        <Text key={`${entry.id}-${index}`}>{line}</Text>
      ))}
    </Box>
  );
};

const takeTail = <T,>(items: T[], count: number): T[] => {
  if (items.length <= count) {
    return items;
  }

  return items.slice(items.length - count);
};

const isExitCommand = (input: string): boolean => {
  return ["exit", "quit", ":q", ":exit", ":quit"].includes(input);
};
