export {
  executeSideQuestion,
  normalizeSideQuestionPromptToMessages,
  type SideQuestionResult,
} from "./execute-side-question.js";
export {
  _resetLiveThreadRegistryForTest,
  captureLiveThreadForSideQuestion,
  getLiveThreadRegistrySize,
  registerLiveThreadForSideQuestion,
  unregisterLiveThreadForSideQuestion,
  updateLiveThreadCaptureForSideQuestion,
  type SideQuestionLiveThreadCapture,
} from "./live-thread-registry.js";
