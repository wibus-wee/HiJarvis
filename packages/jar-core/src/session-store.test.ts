import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Message } from "@mariozechner/pi-ai";

import { listSessions, openSession } from "./session-store.js";

test("openSession persists messages and snapshots", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-session-"));
  try {
    const session = await openSession({
      rootDir,
      provider: "openai",
      model: "gpt-4o-mini",
    });

    const message: Message = {
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    };

    await session.appendMessage(message);
    await session.writeSnapshot([message]);

    const reopened = await openSession({
      rootDir,
      sessionId: session.sessionId,
      provider: "openai",
      model: "gpt-4o-mini",
    });

    assert.equal(reopened.messages.length, 1);
    assert.deepEqual(reopened.messages[0], message);

    const sessions = await listSessions(rootDir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.sessionId, session.sessionId);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("openSession supports turn, run, and item records without changing transcript recovery", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-session-"));
  try {
    const session = await openSession({
      rootDir,
      sessionId: "existing-session",
      provider: "openai",
      model: "gpt-4o-mini",
    });

    const message: Message = {
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    };

    await session.appendMessage(message);
    await session.writeSnapshot([message]);
    await session.appendTurn({
      turnId: "turn_1",
      sessionId: session.sessionId,
      trigger: "user_input",
      status: "running",
      input: {
        promptPreview: "hello",
        promptChars: 5,
        promptMessageCount: 1,
      },
      createdAt: Date.now(),
      startedAt: Date.now(),
    });
    await session.appendRun({
      runId: "run_1",
      turnId: "turn_1",
      kind: "act",
      sequence: 1,
      status: "running",
      startedAt: Date.now(),
    });
    await session.appendItem({
      itemId: "item_1",
      runId: "run_1",
      type: "user_input",
      status: "completed",
      payload: {
        promptPreview: "hello",
      },
      createdAt: Date.now(),
    });

    const reopened = await openSession({
      rootDir,
      sessionId: session.sessionId,
      provider: "openai",
      model: "gpt-4o-mini",
    });

    assert.deepEqual(reopened.messages, [message]);

    const turns = await readFile(reopened.paths.turnsPath, "utf8");
    const runs = await readFile(reopened.paths.runsPath, "utf8");
    const items = await readFile(reopened.paths.itemsPath, "utf8");

    assert.match(turns, /"type":"turn"/);
    assert.match(runs, /"type":"run"/);
    assert.match(items, /"type":"item"/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("openSession persists compaction events with staged metadata", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-session-"));
  try {
    const session = await openSession({
      rootDir,
      provider: "openai",
      model: "gpt-4o-mini",
    });

    await session.appendEvent({
      type: "compaction",
      kind: "post_turn",
      tokenEstimateBefore: 12_000,
      tokenEstimateAfter: 4_500,
      summaryTokens: 300,
      stageCount: 3,
      appliedStages: ["lightweight", "summary", "assembly"],
      stages: [
        {
          stage: "lightweight",
          applied: true,
          tokenEstimateBefore: 12_000,
          tokenEstimateAfter: 8_000,
        },
        {
          stage: "summary",
          applied: true,
          tokenEstimateBefore: 8_000,
          tokenEstimateAfter: 4_500,
        },
        {
          stage: "assembly",
          applied: true,
          tokenEstimateBefore: 8_000,
          tokenEstimateAfter: 4_500,
        },
      ],
      boundary: {
        kind: "post_turn",
        summaryIncluded: true,
        summaryMessageCount: 1,
        preservedTailMessageCount: 0,
        preservedUserMessageCount: 2,
      },
    });

    const events = await readFile(session.paths.eventsPath, "utf8");
    assert.match(events, /"stageCount":3/);
    assert.match(events, /"appliedStages":\["lightweight","summary","assembly"\]/);
    assert.match(events, /"summaryIncluded":true/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
