export {
  openConversationHandle,
  type ConversationHandle,
} from "./handle.js";
export {
  ensureThreadMeta,
  listThreads,
  touchThread,
  type ThreadListItem,
} from "./thread-store.js";
export {
  materializeLaneView,
} from "./materializer.js";
export {
  openTape,
  appendTapeRecord,
  readTapeRecords,
} from "./tape-store.js";
export type {
  LaneCheckpointPayload,
  LaneMeta,
  MaterializedLaneView,
  TapeHandle,
  TapeRecord,
  ThreadMeta,
} from "./types.js";
