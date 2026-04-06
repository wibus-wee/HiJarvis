import type { AgentEvent } from "@mariozechner/pi-agent-core";

type CliRenderWriters = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
};

export const renderAgentEvent = (
  event: AgentEvent,
  writers: CliRenderWriters,
): void => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        writers.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
    case "tool_execution_start":
      writers.stderr.write(
        `\n[tool:start] ${event.toolName} ${JSON.stringify(event.args)}\n`,
      );
      break;
    case "tool_execution_end":
      writers.stderr.write(`[tool:end] ${event.toolName}\n`);
      break;
    default:
      break;
  }
};
