import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLogger } from "./logger.js";

test("createLogger filters events below the configured level", async () => {
  const lines: string[] = [];
  const logger = createLogger({
    level: "warn",
    stderrWriter: {
      write: (chunk: string) => {
        lines.push(chunk);
        return true;
      },
    },
  });

  logger.info("thread.prompt_started", {
    threadId: "thread_1",
  });
  logger.warn("thread.prompt_failed", {
    threadId: "thread_1",
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /WARN/);
  assert.match(lines[0] ?? "", /thread\.prompt_failed/);
  assert.doesNotMatch(lines[0] ?? "", /thread\.prompt_started/);
});

test("createLogger writes formatted lines into the configured file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jar-logger-"));
  const filePath = path.join(tempDir, "runtime.log");
  const logger = createLogger({
    level: "debug",
    stderr: false,
    filePath,
    now: () => new Date("2026-04-06T10:00:00.000Z"),
  }).child({
    component: "slack_gateway",
    threadKey: "C1:1.23",
  });

  try {
    logger.info("slack.reply_posted", {
      replyChars: 42,
      message: "Posted reply",
    });
    await logger.drain();

    const content = await readFile(filePath, "utf8");
    const record = JSON.parse(content.trim()) as Record<string, unknown>;
    assert.equal(record.time, "2026-04-06T10:00:00.000Z");
    assert.equal(record.level, "info");
    assert.equal(record.msg, "slack.reply_posted");
    assert.equal(record.component, "slack_gateway");
    assert.equal(record.threadKey, "C1:1.23");
    assert.equal(record.replyChars, 42);
    assert.equal(record.message, "Posted reply");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
