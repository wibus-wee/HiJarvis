import type { Message } from "@mariozechner/pi-ai";

import { extractToolResultText } from "./assembly.js";
import type { CompactionArtifact, CompactionRuntime } from "./types.js";

export const extractCompactionArtifacts = (
  messages: Message[],
  runtime: CompactionRuntime,
): CompactionArtifact[] => {
  const artifacts: CompactionArtifact[] = [];

  const lastToolResult = [...messages].reverse().find((message) => message.role === "toolResult");
  if (lastToolResult && lastToolResult.role === "toolResult") {
    const text = extractToolResultText(lastToolResult).trim();
    if (text.length > 0) {
      artifacts.push({
        kind: "tool_state",
        label: `Last tool result: ${lastToolResult.toolName}`,
        content: text.slice(0, 1200),
      });
    }
  }

  if (runtime.recentSkillNames && runtime.recentSkillNames.length > 0) {
    artifacts.push({
      kind: "skill_state",
      label: "Recently injected skills",
      content: runtime.recentSkillNames.join(", "),
    });
  }

  return artifacts;
};

export const renderArtifactMessages = (artifacts: CompactionArtifact[]): Message[] => {
  return artifacts.map((artifact) => ({
    role: "user",
    content: [
      "Structured restoration state from the previous compaction:",
      `[${artifact.kind}] ${artifact.label}`,
      artifact.content,
    ].join("\n"),
    timestamp: Date.now(),
  }));
};
