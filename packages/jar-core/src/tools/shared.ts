import path from "node:path";

import type { KnownProvider } from "@mariozechner/pi-ai";

export type ToolOptions = {
  provider: KnownProvider;
  model: string;
  providerBaseUrl?: string;
  providerApiKey?: string;
  workspaceRoot: string;
  maxFileBytes: number;
  commandTimeoutMs: number;
  maxCommandOutputBytes: number;
  webRequestTimeoutMs: number;
  maxWebResponseBytes: number;
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
