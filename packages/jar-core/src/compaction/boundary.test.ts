import assert from "node:assert/strict";
import test from "node:test";

import { createSnapshotBoundary, getMessagesAfterBoundary } from "./boundary.js";
import { createSummaryMessage } from "./assembly.js";

test("getMessagesAfterBoundary slices history from summary boundary when present", () => {
  const messages = [
    { role: "user" as const, content: "older", timestamp: 1 },
    createSummaryMessage("summary"),
    { role: "user" as const, content: "latest", timestamp: 2 },
  ];

  const boundary = createSnapshotBoundary("post_turn", messages);
  const sliced = getMessagesAfterBoundary(messages, boundary);

  assert.equal(boundary.summaryMessageIndex, 1);
  assert.deepEqual(sliced, messages.slice(1));
});
