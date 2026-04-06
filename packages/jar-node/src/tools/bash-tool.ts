import path from "node:path";

import { Type, type TSchema } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { execaCommand } from "execa";

import type { ToolOptions } from "./shared.js";
import { resolveWorkspacePath } from "./shared.js";

const bashParameters: TSchema = Type.Object({
  command: Type.String({
    description:
      "Shell command to execute inside the workspace root, such as 'git status --short'",
    minLength: 1,
  }),
  workingDirectory: Type.Optional(
    Type.String({
      description: "Relative working directory inside the workspace root",
      minLength: 1,
    }),
  ),
});

type BashParameters = {
  command: string;
  workingDirectory?: string;
};

export const createBashTool = (
  options: ToolOptions,
): AgentTool<typeof bashParameters> => {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Execute a command starting inside the configured workspace root and return the combined stdout and stderr output.",
    parameters: bashParameters,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as BashParameters;
      const resolvedWorkingDirectory = resolveWorkspacePath(
        options.workspaceRoot,
        params.workingDirectory ?? ".",
        { allowWorkspaceRoot: true },
      );
      const workingDirectory =
        path.relative(options.workspaceRoot, resolvedWorkingDirectory) || ".";

      const result = await execaCommand(params.command, {
        all: true,
        cwd: resolvedWorkingDirectory,
        maxBuffer: options.maxCommandOutputBytes,
        reject: false,
        shell: true,
        stripFinalNewline: false,
        timeout: options.commandTimeoutMs,
      });

      const output =
        result.all && result.all.length > 0
          ? result.all
          : result.shortMessage ?? "Command produced no output.";
      const exitCode = result.exitCode ?? "none";
      const status = result.failed ? "failed" : "completed";

      return {
        content: [
          {
            type: "text",
            text: [
              `Command: ${params.command}`,
              `Working directory: ${workingDirectory}`,
              `Status: ${status}`,
              `Exit code: ${exitCode}`,
              "",
              output,
            ].join("\n"),
          },
        ],
        details: {
          command: params.command,
          workingDirectory,
          resolvedWorkingDirectory,
          exitCode: result.exitCode,
          failed: result.failed,
          timedOut: result.timedOut,
          isMaxBuffer: result.isMaxBuffer,
          stdout: result.stdout,
          stderr: result.stderr,
          output,
        },
      };
    },
  };
};
