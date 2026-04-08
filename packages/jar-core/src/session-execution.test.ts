import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Usage } from "@mariozechner/pi-ai";

import { startSessionExecutionTracker } from "./session-execution.js";
import { openSession } from "./session-store.js";

test("startSessionExecutionTracker records turn, run, and items", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-session-execution-"));
  try {
    const session = await openSession({
      rootDir,
      provider: "openai",
      model: "gpt-4o-mini",
    });

    const tracker = await startSessionExecutionTracker({
      session,
      prompt: "Explain the workspace state.",
      trigger: "user_input",
      turnInputMetadata: {
        platform: "cli",
      },
    });

    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Workspace is clean.",
        },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: emptyUsage(),
      timestamp: Date.now(),
      stopReason: "stop",
    };

    await tracker.recordEvent(createMessageUpdateEvent(assistantMessage, {
      type: "text_delta",
      contentIndex: 0,
      delta: "Workspace ",
      partial: assistantMessage,
    }));
    await tracker.recordEvent(createToolExecutionStartEvent("tool_1", "bash", {
      command: "git status --short",
    }));
    await tracker.recordEvent(createToolExecutionEndEvent("tool_1", "bash", {
      exitCode: 0,
    }));
    await tracker.recordRetryNotice({
      attempt: 1,
      totalAttempts: 3,
      category: "network",
      nextAttempt: 2,
      delayMs: 1000,
    });
    await tracker.recordCompaction({
      type: "compaction",
      kind: "pre_turn",
      tokenEstimateBefore: 10_000,
      tokenEstimateAfter: 4_000,
      summaryTokens: 256,
    });
    await tracker.recordNote({
      kind: "skills_warning",
      message: "Skill body could not be loaded.",
    });
    await tracker.recordEvent(createMessageEndEvent(assistantMessage));
    await tracker.complete("Workspace is clean.");

    const turns = await readJsonl(session.paths.turnsPath);
    const runs = await readJsonl(session.paths.runsPath);
    const items = await readJsonl(session.paths.itemsPath);

    assert.equal(turns.length, 2);
    assert.equal(turns.at(-1)?.turn.status, "completed");
    assert.equal(turns.at(-1)?.turn.output?.outputText, "Workspace is clean.");

    assert.equal(runs.length, 2);
    assert.equal(runs.at(-1)?.run.status, "completed");
    assert.equal(runs.at(-1)?.run.kind, "act");

    assert.deepEqual(
      items.map((entry) => entry.item.type),
      [
        "user_input",
        "assistant_message",
        "tool_call",
        "tool_result",
        "retry_notice",
        "compaction",
        "note",
        "assistant_message",
      ],
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

const readJsonl = async (filePath: string): Promise<Record<string, any>[]> => {
  const content = await readFile(filePath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
};

const createMessageUpdateEvent = (
  message: AssistantMessage,
  assistantMessageEvent: AssistantMessageEvent,
): Extract<AgentEvent, { type: "message_update" }> => {
  return {
    type: "message_update",
    message,
    assistantMessageEvent,
  };
};

const createMessageEndEvent = (
  message: AssistantMessage,
): Extract<AgentEvent, { type: "message_end" }> => {
  return {
    type: "message_end",
    message,
  };
};

const createToolExecutionStartEvent = (
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): Extract<AgentEvent, { type: "tool_execution_start" }> => {
  return {
    type: "tool_execution_start",
    toolCallId,
    toolName,
    args,
  };
};

const createToolExecutionEndEvent = (
  toolCallId: string,
  toolName: string,
  result: Record<string, unknown>,
): Extract<AgentEvent, { type: "tool_execution_end" }> => {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result,
    isError: false,
  };
};

const emptyUsage = (): Usage => {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
};
