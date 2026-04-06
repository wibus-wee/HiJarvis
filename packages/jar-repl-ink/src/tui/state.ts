import type { AgentEvent, AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";

export type TranscriptEntry = {
  id: string;
  role: "user" | "assistant" | "tool";
  title: string;
  body: string;
  pending: boolean;
};

export type ToolEntry = {
  id: string;
  toolCallId: string;
  toolName: string;
  argsPreview: string;
  status: "running" | "completed" | "failed";
  latestUpdate?: string;
  resultPreview?: string;
};

export type DiagnosticEntry = {
  id: string;
  level: "info" | "error";
  message: string;
};

export type FocusPane = "transcript" | "tools" | "diagnostics" | "composer";

export type ReplState = {
  draftValue: string;
  composerVersion: number;
  focusedPane: FocusPane;
  isRunning: boolean;
  transcript: TranscriptEntry[];
  streamingAssistantText: string;
  tools: ToolEntry[];
  diagnostics: DiagnosticEntry[];
  transcriptOffset: number;
  toolOffset: number;
  diagnosticOffset: number;
  transcriptSequence: number;
  toolSequence: number;
  diagnosticSequence: number;
};

export type ReplAction =
  | { type: "set_draft"; value: string }
  | { type: "reset_composer" }
  | { type: "focus_next" }
  | { type: "focus_previous" }
  | { type: "set_focus"; pane: FocusPane }
  | { type: "scroll_focused"; delta: number; pageSize: number }
  | { type: "set_running"; value: boolean }
  | { type: "append_diagnostic"; level: "info" | "error"; message: string }
  | { type: "agent_event"; event: AgentEvent };

export const createReplState = (messages: AgentMessage[]): ReplState => {
  const transcript = messages
    .map((message, index) => formatTranscriptEntry(message, index + 1))
    .filter((entry): entry is TranscriptEntry => entry !== null);

  return {
    draftValue: "",
    composerVersion: 0,
    focusedPane: "composer",
    isRunning: false,
    transcript,
    streamingAssistantText: "",
    tools: [],
    diagnostics: [],
    transcriptOffset: 0,
    toolOffset: 0,
    diagnosticOffset: 0,
    transcriptSequence: transcript.length,
    toolSequence: 0,
    diagnosticSequence: 0,
  };
};

export const replReducer = (state: ReplState, action: ReplAction): ReplState => {
  switch (action.type) {
    case "set_draft":
      return {
        ...state,
        draftValue: action.value,
      };
    case "reset_composer":
      return {
        ...state,
        draftValue: "",
        composerVersion: state.composerVersion + 1,
        focusedPane: "composer",
      };
    case "focus_next":
      return {
        ...state,
        focusedPane: getAdjacentPane(state.focusedPane, 1),
      };
    case "focus_previous":
      return {
        ...state,
        focusedPane: getAdjacentPane(state.focusedPane, -1),
      };
    case "set_focus":
      return {
        ...state,
        focusedPane: action.pane,
      };
    case "scroll_focused":
      return scrollFocusedPane(state, action.delta, action.pageSize);
    case "set_running":
      return {
        ...state,
        isRunning: action.value,
      };
    case "append_diagnostic":
      return appendDiagnostic(state, action.level, action.message);
    case "agent_event":
      return reduceAgentEvent(state, action.event);
    default:
      return state;
  }
};

const reduceAgentEvent = (state: ReplState, event: AgentEvent): ReplState => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type !== "text_delta") {
        return state;
      }

      return {
        ...state,
        streamingAssistantText: state.streamingAssistantText + event.assistantMessageEvent.delta,
      };
    case "message_end":
      return finalizeMessage(state, event.message);
    case "tool_execution_start":
      return appendToolEntry(state, {
        id: `tool-${state.toolSequence + 1}`,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        argsPreview: formatUnknownValue(event.args),
        status: "running",
      });
    case "tool_execution_update":
      return {
        ...state,
        tools: state.tools.map((tool) =>
          tool.toolCallId === event.toolCallId
            ? {
              ...tool,
              latestUpdate: formatToolResult(event.partialResult),
            }
            : tool
        ),
      };
    case "tool_execution_end":
      return {
        ...state,
        tools: state.tools.map((tool) =>
          tool.toolCallId === event.toolCallId
            ? {
              ...tool,
              status: event.isError ? "failed" : "completed",
              resultPreview: formatToolResult(event.result),
            }
            : tool
        ),
      };
    default:
      return state;
  }
};

const finalizeMessage = (state: ReplState, message: AgentMessage): ReplState => {
  if (message.role === "assistant") {
    const finalBody = extractAssistantBody(message) ?? state.streamingAssistantText.trim();
    if (finalBody.length === 0) {
      return {
        ...state,
        streamingAssistantText: "",
      };
    }

    return appendTranscriptEntry(state, {
      role: "assistant",
      title: "Assistant",
      body: finalBody,
      pending: false,
    });
  }

  const entry = formatTranscriptEntry(message, state.transcriptSequence + 1);
  if (entry === null) {
    return state;
  }

  return appendTranscriptEntry(state, entry);
};

