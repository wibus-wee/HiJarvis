import assert from "node:assert/strict";
import test from "node:test";

import { clampBlock, truncateLine } from "./format.js";

test("truncateLine keeps a single compact line within width", () => {
  const line = truncateLine("  hello   world   from   jar  ", 12);

  assert.equal(line, "hello world…");
});

test("clampBlock wraps content and limits line count", () => {
  const lines = clampBlock("alpha beta gamma delta epsilon zeta eta theta", {
    width: 12,
    maxLines: 2,
  });

  assert.deepEqual(lines, ["alpha beta", "gamma delta…"]);
});
