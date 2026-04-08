import assert from "node:assert/strict";
import test from "node:test";

import { getSummaryPrompt } from "./prompt.js";

test("getSummaryPrompt returns full and partial prompt variants", () => {
  assert.match(getSummaryPrompt("full"), /CONTEXT CHECKPOINT COMPACTION/);
  assert.match(getSummaryPrompt("partial_from"), /PARTIAL CONTEXT COMPACTION/);
  assert.match(getSummaryPrompt("partial_up_to"), /older conversation history/);
});
