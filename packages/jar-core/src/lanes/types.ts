import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type ThreadMeta = {
  v: 1;
  threadId: string;
  activeLaneId: string;
  provider: string;
  model: string;
  routing: {
    identityId: string;
    platform: "slack" | "telegram" | "cli";
    scope: string;
  };
  createdAt: number;
  updatedAt: number;
};

export type LaneMeta = {
  v: 1;
  laneId: string;
  threadId: string;
  kind: "main";
  status: "active" | "sealed";
  startOffset: number;
  endOffset?: number;
  createdAt: number;
  updatedAt: number;
};

export type TapeRecord = {
  v: 1;
  offset: number;
  threadId: string;
  laneId: string;
  recordedAt: number;
  type:
    | "message.user"
    | "message.assistant"
    | "tool.call"
    | "tool.result"
    | "turn.started"
    | "turn.completed"
    | "run.started"
    | "run.completed"
    | "compaction.applied"
    | "lane.checkpoint";
  payload: Record<string, unknown>;
};

export type LaneCheckpointPayload = {
  headMessages: AgentMessage[];
  sourceOffsets: number[];
};

export type MaterializedLaneView = {
  messages: AgentMessage[];
  checkpointOffset?: number;
  lastOffset: number;
};

export type TapeHandle = {
  rootDir: string;
  threadId: string;
  laneId: string;
  tapePath: string;
  state: {
    nextOffset: number;
    writeChain: Promise<void>;
    lastError?: Error;
  };
};
