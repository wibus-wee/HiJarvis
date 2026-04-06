import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
