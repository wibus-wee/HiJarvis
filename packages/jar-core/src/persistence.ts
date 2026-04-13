import { appendFile } from "node:fs/promises";
import path from "node:path";

import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

import type { ThreadItem, ThreadRun, ThreadTurn, JarEvent } from "./execution-types.js";
import type { UsageRecord } from "./execution-types.js";
import {
  ensureThreadMeta,
  openConversationHandle,
  type ThreadMeta,
} from "./lanes/index.js";
import type { LoadedRuntimeConfig } from "./config.js";
import type { RoutedScope } from "./ingress.js";

export type MaterializedConversationState = {
  threadId: string;
  laneId: string;
  messages: AgentMessage[];
};

export type AppendConversationMessageInput = {
  threadId: string;
  message: AgentMessage;
};

export type ApplyCheckpointInput = {
  threadId: string;
  messages: AgentMessage[];
  sourceOffsets: number[];
};

export interface ConversationStateStore {
  load(target: RoutedScope, config: LoadedRuntimeConfig): Promise<MaterializedConversationState>;
  appendMessage(input: AppendConversationMessageInput): Promise<void>;
  applyCheckpoint(input: ApplyCheckpointInput): Promise<void>;
  flush(threadId: string): Promise<void>;
}

export interface ExecutionAuditStore {
  appendTurn(threadId: string, turn: ThreadTurn): Promise<void>;
  appendRun(threadId: string, run: ThreadRun): Promise<void>;
  appendItem(threadId: string, item: ThreadItem): Promise<void>;
}

export interface EventLogStore {
  appendEvent(threadId: string, event: JarEvent | AgentEvent): Promise<void>;
}

export interface UsageStore {
  appendUsage(record: UsageRecord): Promise<void>;
}

type StoreHandle = Awaited<ReturnType<typeof openConversationHandle>>;

const handles = new Map<string, Promise<StoreHandle>>();

const scopeToRouting = (target: RoutedScope): ThreadMeta["routing"] => {
  if (target.scope.kind === "local_thread") {
    return {
      identityId: target.identityId ?? "cli",
      platform: "cli",
      scope: target.scope.threadId,
    };
  }

  if (target.scope.kind === "slack") {
    return {
      identityId: target.identityId ?? "unknown",
      platform: "slack",
      scope: target.scope.threadTs === undefined
        ? `channel:${target.scope.channelId}`
        : `channel:${target.scope.channelId}:thread:${target.scope.threadTs}`,
    };
  }

  return {
    identityId: target.identityId ?? "unknown",
    platform: "telegram",
    scope: target.scope.messageThreadId === undefined
      ? `chat:${target.scope.chatId}`
      : `chat:${target.scope.chatId}:thread:${target.scope.messageThreadId}`,
  };
};

const getHandle = async (threadId: string): Promise<StoreHandle> => {
  const handle = handles.get(threadId);
  if (handle === undefined) {
    throw new Error(`Conversation handle not loaded for ${threadId}`);
  }
  return handle;
};

export const createFileSystemConversationStateStore = (): ConversationStateStore => {
  return {
    load: async (target, config) => {
      const threadId = target.scope.kind === "local_thread"
        ? target.scope.threadId
        : undefined;
      const resolvedThreadId = threadId ?? (await import("./ingress.js")).buildThreadIdFromScope(target);
      await ensureThreadMeta({
        rootDir: config.sessions.rootDir,
        threadId: resolvedThreadId,
        provider: config.agent.provider,
        model: config.agent.model,
        routing: scopeToRouting(target),
      });
      const opened = openConversationHandle({
        rootDir: config.sessions.rootDir,
        threadId: resolvedThreadId,
        provider: config.agent.provider,
        model: config.agent.model,
      });
      handles.set(resolvedThreadId, opened);
      const handle = await opened;
      return {
        threadId: handle.threadId,
        laneId: handle.laneId,
        messages: [...handle.messages],
      };
    },
    appendMessage: async ({ threadId, message }) => {
      const handle = await getHandle(threadId);
      await handle.appendMessage(message);
    },
    applyCheckpoint: async ({ threadId, messages, sourceOffsets }) => {
      const handle = await getHandle(threadId);
      await handle.appendLaneCheckpoint(messages, sourceOffsets);
    },
    flush: async (threadId) => {
      const handle = await getHandle(threadId);
      await handle.flush();
    },
  };
};

export const createFileSystemExecutionAuditStore = (): ExecutionAuditStore => {
  return {
    appendTurn: async (threadId, turn) => {
      const handle = await getHandle(threadId);
      await handle.appendTurn(turn);
    },
    appendRun: async (threadId, run) => {
      const handle = await getHandle(threadId);
      await handle.appendRun(run);
    },
    appendItem: async (threadId, item) => {
      const handle = await getHandle(threadId);
      await handle.appendItem(item);
    },
  };
};

export const createFileSystemEventLogStore = (): EventLogStore => {
  return {
    appendEvent: async (threadId, event) => {
      const handle = await getHandle(threadId);
      await handle.appendEvent(event);
    },
  };
};

export const createFileSystemUsageStore = (sessionsRootDir: string): UsageStore => {
  const usagePath = path.join(path.resolve(sessionsRootDir), "usage.jsonl");
  return {
    appendUsage: async (record) => {
      const line = JSON.stringify({ v: 1, ...record });
      await appendFile(usagePath, `${line}\n`, "utf8");
    },
  };
};
