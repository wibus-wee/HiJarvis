import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemPrompt, buildTurnPrompt } from "./prompt-builder.js";

test("buildSystemPrompt keeps the base prompt unchanged when no overlays are provided", () => {
  assert.equal(
    buildSystemPrompt({
      basePrompt: "You are Jarvis.",
    }),
    "You are Jarvis.",
  );
});

test("buildSystemPrompt appends titled sections without leaking empty blocks", () => {
  assert.equal(
    buildSystemPrompt({
      basePrompt: "You are Jarvis.",
      sections: [
        { title: "Runtime Rules", body: "Use tools when they improve accuracy." },
        { title: "Empty Block", body: "   " },
      ],
    }),
    [
      "You are Jarvis.",
      "Runtime Rules:\nUse tools when they improve accuracy.",
    ].join("\n\n"),
  );
});

test("buildTurnPrompt joins lead paragraphs and content sections with stable spacing", () => {
  assert.equal(
    buildTurnPrompt({
      lead: [
        "You are continuing an existing conversation.",
        "The saved session is the source of truth.",
      ],
      sections: [
        { body: "" },
        { body: "Current user request:\n- Wibus: Summarize the thread." },
      ],
    }),
    [
      "You are continuing an existing conversation.",
      "The saved session is the source of truth.",
      "Current user request:\n- Wibus: Summarize the thread.",
    ].join("\n\n"),
  );
});
