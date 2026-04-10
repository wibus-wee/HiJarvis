import assert from "node:assert/strict";
import test from "node:test";

import { getSummaryPrompt } from "./prompt.js";

test("getSummaryPrompt returns the single full prompt", () => {
  assert.match(getSummaryPrompt(), /CONTEXT CHECKPOINT COMPACTION/);
  assert.match(getSummaryPrompt(), /latest tool results or active skill context/);
});
