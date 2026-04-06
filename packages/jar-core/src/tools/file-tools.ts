import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Type, type TSchema } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

import type { ToolOptions } from "./shared.js";
import { resolveWorkspacePath } from "./shared.js";

const readFileParameters: TSchema = Type.Object({
  filePath: Type.String({
    description: "Relative path to a UTF-8 text file inside the workspace root",
    minLength: 1,
  }),
});

const writeFileParameters: TSchema = Type.Object({
  filePath: Type.String({
    description: "Relative path to a UTF-8 text file inside the workspace root",
    minLength: 1,
  }),
  content: Type.String({
    description: "UTF-8 text content to write to the file",
  }),
});

type ReadFileParameters = {
  filePath: string;
};

type WriteFileParameters = {
  filePath: string;
  content: string;
};

export const createReadFileTool = (
  options: ToolOptions,
): AgentTool<typeof readFileParameters> => {
  return {
    name: "read_file",
    label: "Read File",
    description:
      "Read a UTF-8 text file inside the configured workspace root. Use this to inspect local project files.",
    parameters: readFileParameters,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as ReadFileParameters;
      const resolvedPath = resolveWorkspacePath(
        options.workspaceRoot,
        params.filePath,
      );

      const fileBuffer = await readFile(resolvedPath);
      if (fileBuffer.byteLength > options.maxFileBytes) {
        throw new Error(
          `File "${params.filePath}" is too large (${fileBuffer.byteLength} bytes). Limit: ${options.maxFileBytes} bytes`,
        );
      }

      return {
        content: [{ type: "text", text: fileBuffer.toString("utf8") }],
        details: {
          filePath: params.filePath,
          resolvedPath,
          byteLength: fileBuffer.byteLength,
        },
      };
    },
  };
};

export const createWriteFileTool = (
  options: ToolOptions,
): AgentTool<typeof writeFileParameters> => {
  return {
    name: "write_file",
    label: "Write File",
    description:
      "Write a UTF-8 text file inside the configured workspace root. Existing files are overwritten.",
    parameters: writeFileParameters,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as WriteFileParameters;
      const resolvedPath = resolveWorkspacePath(
        options.workspaceRoot,
        params.filePath,
      );
      const byteLength = Buffer.byteLength(params.content, "utf8");

      if (byteLength > options.maxFileBytes) {
        throw new Error(
          `File "${params.filePath}" is too large to write (${byteLength} bytes). Limit: ${options.maxFileBytes} bytes`,
        );
      }

      await mkdir(path.dirname(resolvedPath), { recursive: true });
      await writeFile(resolvedPath, params.content, "utf8");

      return {
        content: [
          {
            type: "text",
            text: `Wrote ${byteLength} bytes to ${params.filePath}`,
          },
        ],
        details: {
          filePath: params.filePath,
          resolvedPath,
          byteLength,
        },
      };
    },
  };
};
