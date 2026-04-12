import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { MemoryProvider } from "./memory/index.js";
import { createMemoryTools as createScopedMemoryTools } from "./memory/index.js";
import { createBashTools } from "./tools/bash-tool.js";
import { createReadFileTool, createWriteFileTool } from "./tools/file-tools.js";
import { createApplyPatchTool } from "./tools/patch-tool.js";
import { createWebFetchTool } from "./tools/web-fetch-tool.js";
import { createWebSearchTool } from "./tools/web-search-tool.js";
import type { ToolOptions } from "./tools/shared.js";

export type { ToolOptions } from "./tools/shared.js";

export const createDefaultTools = (options: ToolOptions): AgentTool[] => {
  return [
    createReadFileTool(options) as AgentTool,
    createWriteFileTool(options) as AgentTool,
    createApplyPatchTool(options) as AgentTool,
    ...createBashTools(options),
    createWebFetchTool(options) as AgentTool,
    createWebSearchTool(options) as AgentTool,
  ];
};

export const createMemoryTools = (
  entityId: string,
  provider: MemoryProvider,
): AgentTool[] => {
  return createScopedMemoryTools(entityId, provider);
};
