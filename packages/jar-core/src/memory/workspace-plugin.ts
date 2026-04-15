/**
 * memory-workspace plugin
 *
 * This plugin implements the classic MEMORY.md + notes/ workflow as prompt
 * behavior, not as a separate tool interface:
 * - a static Workspace & Memory guide is injected into the system prompt
 * - the current entity's MEMORY.md is re-read on every request and prepended to
 *   the current turn prompt
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { resolveEntityMemoryScope } from "../execution/resolve-tools.js";
import type { PromptSection } from "../prompt-builder.js";
import type { PromptInput } from "../prompt-executor.js";
import type { JarPlugin, PluginFactory } from "../plugins/types.js";

const WORKSPACE_MEMORY_GUIDE = String.raw`
Your working directory (cwd) is your **persistent workspace**. Everything you write here survives across sessions.

### MEMORY.md -- Your Memory Index (CRITICAL)
\`MEMORY.md\` is the **entry point** to all your knowledge. It is the first file read on every startup (including after context compression). Structure it as an index that points to everything you know. This file is called \`MEMORY.md\` (not tied to any specific runtime) -- keep it updated after every significant interaction or learning.

\`\`\`markdown
# <Your Name>

## Role
<your role definition, evolved over time>

## Key Knowledge
- Read notes/user-preferences.md for user preferences and conventions
- Read notes/channels.md for what each channel is about and ongoing work
- Read notes/domain.md for domain-specific knowledge and conventions
- ...

## Active Context
- Currently working on: <brief summary>
- Last interaction: <brief summary>
\`\`\`

### What to memorize

**Actively observe and record** the following kinds of knowledge as you encounter them in conversations:

1. **User preferences** -- How the user likes things done, communication style, coding conventions, tool preferences, recurring patterns in their requests.
2. **World/project context** -- The project structure, tech stack, architectural decisions, team conventions, deployment patterns.
3. **Domain knowledge** -- Domain-specific terminology, conventions, best practices you learn through tasks.
4. **Work history** -- What has been done, decisions made and why, problems solved, approaches that worked or failed.
5. **Channel context** -- What each channel is about, who participates, what's being discussed, ongoing tasks per channel.
6. **Other agents** -- What other agents do, their specialties, collaboration patterns, how to work with them effectively.

### How to organize memory

- **MEMORY.md** is always the index. Keep it concise but comprehensive as a table of contents.
- Create a \`notes/\` directory for detailed knowledge files. Use descriptive names:
  - \`notes/user-preferences.md\` -- User's preferences and conventions
  - \`notes/channels.md\` -- Summary of each channel and its purpose
  - \`notes/work-log.md\` -- Important decisions and completed work
  - \`notes/<domain>.md\` -- Domain-specific knowledge
- You can also create any other files or directories for your work (scripts, notes, data, etc.)
- **Update notes proactively** -- Don't wait to be asked. When you learn something important, write it down.
- **Keep MEMORY.md current** -- After updating notes, update the index in MEMORY.md if new files were added.

### Compaction safety (CRITICAL)

Your context will be periodically compressed to stay within limits. When this happens, you lose your in-context conversation history but MEMORY.md is always re-read. Therefore:

- **MEMORY.md must be self-sufficient as a recovery point.** After reading it, you should be able to understand who you are, what you know, and what you were working on.
- **Before a long task**, write a brief "Active Context" note in MEMORY.md so you can resume if interrupted mid-task.
- **After completing work**, update your notes and MEMORY.md index so nothing is lost.
- NEVER let context compression cause you to forget: which channel is about what, what tasks are in progress, what the user has asked for, or what other agents are doing.
`;

export const createPlugin: PluginFactory = (pluginConfig) => {
  const baseDir = (pluginConfig["dir"] as string | undefined) ?? ".jar/memory";

  const plugin: JarPlugin = {
    name: "memory-workspace",

    async install({ config, hooks }) {
      const configDir = path.dirname(config.configFilePath);
      const workspaceRoot = path.resolve(configDir, baseDir);

      hooks.register({
        point: "prompt:transform",
        name: "memory-workspace:prompt",
        handler: async ({ config: cfg, command, prompt, skillTriggerText }) => {
          const entityId = resolveEntityMemoryScope(cfg, command);
          const memoryMdPath = path.join(workspaceRoot, entityId, "MEMORY.md");

          try {
            const content = await readFile(memoryMdPath, "utf8");
            const trimmed = content.trim();
            if (trimmed.length === 0) {
              return { prompt, skillTriggerText };
            }

            return {
              prompt: prependMemoryPrompt(prompt, trimmed),
              skillTriggerText,
            };
          } catch {
            return { prompt, skillTriggerText };
          }
        },
      });

      const overlays: PromptSection[] = [
        {
          title: "Workspace & Memory",
          body: WORKSPACE_MEMORY_GUIDE.trim(),
        },
      ];

      return { overlays };
    },
  };

  return plugin;
};

const prependMemoryPrompt = (prompt: PromptInput, memory: string): PromptInput => {
  const block = ["MEMORY.md:", memory].join("\n\n");

  if (typeof prompt === "string") {
    return `${block}\n\n${prompt}`.trim();
  }

  if (Array.isArray(prompt)) {
    return prependToMessages(prompt, block);
  }

  return prependToMessages([prompt], block);
};

const prependToMessages = (messages: AgentMessage[], text: string): AgentMessage[] => {
  if (messages.length === 0) {
    return [{ role: "user", content: text, timestamp: Date.now() }];
  }

  const nextMessages = messages.slice();
  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    const message = nextMessages[index];
    if (!message || !("role" in message) || message.role !== "user") {
      continue;
    }

    nextMessages[index] = prependToUserMessage(message, text);
    return nextMessages;
  }

  nextMessages.unshift({ role: "user", content: text, timestamp: Date.now() });
  return nextMessages;
};

const prependToUserMessage = (
  message: Extract<AgentMessage, { role: "user" }>,
  text: string,
): Extract<AgentMessage, { role: "user" }> => {
  if (typeof message.content === "string") {
    return {
      ...message,
      content: `${text}\n\n${message.content}`.trim(),
    };
  }

  let injected = false;
  const nextContent = message.content.map((item) => {
    if (item.type !== "text" || injected) {
      return item;
    }

    injected = true;
    return {
      ...item,
      text: `${text}\n\n${item.text}`.trim(),
    };
  });

  if (injected) {
    return {
      ...message,
      content: nextContent,
    };
  }

  return {
    ...message,
    content: [{ type: "text", text }, ...message.content],
  };
};
