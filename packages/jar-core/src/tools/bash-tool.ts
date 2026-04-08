import { randomUUID } from "node:crypto";
import path from "node:path";

import { Type, type TSchema } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  execaCommand,
} from "execa";

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
  background: Type.Optional(
    Type.Boolean({
      description:
        "Start the command in the background and use bash_output or bash_kill with the returned shell id",
    }),
  ),
});

const bashOutputParameters: TSchema = Type.Object({
  shellId: Type.String({
    description: "Shell id returned by a background bash command",
    minLength: 1,
  }),
  offset: Type.Optional(
    Type.Integer({
      description: "Character offset into the buffered combined output",
      minimum: 0,
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: "Maximum number of characters to read from the offset",
      minimum: 1,
    }),
  ),
});

const bashKillParameters: TSchema = Type.Object({
  shellId: Type.String({
    description: "Shell id returned by a background bash command",
    minLength: 1,
  }),
});

type BashParameters = {
  command: string;
  workingDirectory?: string;
  background?: boolean;
};

type BashOutputParameters = {
  shellId: string;
  offset?: number;
  limit?: number;
};

type BashKillParameters = {
  shellId: string;
};

type ManagedShellStatus =
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "timed_out"
  | "buffer_exceeded";

type ExecaShellResult = {
  all?: string;
  exitCode: number;
  signal?: string;
  failed: boolean;
  timedOut: boolean;
  isMaxBuffer: boolean;
  stdout?: string;
  stderr?: string;
};

type ManagedSubprocess = {
  all: NodeJS.ReadableStream | undefined;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  wait: () => Promise<ExecaShellResult>;
};

type ManagedShell = {
  shellId: string;
  command: string;
  workingDirectory: string;
  resolvedWorkingDirectory: string;
  subprocess: ManagedSubprocess;
  output: string;
  exitCode: number | undefined;
  signal: string | undefined;
  failed: boolean;
  timedOut: boolean;
  isMaxBuffer: boolean;
  status: ManagedShellStatus;
  stdout: string | undefined;
  stderr: string | undefined;
  completion: Promise<void>;
  requestedStop: ManagedShellStatus | undefined;
};

type ShellSnapshot = {
  shellId: string;
  command: string;
  workingDirectory: string;
  resolvedWorkingDirectory: string;
  output: string;
  exitCode: number | undefined;
  signal: string | undefined;
  failed: boolean;
  timedOut: boolean;
  isMaxBuffer: boolean;
  status: ManagedShellStatus;
  stdout: string | undefined;
  stderr: string | undefined;
};

type ShellManager = {
  getShellSnapshot: (shellId: string) => Promise<ShellSnapshot>;
  startShell: (params: {
    command: string;
    workingDirectory: string;
    resolvedWorkingDirectory: string;
    background: boolean;
  }) => Promise<ShellSnapshot>;
  terminateShell: (shellId: string) => Promise<ShellSnapshot>;
};

const KILL_ESCALATION_DELAY_MS = 1_000;

export const createBashTools = (options: ToolOptions): AgentTool[] => {
  const shellManager = createShellManager(options);

  return [
    createBashTool(options, shellManager) as AgentTool,
    createBashOutputTool(shellManager) as AgentTool,
    createBashKillTool(shellManager) as AgentTool,
  ];
};

export const createBashTool = (
  options: ToolOptions,
  shellManager: ShellManager = createShellManager(options),
): AgentTool<typeof bashParameters> => {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Execute a command starting inside the configured workspace root. Commands can also be left running in the background for later polling.",
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
      const shell = await shellManager.startShell({
        command: params.command,
        workingDirectory,
        resolvedWorkingDirectory,
        background: params.background ?? false,
      });

      if (params.background) {
        return {
          content: [
            {
              type: "text",
              text: [
                `Command: ${params.command}`,
                `Working directory: ${workingDirectory}`,
                "Status: running",
                `Shell id: ${shell.shellId}`,
              ].join("\n"),
            },
          ],
          details: {
            command: params.command,
            workingDirectory,
            resolvedWorkingDirectory,
            shellId: shell.shellId,
            exitCode: shell.exitCode,
            failed: shell.failed,
            timedOut: shell.timedOut,
            isMaxBuffer: shell.isMaxBuffer,
            stdout: shell.stdout,
            stderr: shell.stderr,
            output: shell.output,
            status: shell.status,
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: formatShellSummary(shell),
          },
        ],
        details: {
          command: params.command,
          workingDirectory,
          resolvedWorkingDirectory,
          shellId: shell.shellId,
          exitCode: shell.exitCode,
          failed: shell.failed,
          timedOut: shell.timedOut,
          isMaxBuffer: shell.isMaxBuffer,
          stdout: shell.stdout,
          stderr: shell.stderr,
          output: shell.output,
          signal: shell.signal,
          status: shell.status,
        },
      };
    },
  };
};

