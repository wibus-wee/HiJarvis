/**
 * memory-workspace plugin
 *
 * MEMORY.md + notes/ 风格的持久化记忆插件。
 *
 * - 每次进程启动时，自动将 MEMORY.md 注入 system prompt（compaction 安全）
 * - 提供 4 个工具让 agent 读写 notes/ 目录和更新 MEMORY.md
 * - 与现有 JSONL 记忆系统共存，互不影响
 *
 * 目录结构：
 *   {dir}/{entityId}/
 *   ├── MEMORY.md            ← 自动注入 system prompt
 *   └── notes/
 *       ├── user-prefs.md
 *       └── work-log.md
 *
 * jar.toml 配置：
 *   [[plugins]]
 *   module = "./packages/jar-core/src/memory/workspace-plugin.ts"
 *
 *   [plugins.config]
 *   dir = ".jar/memory"   # 可选，默认 ".jar/memory"
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

import { resolveEntityMemoryScope } from "../execution/resolve-tools.js";
import type { JarPlugin, PluginFactory } from "../plugins/types.js";

export const createPlugin: PluginFactory = (pluginConfig) => {
  const baseDir = (pluginConfig["dir"] as string | undefined) ?? ".jar/memory";

  const plugin: JarPlugin = {
    name: "memory-workspace",

    async install({ config, hooks }) {
      const configDir = path.dirname(config.configFilePath);
      const workspaceRoot = path.resolve(configDir, baseDir);

      // ── 1. Static overlay: install 时读取默认 entity 的 MEMORY.md ──────────
      // entityId 是 per-request 的，但 overlay 在 install 时确定。
      // 使用 config 中第一个 entity 作为默认值。进程重启后会读取最新内容。
      const defaultEntityId = Object.keys(config.entities)[0] ?? "default";
      const memoryMdPath = path.join(workspaceRoot, defaultEntityId, "MEMORY.md");

      const overlays = [];
      try {
        const content = await readFile(memoryMdPath, "utf8");
        const trimmed = content.trim();
        if (trimmed.length > 0) {
          overlays.push({
            title: "Memory & Knowledge",
            body: trimmed,
          });
        }
      } catch {
        // MEMORY.md 不存在时静默跳过，首次使用时正常
      }

      // ── 2. tools:resolve hook: per-request 注入 workspace 工具 ──────────────
      hooks.register({
        point: "tools:resolve",
        name: "memory-workspace:tools",
        handler: async ({ config: cfg, command, tools }) => {
          const entityId = resolveEntityMemoryScope(cfg, command);
          const entityDir = path.join(workspaceRoot, entityId);
          const notesDir = path.join(entityDir, "notes");
          const workspaceTools = createWorkspaceTools(entityDir, notesDir);
          return { tools: [...tools, ...workspaceTools] };
        },
      });

      return { overlays };
    },
  };

  return plugin;
};

// ── Tool definitions ──────────────────────────────────────────────────────────

function createWorkspaceTools(workspaceDir: string, notesDir: string): AgentTool[] {
  return [
    createReadNoteTool(notesDir),
    createWriteNoteTool(notesDir),
    createListNotesTool(notesDir),
    createUpdateMemoryIndexTool(workspaceDir),
  ];
}

const createReadNoteTool = (notesDir: string): AgentTool => ({
  name: "workspace_read_note",
  label: "Read Note",
  description:
    "Read a note file from the workspace notes/ directory. " +
    "Use this to recall detailed knowledge you previously wrote down.",
  parameters: Type.Object(
    {
      filename: Type.String({
        description: "Filename within notes/ (e.g. user-prefs.md). Do not include path separators.",
        minLength: 1,
      }),
    },
    { additionalProperties: false },
  ),
  execute: async (_toolCallId, rawParams) => {
    const { filename } = rawParams as { filename: string };
    const filePath = path.join(notesDir, path.basename(filename));
    try {
      const content = await readFile(filePath, "utf8");
      return {
        content: [{ type: "text", text: content }],
        details: { filename, path: filePath },
      };
    } catch {
      return {
        content: [{ type: "text", text: `Note "${filename}" does not exist yet.` }],
        details: { filename },
      };
    }
  },
});

const createWriteNoteTool = (notesDir: string): AgentTool => ({
  name: "workspace_write_note",
  label: "Write Note",
  description:
    "Write or overwrite a note file in the workspace notes/ directory. " +
    "Use this to record knowledge, preferences, or context you want to remember later.",
  parameters: Type.Object(
    {
      filename: Type.String({
        description: "Filename within notes/ (e.g. user-prefs.md). Do not include path separators.",
        minLength: 1,
      }),
      content: Type.String({
        description: "Full content to write to the note file.",
        minLength: 1,
      }),
    },
    { additionalProperties: false },
  ),
  execute: async (_toolCallId, rawParams) => {
    const { filename, content } = rawParams as { filename: string; content: string };
    await mkdir(notesDir, { recursive: true });
    const filePath = path.join(notesDir, path.basename(filename));
    await writeFile(filePath, content, "utf8");
    return {
      content: [{ type: "text", text: `Written to notes/${path.basename(filename)}.` }],
      details: { filename: path.basename(filename), path: filePath, bytes: content.length },
    };
  },
});

const createListNotesTool = (notesDir: string): AgentTool => ({
  name: "workspace_list_notes",
  label: "List Notes",
  description:
    "List all note files in the workspace notes/ directory. " +
    "Use this to discover what knowledge files you have written.",
  parameters: Type.Object({}, { additionalProperties: false }),
  execute: async (_toolCallId, _rawParams) => {
    try {
      const files = await readdir(notesDir);
      const mdFiles = files.filter((f) => f.endsWith(".md"));
      const text =
        mdFiles.length === 0
          ? "No notes yet. Use workspace_write_note to create your first note."
          : mdFiles.join("\n");
      return {
        content: [{ type: "text", text }],
        details: { files: mdFiles, count: mdFiles.length },
      };
    } catch {
      return {
        content: [
          {
            type: "text",
            text: "Notes directory does not exist yet. Use workspace_write_note to create your first note.",
          },
        ],
        details: { files: [], count: 0 },
      };
    }
  },
});

const createUpdateMemoryIndexTool = (workspaceDir: string): AgentTool => ({
  name: "workspace_update_memory_index",
  label: "Update Memory Index",
  description:
    "Overwrite MEMORY.md with new content. " +
    "MEMORY.md is your persistent memory index — it is automatically injected into your system prompt on every startup. " +
    "Keep it concise but comprehensive: use it as a table of contents pointing to your notes/ files. " +
    "Update it whenever you add new notes or learn something important.",
  parameters: Type.Object(
    {
      content: Type.String({
        description: "Full new content for MEMORY.md.",
        minLength: 1,
      }),
    },
    { additionalProperties: false },
  ),
  execute: async (_toolCallId, rawParams) => {
    const { content } = rawParams as { content: string };
    await mkdir(workspaceDir, { recursive: true });
    const memPath = path.join(workspaceDir, "MEMORY.md");
    await writeFile(memPath, content, "utf8");
    return {
      content: [
        {
          type: "text",
          text: "MEMORY.md updated. The new content will be injected into your system prompt on next startup.",
        },
      ],
      details: { path: memPath, bytes: content.length },
    };
  },
});
