import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveWorkspacePath, validateToolOptions } from "./shared.js";

const workspaceRoot = path.join(path.sep, "tmp", "jar-workspace");
const baseToolOptions = {
  provider: "openai",
  model: "gpt-4o-mini",
  workspaceRoot,
  maxFileBytes: 32_768,
  commandTimeoutMs: 1_500,
  maxCommandOutputBytes: 32_768,
  webRequestTimeoutMs: 15_000,
  maxWebResponseBytes: 131_072,
} as const;

test("resolveWorkspacePath returns nested paths inside the workspace", () => {
  const resolvedPath = resolveWorkspacePath(workspaceRoot, "docs/notes.md");

  assert.equal(resolvedPath, path.join(workspaceRoot, "docs/notes.md"));
});

test("resolveWorkspacePath rejects absolute paths", () => {
  assert.throws(
    () => resolveWorkspacePath(workspaceRoot, path.join(path.sep, "tmp", "notes.md")),
    /must be relative/,
  );
});

test("resolveWorkspacePath rejects parent traversal outside the workspace", () => {
  assert.throws(
    () => resolveWorkspacePath(workspaceRoot, "../notes.md"),
    /outside the configured workspace root/,
  );
});

test("resolveWorkspacePath can allow the workspace root for directory commands", () => {
  assert.throws(
    () => resolveWorkspacePath(workspaceRoot, "."),
    /outside the configured workspace root/,
  );

  const resolvedPath = resolveWorkspacePath(
    workspaceRoot,
    ".",
    { allowWorkspaceRoot: true },
  );

  assert.equal(resolvedPath, workspaceRoot);
});

test("validateToolOptions rejects non-positive limits", () => {
  assert.throws(
    () => validateToolOptions({
      ...baseToolOptions,
      maxFileBytes: 0,
    }),
    /maxFileBytes must be a positive number/,
  );

  assert.throws(
    () => validateToolOptions({
      ...baseToolOptions,
      commandTimeoutMs: -1,
    }),
    /commandTimeoutMs must be a positive number/,
  );

  assert.throws(
    () => validateToolOptions({
      ...baseToolOptions,
      maxCommandOutputBytes: 0,
    }),
    /maxCommandOutputBytes must be a positive number/,
  );

  assert.throws(
    () => validateToolOptions({
      ...baseToolOptions,
      webRequestTimeoutMs: 0,
    }),
    /webRequestTimeoutMs must be a positive number/,
  );

  assert.throws(
    () => validateToolOptions({
      ...baseToolOptions,
      maxWebResponseBytes: -10,
    }),
    /maxWebResponseBytes must be a positive number/,
  );

  assert.throws(
    () => validateToolOptions({
      ...baseToolOptions,
      maxConcurrentShells: 0,
    }),
    /maxConcurrentShells must be a positive number/,
  );
});
