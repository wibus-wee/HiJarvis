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
  /** Write the current working-set to head.json as a read-acceleration cache.
   * Not an authoritative state transition — does not write a tape record. */
  refreshCache(threadId: string): Promise<void>;
  /** Flush the cache and release the cached handle so GC can reclaim it. */
  release(threadId: string): Promise<void>;
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

// ── LRU handle cache ─────────────────────────────────────────
// Replaces the previous bare Map to prevent unbounded growth in
// long-running gateway processes (Slack / Telegram).  Eviction
// only drops the JS reference — ConversationHandle holds no open
// file descriptors, so GC is sufficient for cleanup.

class HandleCache {
  private map = new Map<string, Promise<StoreHandle>>();
  private accessOrder: string[] = []; // most-recent at end
  private readonly maxSize: number;

  constructor(maxSize = 256) {
    this.maxSize = maxSize;
  }

  get(threadId: string): Promise<StoreHandle> | undefined {
    const entry = this.map.get(threadId);
    if (entry !== undefined) {
      this.touch(threadId);
    }
    return entry;
  }

  set(threadId: string, handle: Promise<StoreHandle>): void {
    if (!this.map.has(threadId)) {
      this.evictIfNeeded();
    }
    this.map.set(threadId, handle);
    this.touch(threadId);
  }

  delete(threadId: string): boolean {
    this.accessOrder = this.accessOrder.filter((id) => id !== threadId);
    return this.map.delete(threadId);
  }

  get size(): number {
    return this.map.size;
  }

  private touch(threadId: string): void {
    this.accessOrder = this.accessOrder.filter((id) => id !== threadId);
    this.accessOrder.push(threadId);
  }

  private evictIfNeeded(): void {
    while (this.map.size >= this.maxSize && this.accessOrder.length > 0) {
      const oldest = this.accessOrder.shift()!;
      const evicted = this.map.get(oldest);
      this.map.delete(oldest);
      // Best-effort cache refresh before dropping the reference.
      if (evicted !== undefined) {
        void evicted.then((handle) => handle.refreshCache()).catch(() => {});
      }
    }
  }
}

const handles = new HandleCache(256);

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

      // Reuse a cached handle when available instead of unconditionally
      // opening a new one (which also leaked the previous reference).
      let cached = handles.get(resolvedThreadId);
      if (cached === undefined) {
        const opened = openConversationHandle({
          rootDir: config.sessions.rootDir,
          threadId: resolvedThreadId,
          provider: config.agent.provider,
          model: config.agent.model,
        });
        handles.set(resolvedThreadId, opened);
        cached = opened;
      }

      const handle = await cached;
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
    refreshCache: async (threadId) => {
      const handle = await getHandle(threadId);
      await handle.refreshCache();
    },
    release: async (threadId) => {
      const cached = handles.get(threadId);
      if (cached === undefined) return;
      try {
        const handle = await cached;
        await handle.refreshCache();
      } finally {
        handles.delete(threadId);
      }
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
