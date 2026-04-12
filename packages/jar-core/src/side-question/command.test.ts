import assert from "node:assert/strict";
import test from "node:test";

import { parseSideQuestionCommand } from "./command.js";

test("parseSideQuestionCommand extracts the side question body", () => {
  assert.deepEqual(parseSideQuestionCommand("/btw what changed?"), {
    question: "what changed?",
  });
});

test("parseSideQuestionCommand ignores non-btw input", () => {
  assert.equal(parseSideQuestionCommand("hello there"), null);
});

test("parseSideQuestionCommand rejects empty btw questions", () => {
  assert.equal(parseSideQuestionCommand("/btw   "), null);
});
