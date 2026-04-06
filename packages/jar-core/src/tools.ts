import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createBashTool } from "./tools/bash-tool.js";
import { createReadFileTool, createWriteFileTool } from "./tools/file-tools.js";
import { createApplyPatchTool } from "./tools/patch-tool.js";
import type { ToolOptions } from "./tools/shared.js";

export type { ToolOptions } from "./tools/shared.js";

export const createTools = (options: ToolOptions): AgentTool[] => {
  return [
    createReadFileTool(options) as AgentTool,
    createWriteFileTool(options) as AgentTool,
    createApplyPatchTool(options) as AgentTool,
    createBashTool(options) as AgentTool,
  ];
};
