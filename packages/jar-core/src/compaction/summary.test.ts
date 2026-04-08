import assert from "node:assert/strict";
import test from "node:test";

import { truncateForRetry } from "./summary.js";

test("truncateForRetry drops oldest messages progressively", () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: "user" as const,
    content: `message-${index}`,
    timestamp: index,
  }));

  const next = truncateForRetry(messages);
  assert.equal(next.length, 8);
  assert.equal(next[0]?.content, "message-2");
});
