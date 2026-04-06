import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveWorkspacePath } from "./shared.js";

const workspaceRoot = path.join(path.sep, "tmp", "jar-workspace");

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
