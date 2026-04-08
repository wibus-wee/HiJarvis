import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

import type { SessionCompactionBoundary } from "../session-store.js";
import { findSummaryMessageIndex } from "./assembly.js";
import type { CompactionKind } from "./types.js";

export const createSnapshotBoundary = (
  kind: CompactionKind,
  messages: Message[],
): SessionCompactionBoundary => {
  const summaryMessageIndex = findSummaryMessageIndex(messages);
  return {
    kind,
    messageIndex: Math.max(0, messages.length - 1),
    summaryMessageIndex,
    recordedAt: Date.now(),
  };
};

export const getMessagesAfterBoundary = (
  messages: AgentMessage[],
  boundary: SessionCompactionBoundary | null | undefined,
): AgentMessage[] => {
  if (!boundary) {
    return messages;
  }

  const startIndex = boundary.summaryMessageIndex ?? boundary.messageIndex;
  if (startIndex < 0 || startIndex >= messages.length) {
    return messages;
  }

  return messages.slice(startIndex);
};
