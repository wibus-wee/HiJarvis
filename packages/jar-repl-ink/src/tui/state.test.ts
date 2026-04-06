import assert from "node:assert/strict";
import test from "node:test";

import type { Message } from "@mariozechner/pi-ai";

import { createReplState, replReducer } from "./state.js";

test("createReplState loads persisted transcript messages", () => {
  const messages: Message[] = [
    {
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "world" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ];

  const state = createReplState(messages);

  assert.equal(state.transcript.length, 2);
  assert.equal(state.transcript[0]?.title, "User");
  assert.equal(state.transcript[1]?.body, "world");
});

test("replReducer accumulates assistant deltas and finalizes message_end", () => {
  let state = createReplState([]);

  state = replReducer(state, {
    type: "agent_event",
    event: {
      type: "message_update",
      message: {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4o-mini",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Hello",
        partial: {
          role: "assistant",
          content: [],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-4o-mini",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      },
    },
  });

  state = replReducer(state, {
    type: "agent_event",
    event: {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4o-mini",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
  });

  assert.equal(state.streamingAssistantText, "");
  assert.equal(state.transcript.length, 1);
  assert.equal(state.transcript[0]?.body, "Hello world");
});

test("replReducer tracks tool execution lifecycle", () => {
  let state = createReplState([]);

  state = replReducer(state, {
    type: "agent_event",
    event: {
      type: "tool_execution_start",
      toolCallId: "tool_1",
      toolName: "read_file",
      args: { path: "package.json" },
    },
  });

  state = replReducer(state, {
    type: "agent_event",
    event: {
      type: "tool_execution_update",
      toolCallId: "tool_1",
      toolName: "read_file",
      args: { path: "package.json" },
      partialResult: {
        content: [{ type: "text", text: "Reading..." }],
        details: { progress: 50 },
      },
    },
  });

  state = replReducer(state, {
    type: "agent_event",
    event: {
      type: "tool_execution_end",
      toolCallId: "tool_1",
      toolName: "read_file",
      result: {
        content: [{ type: "text", text: "done" }],
        details: { size: 128 },
      },
      isError: false,
    },
  });

  assert.equal(state.tools.length, 1);
  assert.equal(state.tools[0]?.status, "completed");
  assert.equal(state.tools[0]?.latestUpdate, "Reading...");
  assert.equal(state.tools[0]?.resultPreview, "done");
});

test("replReducer cycles focus panes", () => {
  let state = createReplState([]);

  state = replReducer(state, { type: "focus_previous" });
  assert.equal(state.focusedPane, "diagnostics");

  state = replReducer(state, { type: "focus_next" });
  assert.equal(state.focusedPane, "composer");

  state = replReducer(state, { type: "focus_next" });
  assert.equal(state.focusedPane, "transcript");
});

test("replReducer scrolls the focused transcript pane within bounds", () => {
  const messages: Message[] = Array.from({ length: 8 }, (_, index) => ({
    role: "user" as const,
    content: `message-${index + 1}`,
    timestamp: Date.now() + index,
  }));

  let state = createReplState(messages);
  state = replReducer(state, { type: "set_focus", pane: "transcript" });

  state = replReducer(state, { type: "scroll_focused", delta: 2, pageSize: 3 });
  assert.equal(state.transcriptOffset, 2);

  state = replReducer(state, { type: "scroll_focused", delta: 100, pageSize: 3 });
  assert.equal(state.transcriptOffset, 5);

  state = replReducer(state, { type: "scroll_focused", delta: -100, pageSize: 3 });
  assert.equal(state.transcriptOffset, 0);
});

test("replReducer preserves diagnostic viewport when scrolled away from the end", () => {
  let state = createReplState([]);
  state = replReducer(state, { type: "append_diagnostic", level: "info", message: "one" });
  state = replReducer(state, { type: "append_diagnostic", level: "info", message: "two" });
  state = replReducer(state, { type: "set_focus", pane: "diagnostics" });
  state = replReducer(state, { type: "scroll_focused", delta: 1, pageSize: 1 });

  state = replReducer(state, { type: "append_diagnostic", level: "info", message: "three" });

  assert.equal(state.diagnosticOffset, 2);
});
