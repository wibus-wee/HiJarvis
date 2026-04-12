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
  capture: SideQuestionLiveThreadCapture | null;
};

const liveThreads = new Map<string, LiveThreadEntry>();

export const registerLiveThreadForSideQuestion = (options: {
  threadId: string;
  laneId: string;
}): void => {
  liveThreads.set(options.threadId, {
    threadId: options.threadId,
    laneId: options.laneId,
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

  entry.capture = {
    ...capture,
    messages: capture.messages.map(cloneAgentMessage),
  };
};

export const captureLiveThreadForSideQuestion = (
  threadId: string,
): SideQuestionLiveThreadCapture | null => {
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

const cloneAgentMessage = <T extends AgentMessage>(message: T): T => {
  return structuredClone(message);
};