const appendTranscriptEntry = (
  state: ReplState,
  entry: Omit<TranscriptEntry, "id"> | TranscriptEntry,
): ReplState => {
  const transcriptEntry =
    "id" in entry
      ? entry
      : {
        ...entry,
        id: `msg-${state.transcriptSequence + 1}`,
      };

  return {
    ...state,
    transcriptSequence: state.transcriptSequence + 1,
    transcript: [...state.transcript, transcriptEntry],
    transcriptOffset:
      state.transcriptOffset > 0 ? state.transcriptOffset + 1 : state.transcriptOffset,
    streamingAssistantText: "",
  };
};

const appendDiagnostic = (
  state: ReplState,
  level: "info" | "error",
  message: string,
): ReplState => {
  const normalized = message.trim();
  if (normalized.length === 0) {
    return state;
  }

  return {
    ...state,
    diagnosticSequence: state.diagnosticSequence + 1,
    diagnostics: [
      ...state.diagnostics,
      {
        id: `diag-${state.diagnosticSequence + 1}`,
        level,
        message: normalized,
      },
    ],
    diagnosticOffset:
      state.diagnosticOffset > 0 ? state.diagnosticOffset + 1 : state.diagnosticOffset,
  };
};

const appendToolEntry = (state: ReplState, entry: ToolEntry): ReplState => {
  return {
    ...state,
    toolSequence: state.toolSequence + 1,
    tools: [entry, ...state.tools],
    toolOffset: state.toolOffset > 0 ? state.toolOffset + 1 : state.toolOffset,
  };
};

const scrollFocusedPane = (
  state: ReplState,
  delta: number,
  pageSize: number,
): ReplState => {
  const step = Math.max(1, pageSize);

  switch (state.focusedPane) {
    case "transcript":
      return {
        ...state,
        transcriptOffset: clampOffset(state.transcriptOffset + delta, state.transcript.length, step),
      };
    case "tools":
      return {
        ...state,
        toolOffset: clampOffset(state.toolOffset + delta, state.tools.length, step),
      };
    case "diagnostics":
      return {
        ...state,
        diagnosticOffset: clampOffset(
          state.diagnosticOffset + delta,
          state.diagnostics.length,
          step,
        ),
      };
    case "composer":
    default:
      return state;
  }
};

const clampOffset = (nextOffset: number, total: number, pageSize: number): number => {
  const maximum = Math.max(0, total - Math.max(1, pageSize));
  return Math.max(0, Math.min(maximum, nextOffset));
};

const focusOrder: FocusPane[] = ["transcript", "tools", "diagnostics", "composer"];

const getAdjacentPane = (current: FocusPane, delta: 1 | -1): FocusPane => {
  const currentIndex = focusOrder.indexOf(current);
  const nextIndex = (currentIndex + delta + focusOrder.length) % focusOrder.length;
  return focusOrder[nextIndex] ?? "composer";
};

const formatTranscriptEntry = (
  message: AgentMessage,
  sequence: number,
): TranscriptEntry | null => {
  if (message.role === "user") {
    const body = extractUserBody(message);
    if (body.length === 0) {
      return null;
    }

    return {
      id: `msg-${sequence}`,
      role: "user",
      title: "User",
      body,
      pending: false,
    };
  }

  if (message.role === "assistant") {
    const body = extractAssistantBody(message);
    if (body === null) {
      return null;
    }

    return {
      id: `msg-${sequence}`,
      role: "assistant",
      title: "Assistant",
      body,
      pending: false,
    };
  }

  if (message.role === "toolResult") {
    return {
      id: `msg-${sequence}`,
      role: "tool",
      title: `Tool ${message.toolName}`,
      body: extractToolResultBody(message),
      pending: false,
    };
  }

  return null;
};

const extractUserBody = (message: Extract<AgentMessage, { role: "user" }>): string => {
  if (typeof message.content === "string") {
    return message.content.trim();
  }

  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text.trim())
    .filter((value) => value.length > 0)
    .join("\n");
};

const extractAssistantBody = (message: AssistantMessage): string | null => {
  const text = message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text.trim())
    .filter((value) => value.length > 0)
    .join("\n");

  return text.length > 0 ? text : null;
};

const extractToolResultBody = (message: ToolResultMessage): string => {
  const text = message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text.trim())
    .filter((value) => value.length > 0)
    .join("\n");

  if (text.length > 0) {
    return text;
  }

  if (message.details !== undefined) {
    return formatUnknownValue(message.details);
  }

  return message.isError ? "Tool failed without a text payload." : "Tool completed.";
};

const formatToolResult = (value: unknown): string => {
  if (isToolResult(value)) {
    const text = value.content
      .filter((item) => item.type === "text")
      .map((item) => item.text.trim())
      .filter((item) => item.length > 0)
      .join("\n");

    if (text.length > 0) {
      return text;
    }

    if (value.details !== undefined) {
      return formatUnknownValue(value.details);
    }
  }

  return formatUnknownValue(value);
};

const isToolResult = (value: unknown): value is AgentToolResult<unknown> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return "content" in value;
};

const formatUnknownValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value.trim();
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