export const createBashOutputTool = (
  shellManager: ShellManager,
): AgentTool<typeof bashOutputParameters> => {
  return {
    name: "bash_output",
    label: "Bash Output",
    description:
      "Read buffered combined stdout and stderr from a background bash command.",
    parameters: bashOutputParameters,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as BashOutputParameters;
      const shell = await shellManager.getShellSnapshot(params.shellId);
      const start = clampRange(params.offset ?? 0, shell.output.length);
      const end =
        params.limit === undefined
          ? shell.output.length
          : clampRange(start + params.limit, shell.output.length);
      const output = shell.output.slice(start, end);

      return {
        content: [
          {
            type: "text",
            text: [
              `Shell id: ${shell.shellId}`,
              `Status: ${shell.status}`,
              `Exit code: ${shell.exitCode ?? "null"}`,
              `Next offset: ${end}`,
              "",
              output.length > 0 ? output : "(no output)",
            ].join("\n"),
          },
        ],
        details: {
          shellId: shell.shellId,
          status: shell.status,
          exitCode: shell.exitCode,
          nextOffset: end,
          output,
          command: shell.command,
          workingDirectory: shell.workingDirectory,
          resolvedWorkingDirectory: shell.resolvedWorkingDirectory,
          signal: shell.signal,
          timedOut: shell.timedOut,
          isMaxBuffer: shell.isMaxBuffer,
        },
      };
    },
  };
};

export const createBashKillTool = (
  shellManager: ShellManager,
): AgentTool<typeof bashKillParameters> => {
  return {
    name: "bash_kill",
    label: "Bash Kill",
    description:
      "Terminate a background bash command and return its final status.",
    parameters: bashKillParameters,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as BashKillParameters;
      const shell = await shellManager.terminateShell(params.shellId);

      return {
        content: [
          {
            type: "text",
            text: [
              `Shell id: ${shell.shellId}`,
              `Status: ${shell.status}`,
              `Exit code: ${shell.exitCode ?? "null"}`,
            ].join("\n"),
          },
        ],
        details: {
          shellId: shell.shellId,
          status: shell.status,
          exitCode: shell.exitCode,
          command: shell.command,
          workingDirectory: shell.workingDirectory,
          resolvedWorkingDirectory: shell.resolvedWorkingDirectory,
          signal: shell.signal,
          timedOut: shell.timedOut,
          isMaxBuffer: shell.isMaxBuffer,
        },
      };
    },
  };
};

const createShellManager = (options: ToolOptions): ShellManager => {
  const shells = new Map<string, ManagedShell>();

  return {
    getShellSnapshot: async (shellId) => {
      const shell = getRequiredShell(shells, shellId);
      if (shell.status !== "running") {
        await shell.completion;
      }
      return toShellSnapshot(shell);
    },
    startShell: async (params) => {
      const shellId = randomUUID();
      const subprocess = createManagedSubprocess(execaCommand(params.command, {
        all: true,
        cwd: params.resolvedWorkingDirectory,
        maxBuffer: options.maxCommandOutputBytes,
        reject: false,
        shell: true,
        stripFinalNewline: false,
        ...(params.background
          ? {}
          : { timeout: options.commandTimeoutMs }),
      }));
      const shell: ManagedShell = {
        shellId,
        command: params.command,
        workingDirectory: params.workingDirectory,
        resolvedWorkingDirectory: params.resolvedWorkingDirectory,
        subprocess,
        output: "",
        exitCode: undefined,
        signal: undefined,
        failed: false,
        timedOut: false,
        isMaxBuffer: false,
        status: "running",
        stdout: undefined,
        stderr: undefined,
        completion: Promise.resolve(),
        requestedStop: undefined,
      };

      shell.completion = observeShell(shell);
      shells.set(shellId, shell);

      if (!params.background) {
        await shell.completion;
      }

      return toShellSnapshot(shell);
    },
    terminateShell: async (shellId) => {
      const shell = getRequiredShell(shells, shellId);

      if (shell.status === "running") {
        shell.requestedStop = "killed";
        shell.subprocess.kill("SIGTERM");

        const escalationTimer = setTimeout(() => {
          if (shell.status === "running") {
            shell.subprocess.kill("SIGKILL");
          }
        }, KILL_ESCALATION_DELAY_MS);
        escalationTimer.unref?.();

        await shell.completion.finally(() => {
          clearTimeout(escalationTimer);
        });
      } else {
        await shell.completion;
      }

      return toShellSnapshot(shell);
    },
  };
};

