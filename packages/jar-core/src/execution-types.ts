import crypto from "node:crypto";

import type { AgentEvent } from "@mariozechner/pi-agent-core";

export type CompactionEvent = {
  type: "compaction";
  kind: "pre_turn" | "mid_turn" | "post_turn";
  tokenEstimateBefore: number;
  tokenEstimateAfter: number;
  summaryTokens: number;
  summaryError?: string;
  stageCount?: number;
  stages?: Array<{
    stage: "snip" | "lightweight" | "summary" | "assembly";
    applied: boolean;
    tokenEstimateBefore: number;
    tokenEstimateAfter: number;
    notes?: string;
  }>;
  appliedStages?: Array<"snip" | "lightweight" | "summary" | "assembly">;
};

export type JarEvent = AgentEvent | CompactionEvent;

export type ThreadTurnTrigger =
  | "user_input"
  | "platform_event"
  | "automation"
  | "spawn_result"
  | "replay";

export type ThreadTurnStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ThreadRunKind =
  | "act"
  | "plan"
  | "retry"
  | "replay"
  | "recovery"
  | "summarize";

export type ThreadRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export type ThreadItemType =
  | "user_input"
  | "assistant_message"
  | "thinking"
  | "plan_step"
  | "tool_call"
  | "tool_result"
  | "retry_notice"
  | "spawn_call"
  | "spawn_result"
  | "compaction"
  | "usage_summary"
  | "note";

export type ThreadItemStatus = "delta" | "completed";

export type ThreadTurnInput = {
  promptPreview: string;
  promptChars: number;
  promptMessageCount: number;
  metadata?: Record<string, unknown>;
};

export type ThreadTurnOutput = {
  outputText: string;
  outputChars: number;
};

export type ThreadTurn = {
  turnId: string;
  threadId: string;
  trigger: ThreadTurnTrigger;
  status: ThreadTurnStatus;
  input: ThreadTurnInput;
  output?: ThreadTurnOutput;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
};

export type ThreadRun = {
  runId: string;
  turnId: string;
  kind: ThreadRunKind;
  sequence: number;
  status: ThreadRunStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
};

export type ThreadItem = {
  itemId: string;
  runId: string;
  type: ThreadItemType;
  status: ThreadItemStatus;
  payload: Record<string, unknown>;
  createdAt: number;
};

const generateRecordId = (prefix: string): string => {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
};

export const generateThreadTurnId = (): string => generateRecordId("turn");
export const generateThreadRunId = (): string => generateRecordId("run");
export const generateThreadItemId = (): string => generateRecordId("item");

export type UsageRecord = {
  type: "usage";
  threadId: string;
  turnId: string;
  runId: string;
  identityId?: string;
  entityId?: string;
  platform: "cli" | "slack" | "telegram";
  model: string;
  provider: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
  };
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  recordedAt: number;
};
