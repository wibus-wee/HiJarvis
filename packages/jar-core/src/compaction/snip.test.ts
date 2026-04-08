import assert from "node:assert/strict";
import test from "node:test";

import { applySnipReduction } from "./snip.js";

const makeUser = (text: string) => ({
  role: "user" as const,
  content: text,
  timestamp: 1,
});

test("applySnipReduction drops oldest messages when history is far above budget", () => {
  const messages = [
    makeUser("a".repeat(1600)),
    makeUser("b".repeat(1600)),
    makeUser("c".repeat(1600)),
    makeUser("d".repeat(1600)),
  ];

  const result = applySnipReduction(messages, 1000);
  assert.equal(result.applied, true);
  assert.ok(result.tokenEstimateAfter < result.tokenEstimateBefore);
  assert.ok(result.messages.length < messages.length);
});
