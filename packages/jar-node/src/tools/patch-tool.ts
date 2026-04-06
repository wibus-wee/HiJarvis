import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Type, type TSchema } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

import type { ToolOptions } from "./shared.js";
import { resolveWorkspacePath } from "./shared.js";

const applyPatchParameters: TSchema = Type.Object({
  patch: Type.String({
    description:
      "Human-readable patch text using *** Begin Patch / *** Update File / *** Add File / *** Delete File",
    minLength: 1,
  }),
});

type ApplyPatchParameters = {
  patch: string;
};

type PreparedFileChange = {
  action: "create" | "update" | "delete";
  filePath: string;
  resolvedPath: string;
  content: string;
  byteLength: number;
};

export type PatchOperation =
  | {
    type: "add_file";
    filePath: string;
    lines: string[];
  }
  | {
    type: "delete_file";
    filePath: string;
  }
  | {
    type: "update_file";
    filePath: string;
    hunks: PatchHunk[];
  };

export type PatchHunk = {
  header: string;
  lines: string[];
};

type FileText = {
  lines: string[];
  hasTrailingNewline: boolean;
};

type ExistingFile = {
  exists: boolean;
  content: string;
};

export const createApplyPatchTool = (
  options: ToolOptions,
): AgentTool<typeof applyPatchParameters> => {
  return {
    name: "apply_patch",
    label: "Apply Patch",
    description:
      "Apply a human-readable patch inside the configured workspace root.",
    parameters: applyPatchParameters,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as ApplyPatchParameters;
      const operations = parsePatchDocument(params.patch);
      const stagedFiles = new Map<string, PreparedFileChange>();

      for (const operation of operations) {
        const preparedChange = await prepareFileChange(options, operation, stagedFiles);
        stagedFiles.set(preparedChange.resolvedPath, preparedChange);
      }

      const fileChanges = [...stagedFiles.values()];

      await Promise.all(
        fileChanges.map(async (change) => {
          if (change.action === "delete") {
            await rm(change.resolvedPath);
            return;
          }

          await mkdir(path.dirname(change.resolvedPath), { recursive: true });
          await writeFile(change.resolvedPath, change.content, "utf8");
        }),
      );

      return {
        content: [
          {
            type: "text",
            text: fileChanges
              .map((change) => `${change.action} ${change.filePath}`)
              .join("\n"),
          },
        ],
        details: {
          applied: fileChanges.map((change) => ({
            filePath: change.filePath,
            resolvedPath: change.resolvedPath,
            action: change.action,
            byteLength: change.byteLength,
          })),
        },
      };
    },
  };
};

export const parsePatchDocument = (patchText: string): PatchOperation[] => {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") {
    throw new Error('Patch must start with "*** Begin Patch"');
  }

  const endLine = lines.at(-1) === "" ? lines.length - 2 : lines.length - 1;
  if (lines[endLine] !== "*** End Patch") {
    throw new Error('Patch must end with "*** End Patch"');
  }

  const operations: PatchOperation[] = [];
  let index = 1;

  while (index < endLine) {
    const line = lines[index];
    if (line === undefined) {
      throw new Error("Patch ended unexpectedly");
    }

    if (line === "") {
      index += 1;
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      const filePath = line.slice("*** Add File: ".length);
      const contentLines: string[] = [];
      index += 1;

      while (index < endLine) {
        const contentLine = lines[index];
        if (contentLine === undefined || isOperationHeader(contentLine)) {
          break;
        }

        if (!contentLine.startsWith("+")) {
          throw new Error(`Invalid add-file line: "${contentLine}"`);
        }

        contentLines.push(contentLine.slice(1));
        index += 1;
      }

      if (contentLines.length === 0) {
        throw new Error(`Add File "${filePath}" must contain at least one line`);
      }

      operations.push({ type: "add_file", filePath, lines: contentLines });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      operations.push({
        type: "delete_file",
        filePath: line.slice("*** Delete File: ".length),
      });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const filePath = line.slice("*** Update File: ".length);
      const hunks: PatchHunk[] = [];
      index += 1;

      while (index < endLine) {
        const hunkHeader = lines[index];
        if (hunkHeader === undefined || isOperationHeader(hunkHeader)) {
          break;
        }

        if (!hunkHeader.startsWith("@@")) {
          throw new Error(`Expected hunk header after "${line}", got "${hunkHeader}"`);
        }

        index += 1;
        const hunkLines: string[] = [];

        while (index < endLine) {
          const hunkLine = lines[index];
          if (
            hunkLine === undefined ||
            hunkLine.startsWith("@@") ||
            isOperationHeader(hunkLine)
          ) {
            break;
          }

          if (hunkLine === "\\ No newline at end of file") {
            index += 1;
            continue;
          }

          if (![" ", "+", "-"].includes(hunkLine[0] ?? "")) {
            throw new Error(`Invalid hunk line: "${hunkLine}"`);
          }

          hunkLines.push(hunkLine);
          index += 1;
        }

        hunks.push({ header: hunkHeader, lines: hunkLines });
      }

      if (hunks.length === 0) {
        throw new Error(`Update File "${filePath}" must contain at least one hunk`);
      }

      operations.push({ type: "update_file", filePath, hunks });
      continue;
    }

    throw new Error(`Unexpected patch line: "${line}"`);
  }

  if (operations.length === 0) {
    throw new Error("Patch did not contain any file changes");
  }

  return operations;
};

