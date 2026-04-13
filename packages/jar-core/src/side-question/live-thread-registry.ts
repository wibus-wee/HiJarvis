import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type SideQuestionLiveThreadCapture = {
  threadId: string;
  laneId: string;
  capturedAt: number;
  messages: AgentMessage[];
};

type LiveThreadEntry = {
  threadId: string;
  laneId: string;
  registeredAt: number;
  capture: SideQuestionLiveThreadCapture | null;
};

const liveThreads = new Map<string, LiveThreadEntry>();
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

export const registerLiveThreadForSideQuestion = (options: {
  threadId: string;
  laneId: string;
}): void => {
  sweepStaleLiveThreads();
  liveThreads.set(options.threadId, {
    threadId: options.threadId,
    laneId: options.laneId,
    registeredAt: Date.now(),
    capture: null,
  });
};

export const updateLiveThreadCaptureForSideQuestion = (
  threadId: string,
  capture: SideQuestionLiveThreadCapture,
): void => {
  const entry = liveThreads.get(threadId);
  if (!entry) {
    throw new Error(`No live thread registered for ${threadId}`);
  }

  entry.capture = capture;
};

export const captureLiveThreadForSideQuestion = (
  threadId: string,
): SideQuestionLiveThreadCapture | null => {
  sweepStaleLiveThreads();
  const capture = liveThreads.get(threadId)?.capture;
  if (!capture) {
    return null;
  }

  return {
    ...capture,
    messages: capture.messages.map(cloneAgentMessage),
  };
};

export const unregisterLiveThreadForSideQuestion = (threadId: string): void => {
  liveThreads.delete(threadId);
};

export const getLiveThreadRegistrySize = (): number => {
  sweepStaleLiveThreads();
  return liveThreads.size;
};

export const _resetLiveThreadRegistryForTest = (): void => {
  liveThreads.clear();
};

const sweepStaleLiveThreads = (now = Date.now()): void => {
  for (const [threadId, entry] of liveThreads.entries()) {
    if (now - entry.registeredAt > STALE_THRESHOLD_MS) {
      liveThreads.delete(threadId);
    }
  }
};

const cloneAgentMessage = <T extends AgentMessage>(message: T): T => {
  return structuredClone(message);
};
