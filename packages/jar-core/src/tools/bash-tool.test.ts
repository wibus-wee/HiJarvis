import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { AgentTool } from "@mariozechner/pi-agent-core";

import { createBashTools } from "./bash-tool.js";
import type { ToolOptions } from "./shared.js";

const toolOptions: ToolOptions = {
  workspaceRoot: process.cwd(),
  maxFileBytes: 32_768,
  commandTimeoutMs: 1_500,
  maxCommandOutputBytes: 32_768,
  webRequestTimeoutMs: 15_000,
  maxWebResponseBytes: 131_072,
};

type ToolResult = Awaited<ReturnType<AgentTool["execute"]>>;

test("bash executes a foreground command and returns the combined output", async () => {
  const tools = createBashTools(toolOptions);
  const bashTool = getTool(tools, "bash");

  const result = await bashTool.execute("call-1", {
    command:
      "node -e \"process.stdout.write('hello\\\\n'); process.stderr.write('warn\\\\n')\"",
  });

  const text = getTextContent(result);
  assert.match(text, /Status: completed/);
  assert.match(text, /hello/);
  assert.match(text, /warn/);
  assert.equal(result.details?.status, "completed");
});

test("bash.output reads background command output incrementally", async () => {
  const tools = createBashTools(toolOptions);
  const bashTool = getTool(tools, "bash");
  const outputTool = getTool(tools, "bash_output");

  const startResult = await bashTool.execute("call-1", {
    command:
      "node -e \"process.stdout.write('alpha\\\\n'); setTimeout(() => process.stdout.write('beta\\\\n'), 40); setTimeout(() => process.exit(0), 90)\"",
    background: true,
  });

  const shellId = getShellId(startResult);
  await delay(160);

  const firstChunk = await outputTool.execute("call-2", {
    shellId,
    offset: 0,
    limit: 6,
  });
  assert.equal(firstChunk.details?.nextOffset, 6);
  assert.equal(firstChunk.details?.output, "alpha\n");

  const secondChunk = await outputTool.execute("call-3", {
    shellId,
    offset: 6,
  });
  assert.equal(secondChunk.details?.status, "completed");
  assert.equal(secondChunk.details?.output, "beta\n");
  assert.equal(secondChunk.details?.nextOffset, "alpha\nbeta\n".length);
});

test("bash.kill stops a background command and exposes the final status", async () => {
  const tools = createBashTools(toolOptions);
  const bashTool = getTool(tools, "bash");
  const killTool = getTool(tools, "bash_kill");
  const outputTool = getTool(tools, "bash_output");

  const startResult = await bashTool.execute("call-1", {
    command:
      "node -e \"process.stdout.write('tick\\\\n'); setInterval(() => process.stdout.write('tick\\\\n'), 25)\"",
    background: true,
  });

  const shellId = getShellId(startResult);
  await delay(80);

  const killResult = await killTool.execute("call-2", { shellId });
  assert.equal(killResult.details?.status, "killed");

  const outputResult = await outputTool.execute("call-3", { shellId, offset: 0 });
  assert.equal(outputResult.details?.status, "killed");
  assert.match(String(outputResult.details?.output), /tick/);
});

const getTool = (tools: AgentTool[], name: string): AgentTool => {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Expected tool "${name}" to be registered`);
  return tool;
};

const getTextContent = (result: ToolResult): string => {
  const firstContent = result.content[0];
  assert.ok(firstContent?.type === "text");
  return firstContent.text;
};

const getShellId = (result: ToolResult): string => {
  const shellId = result.details?.shellId;
  assert.equal(typeof shellId, "string");
  return shellId;
};
