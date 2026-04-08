import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createBashTools } from "./tools/bash-tool.js";
import { createReadFileTool, createWriteFileTool } from "./tools/file-tools.js";
import { createApplyPatchTool } from "./tools/patch-tool.js";
import { createWebFetchTool } from "./tools/web-fetch-tool.js";
import type { ToolOptions } from "./tools/shared.js";

export type { ToolOptions } from "./tools/shared.js";

export const createDefaultTools = (options: ToolOptions): AgentTool[] => {
  return [
    createReadFileTool(options) as AgentTool,
    createWriteFileTool(options) as AgentTool,
    createApplyPatchTool(options) as AgentTool,
    ...createBashTools(options),
    createWebFetchTool(options) as AgentTool,
  ];
};