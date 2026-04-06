import assert from "node:assert/strict";
import test from "node:test";

import {
  applyUpdateHunks,
  parsePatchDocument,
  type PatchOperation,
} from "./patch-tool.js";

test("parsePatchDocument parses multiple operations in order", () => {
  const patchDocument = `*** Begin Patch
*** Add File: notes/todo.txt
+hello
+world
*** Update File: src/example.ts
@@ replace greeting
 const message = "hello";
-const answer = "old";
+const answer = "new";
*** Delete File: docs/obsolete.md
*** End Patch`;

  const operations = parsePatchDocument(patchDocument);

  assert.deepEqual<PatchOperation[]>(operations, [
    {
      type: "add_file",
      filePath: "notes/todo.txt",
      lines: ["hello", "world"],
    },
    {
      type: "update_file",
      filePath: "src/example.ts",
      hunks: [
        {
          header: "@@ replace greeting",
          lines: [
            " const message = \"hello\";",
            "-const answer = \"old\";",
            "+const answer = \"new\";",
          ],
        },
      ],
    },
    {
      type: "delete_file",
      filePath: "docs/obsolete.md",
    },
  ]);
});

test("applyUpdateHunks replaces the expected block and preserves trailing newline", () => {
  const patchedText = applyUpdateHunks(
    "alpha\nbeta\n",
    [
      {
        header: "@@ rename line",
        lines: [
          " alpha",
          "-beta",
          "+gamma",
        ],
      },
    ],
    "sample.txt",
  );

  assert.equal(patchedText, "alpha\ngamma\n");
});

test("applyUpdateHunks fails when the expected block cannot be found", () => {
  assert.throws(
    () => applyUpdateHunks(
      "alpha\nbeta\n",
      [
        {
          header: "@@ missing block",
          lines: [
            " alpha",
            "-delta",
            "+gamma",
          ],
        },
      ],
      "sample.txt",
    ),
    /could not be applied/,
  );
});
