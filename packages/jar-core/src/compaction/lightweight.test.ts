import assert from "node:assert/strict";
import test from "node:test";

import { applyLightweightReduction } from "./lightweight.js";

const makeToolResult = (text: string) => ({
  role: "toolResult" as const,
  toolCallId: "tool_1",
  toolName: "bash",
  content: [{ type: "text" as const, text }],
  isError: false,
  timestamp: 1,
});

test("applyLightweightReduction compacts oversized tool results before summary stage", () => {
  const hugeText = "x".repeat(600 * 4);
  const result = applyLightweightReduction([
    {
      role: "user" as const,
      content: "inspect logs",
      timestamp: 1,
    },
    makeToolResult(hugeText),
  ]);

  assert.equal(result.applied, true);
  assert.ok(result.tokenEstimateAfter < result.tokenEstimateBefore);
  const reduced = result.messages[1];
  assert.ok(reduced);
  assert.equal(reduced.role, "toolResult");
  assert.match(reduced.content[0]?.text ?? "", /tool result compacted/);
});

test("applyLightweightReduction leaves small tool results unchanged", () => {
  const result = applyLightweightReduction([
    {
      role: "user" as const,
      content: "inspect logs",
      timestamp: 1,
    },
    makeToolResult("short output"),
  ]);

  assert.equal(result.applied, false);
  assert.equal(result.tokenEstimateAfter, result.tokenEstimateBefore);
});
