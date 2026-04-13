import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { readTapeRecords } from "./tape-store.js";
import type { LaneCheckpointPayload, MaterializedLaneView, TapeHandle } from "./types.js";

export const materializeLaneView = async (
  tape: TapeHandle,
): Promise<MaterializedLaneView> => {
  const records = await readTapeRecords(tape);
  const latestCheckpoint = [...records].reverse().find((record) => record.type === "lane.checkpoint");

  const checkpointPayload = latestCheckpoint?.payload as LaneCheckpointPayload | undefined;
  const baseMessages = checkpointPayload?.headMessages ?? [];
  const replayStartOffset = latestCheckpoint?.offset ?? 0;

  const checkpointSourceOffsets = new Set(checkpointPayload?.sourceOffsets ?? []);

  const replayMessages = records
    .filter((record) => record.offset > replayStartOffset)
    .flatMap((record): AgentMessage[] => {
      if (record.type !== "message.user" && record.type !== "message.assistant") {
        return [];
      }
      if (checkpointSourceOffsets.has(record.offset)) {
        return [];
      }
      return [record.payload.message as AgentMessage];
    });

  return {
    messages: [...baseMessages, ...replayMessages],
    checkpointOffset: latestCheckpoint?.offset,
    lastOffset: records.at(-1)?.offset ?? 0,
  };
};