const createManagedSubprocess = (
  subprocess: {
    all: NodeJS.ReadableStream | undefined;
    kill: (signal?: NodeJS.Signals | number) => boolean;
    then: PromiseLike<Partial<ExecaShellResult>>["then"];
  },
): ManagedSubprocess => {
  return {
    all: subprocess.all,
    kill: (signal) => subprocess.kill(signal),
    wait: async () => normalizeShellResult(await Promise.resolve(subprocess)),
  };
};

const normalizeShellResult = (
  result: Partial<ExecaShellResult>,
): ExecaShellResult => {
  return {
    exitCode: result.exitCode ?? 0,
    failed: result.failed === true,
    timedOut: result.timedOut === true,
    isMaxBuffer: result.isMaxBuffer === true,
    ...(typeof result.all === "string" ? { all: result.all } : {}),
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    ...(typeof result.stdout === "string" ? { stdout: result.stdout } : {}),
    ...(typeof result.stderr === "string" ? { stderr: result.stderr } : {}),
  };
};

const observeShell = async (shell: ManagedShell): Promise<void> => {
  const allOutput = shell.subprocess.all;
  if (allOutput !== undefined) {
    allOutput.setEncoding("utf8");
    allOutput.on("data", (chunk) => {
      shell.output += chunk;
    });
  }

  try {
    const result = await shell.subprocess.wait();
    updateShellFromResult(shell, result);
  } catch (error) {
    updateShellFromFailure(shell, error);
  }
};

const updateShellFromResult = (
  shell: ManagedShell,
  result: ExecaShellResult,
): void => {
  shell.output =
    typeof result.all === "string"
      ? result.all
      : shell.output;
  shell.exitCode = result.exitCode;
  shell.signal = result.signal;
  shell.failed = result.failed;
  shell.timedOut = result.timedOut;
  shell.isMaxBuffer = result.isMaxBuffer;
  shell.stdout = typeof result.stdout === "string" ? result.stdout : undefined;
  shell.stderr = typeof result.stderr === "string" ? result.stderr : undefined;

  if (shell.requestedStop !== undefined) {
    shell.status = shell.requestedStop;
    shell.failed = true;
    return;
  }

  if (result.timedOut) {
    shell.status = "timed_out";
    return;
  }

  if (result.isMaxBuffer) {
    shell.status = "buffer_exceeded";
    return;
  }

  shell.status = result.exitCode === 0 ? "completed" : "failed";
};

const updateShellFromFailure = (shell: ManagedShell, error: unknown): void => {
  const fallbackMessage = error instanceof Error ? error.message : String(error);
  const errorLike = error as Partial<ExecaShellResult>;

  shell.output =
    typeof errorLike.all === "string"
      ? errorLike.all
      : fallbackMessage;
  shell.exitCode = errorLike.exitCode;
  shell.signal = errorLike.signal;
  shell.failed = true;
  shell.timedOut = errorLike.timedOut === true;
  shell.isMaxBuffer = errorLike.isMaxBuffer === true;
  shell.stdout = typeof errorLike.stdout === "string" ? errorLike.stdout : undefined;
  shell.stderr = typeof errorLike.stderr === "string" ? errorLike.stderr : undefined;

  if (shell.requestedStop !== undefined) {
    shell.status = shell.requestedStop;
    return;
  }

  if (shell.timedOut) {
    shell.status = "timed_out";
    return;
  }

  if (shell.isMaxBuffer) {
    shell.status = "buffer_exceeded";
    return;
  }

  shell.status = "failed";
};

const getRequiredShell = (
  shells: Map<string, ManagedShell>,
  shellId: string,
): ManagedShell => {
  const shell = shells.get(shellId);
  if (shell === undefined) {
    throw new Error(`Background shell "${shellId}" was not found`);
  }

  return shell;
};

const toShellSnapshot = (shell: ManagedShell): ShellSnapshot => {
  return {
    shellId: shell.shellId,
    command: shell.command,
    workingDirectory: shell.workingDirectory,
    resolvedWorkingDirectory: shell.resolvedWorkingDirectory,
    output: shell.output,
    exitCode: shell.exitCode,
    signal: shell.signal,
    failed: shell.failed,
    timedOut: shell.timedOut,
    isMaxBuffer: shell.isMaxBuffer,
    status: shell.status,
    stdout: shell.stdout,
    stderr: shell.stderr,
  };
};

const formatShellSummary = (shell: ShellSnapshot): string => {
  return [
    `Command: ${shell.command}`,
    `Working directory: ${shell.workingDirectory}`,
    `Status: ${shell.status}`,
    `Exit code: ${shell.exitCode ?? "none"}`,
    shell.signal === undefined ? undefined : `Signal: ${shell.signal}`,
    "",
    shell.output.length > 0 ? shell.output : "Command produced no output.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
};

const clampRange = (value: number, max: number): number => {
  return Math.max(0, Math.min(value, max));
};
