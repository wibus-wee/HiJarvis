import path from "node:path";

import type { Provider } from "@mariozechner/pi-ai";

export type ToolOptions = {
  provider: Provider;
  model: string;
  providerBaseUrl?: string;
  providerApiKey?: string;
  workspaceRoot: string;
  maxFileBytes: number;
  commandTimeoutMs: number;
  maxCommandOutputBytes: number;
  webRequestTimeoutMs: number;
  maxWebResponseBytes: number;
  maxConcurrentShells?: number;
};

export const validateToolOptions = (options: ToolOptions): ToolOptions => {
  const checks: Array<[number, string]> = [
    [options.maxFileBytes, "maxFileBytes"],
    [options.commandTimeoutMs, "commandTimeoutMs"],
    [options.maxCommandOutputBytes, "maxCommandOutputBytes"],
    [options.webRequestTimeoutMs, "webRequestTimeoutMs"],
    [options.maxWebResponseBytes, "maxWebResponseBytes"],
  ];

  for (const [value, label] of checks) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${label} must be a positive number`);
    }
  }

  if (options.maxConcurrentShells !== undefined) {
    if (!Number.isFinite(options.maxConcurrentShells) || options.maxConcurrentShells <= 0) {
      throw new Error("maxConcurrentShells must be a positive number");
    }
  }

  return options;
};

export const resolveWorkspacePath = (
  workspaceRoot: string,
  inputPath: string,
  options: { allowWorkspaceRoot?: boolean } = {},
): string => {
  if (path.isAbsolute(inputPath)) {
    throw new Error(`Path "${inputPath}" must be relative to the configured workspace root`);
  }

  const resolvedPath = path.resolve(workspaceRoot, inputPath);
  const relativePath = path.relative(workspaceRoot, resolvedPath);

  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath) ||
    (!options.allowWorkspaceRoot && relativePath.length === 0)
  ) {
    throw new Error(`Path "${inputPath}" is outside the configured workspace root`);
  }

  return resolvedPath;
};
