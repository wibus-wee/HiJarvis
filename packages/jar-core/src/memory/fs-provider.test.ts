import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileSystemMemoryProvider } from "./fs-provider.js";

const createTempRoot = async (): Promise<string> => {
  return mkdtemp(path.join(os.tmpdir(), "jar-memory-"));
};

test("FileSystemMemoryProvider stores, searches, updates, and deletes entries", async () => {
  const rootDir = await createTempRoot();

  try {
    const provider = new FileSystemMemoryProvider({ rootDir });
    const stored = await provider.store("jarvis", {
      content: "Preferred language is TypeScript",
      tags: ["preference", "language"],
      metadata: { source: "user" },
    });

    assert.equal(stored.content, "Preferred language is TypeScript");
    assert.deepEqual(stored.tags, ["preference", "language"]);
    assert.deepEqual(stored.metadata, { source: "user" });
    assert.equal(typeof stored.id, "string");
    assert.equal(typeof stored.createdAt, "number");
    assert.equal(typeof stored.updatedAt, "number");

    const searched = await provider.search("jarvis", {
      text: "typescript",
      tags: ["language"],
    });
    assert.equal(searched.total, 1);
    assert.equal(searched.entries[0]?.id, stored.id);

    const updated = await provider.update("jarvis", stored.id, {
      content: "Preferred language is Go",
      tags: ["preference", "backend"],
      metadata: { source: "user", updated: true },
    });
    assert.equal(updated.content, "Preferred language is Go");
    assert.deepEqual(updated.tags, ["preference", "backend"]);
    assert.deepEqual(updated.metadata, { source: "user", updated: true });
    assert.ok(updated.updatedAt >= updated.createdAt);

    const afterUpdate = await provider.search("jarvis", { text: "go" });
    assert.equal(afterUpdate.total, 1);
    assert.equal(afterUpdate.entries[0]?.id, stored.id);

    await provider.delete("jarvis", stored.id);

    const afterDelete = await provider.search("jarvis", { text: "go" });
    assert.equal(afterDelete.total, 0);
    assert.deepEqual(afterDelete.entries, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("FileSystemMemoryProvider isolates entries by entity", async () => {
  const rootDir = await createTempRoot();

  try {
    const provider = new FileSystemMemoryProvider({ rootDir });
    const jarvisEntry = await provider.store("jarvis", {
      content: "Jarvis likes TypeScript",
      tags: ["language"],
    });
    await provider.store("pm", {
      content: "PM likes roadmaps",
      tags: ["planning"],
    });

    const jarvisSearch = await provider.search("jarvis", { text: "likes" });
    const pmSearch = await provider.search("pm", { text: "likes" });

    assert.equal(jarvisSearch.total, 1);
    assert.equal(jarvisSearch.entries[0]?.id, jarvisEntry.id);
    assert.equal(pmSearch.total, 1);
    assert.equal(pmSearch.entries[0]?.content, "PM likes roadmaps");

    const noCrossLeak = await provider.search("jarvis", { text: "roadmaps" });
    assert.equal(noCrossLeak.total, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("FileSystemMemoryProvider respects limit and tag filtering", async () => {
  const rootDir = await createTempRoot();

  try {
    const provider = new FileSystemMemoryProvider({ rootDir });
    await provider.store("jarvis", {
      content: "Remember the TypeScript preference",
      tags: ["language", "preference"],
    });
    await provider.store("jarvis", {
      content: "Remember the keyboard preference",
      tags: ["hardware", "preference"],
    });
    await provider.store("jarvis", {
      content: "Remember the editor preference",
      tags: ["editor", "preference"],
    });

    const result = await provider.search("jarvis", {
      text: "remember",
      tags: ["preference"],
      limit: 2,
    });

    assert.equal(result.total, 2);
    assert.equal(result.entries.length, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("FileSystemMemoryProvider rejects updates for missing entries", async () => {
  const rootDir = await createTempRoot();

  try {
    const provider = new FileSystemMemoryProvider({ rootDir });
    await assert.rejects(
      () => provider.update("jarvis", "missing", { content: "updated" }),
      /Memory entry "missing" not found/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
