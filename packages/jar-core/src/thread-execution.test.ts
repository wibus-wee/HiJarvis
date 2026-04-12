import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Usage } from "@mariozechner/pi-ai";

import { createFileSystemConversationStateStore, createFileSystemExecutionAuditStore } from "./persistence.js";
import { startThreadExecutionTracker } from "./thread-execution.js";

test("startThreadExecutionTracker records turn, run, and items", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-thread-execution-"));
  try {
    const stateStore = createFileSystemConversationStateStore();
    const session = await stateStore.load({
      platform: "cli",
      scope: {
        kind: "local_thread",
        threadId: "thread_main",
      },
    }, {
      configFilePath: path.join(rootDir, "jar.toml"),
      logging: { level: "info", stderr: true },
      agent: {
        provider: "openai",
        model: "gpt-4o-mini",
        systemPrompt: "You are Jarvis.",
        thinkingLevel: "minimal",
        providerConfig: {},
        execution: {
          requestTimeoutMs: 120_000,
          retryAttempts: 0,
          retryInitialDelayMs: 1_000,
          retryBackoffMultiplier: 2,
          retryMaxDelayMs: 30_000,
        },
        compaction: {
          enabled: true,
          triggerRatio: 0.9,
          budgetRatio: 0.9,
          summaryMaxTokens: 1024,
        },
        systemPromptOverlays: [],
      },
      skills: {
        enabled: false,
        roots: [],
        entries: [],
        catalog: "",
        errors: [],
        truncatedByLimit: false,
        maxScanDepth: 0,
        maxSkills: 0,
        maxCatalogChars: 0,
        maxBodyChars: 0,
      },
      toolOptions: {
        provider: "openai",
        model: "gpt-4o-mini",
        workspaceRoot: rootDir,
        maxFileBytes: 32_768,
        commandTimeoutMs: 30_000,
        maxCommandOutputBytes: 32_768,
        webRequestTimeoutMs: 30_000,
        maxWebResponseBytes: 65_536,
      },
      sessions: { rootDir },
      entities: {},
      platformIdentities: {},
      platform: {},
    });
    const auditStore = createFileSystemExecutionAuditStore();

    const tracker = await startThreadExecutionTracker({
      threadId: session.threadId,
      auditStore,
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
      stageCount: 3,
      appliedStages: ["snip", "summary", "assembly"],
      stages: [
        {
          stage: "snip",
          applied: true,
          tokenEstimateBefore: 10_000,
          tokenEstimateAfter: 7_000,
        },
        {
          stage: "summary",
          applied: true,
          tokenEstimateBefore: 7_000,
          tokenEstimateAfter: 4_000,
        },
        {
          stage: "assembly",
          applied: true,
          tokenEstimateBefore: 7_000,
          tokenEstimateAfter: 4_000,
        },
      ],
    });
    await tracker.recordNote({
      kind: "skills_warning",
      message: "Skill body could not be loaded.",
    });
    await tracker.recordEvent(createMessageEndEvent(assistantMessage));
    await tracker.complete("Workspace is clean.");

    const laneDir = path.join(rootDir, "threads", "thread_main", "lanes", "main");
    const turns = await readJsonl(path.join(laneDir, "turns.jsonl"));
    const runs = await readJsonl(path.join(laneDir, "runs.jsonl"));
    const items = await readJsonl(path.join(laneDir, "items.jsonl"));

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
    const compactionItem = items.find((entry) => entry.item.type === "compaction");
    assert.equal(compactionItem?.item.payload.stageCount, 3);
    assert.deepEqual(compactionItem?.item.payload.appliedStages, ["snip", "summary", "assembly"]);
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