export const applyUpdateHunks = (
  sourceText: string,
  hunks: PatchHunk[],
  filePath: string,
): string => {
  const fileText = toFileText(sourceText);
  let searchStart = 0;

  for (const hunk of hunks) {
    const expectedLines = hunk.lines
      .filter((line) => line[0] !== "+")
      .map((line) => line.slice(1));
    const replacementLines = hunk.lines
      .filter((line) => line[0] !== "-")
      .map((line) => line.slice(1));
    const matchIndex = findBlockIndex(fileText.lines, expectedLines, searchStart);

    if (matchIndex === -1) {
      throw new Error(`Hunk ${hunk.header} could not be applied to "${filePath}"`);
    }

    fileText.lines.splice(matchIndex, expectedLines.length, ...replacementLines);
    searchStart = matchIndex + replacementLines.length;
  }

  return fromFileText(fileText);
};

const isOperationHeader = (line: string): boolean => {
  return (
    line.startsWith("*** Add File: ") ||
    line.startsWith("*** Delete File: ") ||
    line.startsWith("*** Update File: ")
  );
};

const prepareFileChange = async (
  options: ToolOptions,
  operation: PatchOperation,
  stagedFiles: Map<string, PreparedFileChange>,
): Promise<PreparedFileChange> => {
  const resolvedPath = resolveWorkspacePath(options.workspaceRoot, operation.filePath);
  const stagedFile = stagedFiles.get(resolvedPath);

  if (operation.type === "delete_file") {
    const currentFile = stagedFile === undefined
      ? await readExistingFile(resolvedPath)
      : {
        exists: stagedFile.action !== "delete",
        content: stagedFile.action === "delete" ? "" : stagedFile.content,
      };

    if (!currentFile.exists) {
      throw new Error(`Cannot delete missing file "${operation.filePath}"`);
    }

    return {
      action: "delete",
      filePath: operation.filePath,
      resolvedPath,
      content: "",
      byteLength: 0,
    };
  }

  if (operation.type === "add_file") {
    if (stagedFile !== undefined && stagedFile.action !== "delete") {
      throw new Error(`Cannot add file "${operation.filePath}" because it already exists`);
    }

    if (stagedFile === undefined) {
      const currentFile = await readExistingFile(resolvedPath);
      if (currentFile.exists) {
        throw new Error(`Cannot add file "${operation.filePath}" because it already exists`);
      }
    }

    const content = joinLines(operation.lines, true);
    const byteLength = Buffer.byteLength(content, "utf8");
    validatePatchedSize(operation.filePath, byteLength, options.maxFileBytes);

    return {
      action: "create",
      filePath: operation.filePath,
      resolvedPath,
      content,
      byteLength,
    };
  }

  const currentFile = stagedFile === undefined
    ? await readExistingFile(resolvedPath)
    : {
      exists: stagedFile.action !== "delete",
      content: stagedFile.action === "delete" ? "" : stagedFile.content,
    };

  if (!currentFile.exists) {
    throw new Error(`Cannot update missing file "${operation.filePath}"`);
  }

  const patchedContent = applyUpdateHunks(
    currentFile.content,
    operation.hunks,
    operation.filePath,
  );
  const byteLength = Buffer.byteLength(patchedContent, "utf8");
  validatePatchedSize(operation.filePath, byteLength, options.maxFileBytes);

  return {
    action: stagedFile?.action === "create" ? "create" : "update",
    filePath: operation.filePath,
    resolvedPath,
    content: patchedContent,
    byteLength,
  };
};

const readExistingFile = async (resolvedPath: string): Promise<ExistingFile> => {
  try {
    return {
      exists: true,
      content: await readFile(resolvedPath, "utf8"),
    };
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException;
    if (candidate.code === "ENOENT") {
      return {
        exists: false,
        content: "",
      };
    }

    throw error;
  }
};

const validatePatchedSize = (
  filePath: string,
  byteLength: number,
  maxFileBytes: number,
): void => {
  if (byteLength > maxFileBytes) {
    throw new Error(
      `Patched file "${filePath}" is too large (${byteLength} bytes). Limit: ${maxFileBytes} bytes`,
    );
  }
};

const findBlockIndex = (
  sourceLines: string[],
  expectedLines: string[],
  searchStart: number,
): number => {
  if (expectedLines.length === 0) {
    return searchStart;
  }

  for (let index = searchStart; index <= sourceLines.length - expectedLines.length; index += 1) {
    let matched = true;

    for (let offset = 0; offset < expectedLines.length; offset += 1) {
      if (sourceLines[index + offset] !== expectedLines[offset]) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return index;
    }
  }

  return -1;
};

const toFileText = (text: string): FileText => {
  if (text.length === 0) {
    return {
      lines: [],
      hasTrailingNewline: false,
    };
  }

  const hasTrailingNewline = text.endsWith("\n");
  const normalizedText = hasTrailingNewline ? text.slice(0, -1) : text;

  return {
    lines: normalizedText.split("\n"),
    hasTrailingNewline,
  };
};

const fromFileText = (fileText: FileText): string => {
  if (fileText.lines.length === 0) {
    return "";
  }

  return joinLines(fileText.lines, fileText.hasTrailingNewline);
};

const joinLines = (lines: string[], hasTrailingNewline: boolean): string => {
  const content = lines.join("\n");
  if (!hasTrailingNewline || lines.length === 0) {
    return content;
  }

  return `${content}\n`;
};
