import assert from "node:assert/strict";
import test from "node:test";

import type { AgentTool } from "@mariozechner/pi-agent-core";

import {
  createMemoryDeleteTool,
  createMemorySearchTool,
  createMemoryStoreTool,
  createMemoryTools,
  createMemoryUpdateTool,
} from "./memory-tools.js";
import type { MemoryEntry, MemoryProvider, MemorySearchResult } from "./types.js";

type ProviderCall = { method: string; args: unknown[] };

const createProviderStub = (): {
  provider: MemoryProvider;
  calls: ProviderCall[];
} => {
  const calls: ProviderCall[] = [];
  const entry: MemoryEntry = {
    id: "mem-1",
    content: "remember this",
    tags: ["prefs"],
    metadata: { source: "test" },
    createdAt: 1,
    updatedAt: 1,
  };
  const searchResult: MemorySearchResult = {
    entries: [entry],
    total: 1,
  };

  return {
    calls,
    provider: {
      search: async (...args) => {
        calls.push({ method: "search", args });
        return searchResult;
      },
      store: async (...args: [string, { content: string; tags?: string[]; metadata?: Record<string, unknown> }]) => {
        calls.push({ method: "store", args });
        return entry;
      },
      update: async (...args: [string, string, { content?: string; tags?: string[]; metadata?: Record<string, unknown> }]) => {
        calls.push({ method: "update", args });
        return entry;
      },
      delete: async (...args: [string, string]) => {
        calls.push({ method: "delete", args });
      },
    },
  };
};

const getTool = (tools: AgentTool[], name: string): AgentTool => {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Expected tool "${name}" to be registered`);
  return tool;
};

test("createMemoryTools registers all four memory tools", () => {
  const { provider } = createProviderStub();
  const tools = createMemoryTools("jarvis", provider);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["memory_search", "memory_store", "memory_update", "memory_delete"],
  );
});

test("memory_search delegates text, tags, and limit to the provider", async () => {
  const { provider, calls } = createProviderStub();
  const tool = createMemorySearchTool("jarvis", provider);

  const result = await tool.execute("call-1", {
    text: "typescript",
    tags: ["prefs"],
    limit: 3,
  });

  assert.deepEqual(calls, [{
    method: "search",
    args: ["jarvis", { text: "typescript", tags: ["prefs"], limit: 3 }],
  }]);
  assert.match(readText(result), /remember this/);
  assert.equal(result.details?.total, 1);
});

test("memory_store delegates content, tags, and metadata to the provider", async () => {
  const { provider, calls } = createProviderStub();
  const tool = createMemoryStoreTool("jarvis", provider);

  const result = await tool.execute("call-1", {
    content: "Preferred language is TypeScript",
    tags: ["language"],
    metadata: { source: "user" },
  });

  assert.deepEqual(calls, [{
    method: "store",
    args: ["jarvis", {
      content: "Preferred language is TypeScript",
      tags: ["language"],
      metadata: { source: "user" },
    }],
  }]);
  assert.equal(result.details?.entryId, "mem-1");
});

test("memory_update delegates the patch to the provider", async () => {
  const { provider, calls } = createProviderStub();
  const tool = createMemoryUpdateTool("jarvis", provider);

  const result = await tool.execute("call-1", {
    id: "mem-1",
    content: "Preferred language is Go",
    tags: ["backend"],
    metadata: { source: "user", updated: true },
  });

  assert.deepEqual(calls, [{
    method: "update",
    args: ["jarvis", "mem-1", {
      content: "Preferred language is Go",
      tags: ["backend"],
      metadata: { source: "user", updated: true },
    }],
  }]);
  assert.equal(result.details?.entryId, "mem-1");
});

test("memory_delete delegates entry deletion to the provider", async () => {
  const { provider, calls } = createProviderStub();
  const tool = createMemoryDeleteTool("jarvis", provider);

  const result = await tool.execute("call-1", { id: "mem-1" });

  assert.deepEqual(calls, [{
    method: "delete",
    args: ["jarvis", "mem-1"],
  }]);
  assert.match(readText(result), /Deleted memory entry mem-1/);
});

const readText = (result: Awaited<ReturnType<AgentTool["execute"]>>): string => {
  const firstContent = result.content[0];
  assert.ok(firstContent?.type === "text");
  return firstContent.text;
};
