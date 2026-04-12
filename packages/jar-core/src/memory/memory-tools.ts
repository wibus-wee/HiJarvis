import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type TSchema } from "@mariozechner/pi-ai";

import type { MemoryEntry, MemoryProvider } from "./types.js";

const memorySearchParameters: TSchema = Type.Object({
  text: Type.Optional(Type.String({
    description: "Optional keyword text to search for in stored memory content",
    minLength: 1,
  })),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Optional tag filters. Entries must contain every provided tag.",
    minItems: 1,
  })),
  limit: Type.Optional(Type.Integer({
    description: "Maximum number of matching memory entries to return",
    minimum: 1,
  })),
}, {
  additionalProperties: false,
});

const memoryStoreParameters: TSchema = Type.Object({
  content: Type.String({
    description: "Memory text to store for this entity",
    minLength: 1,
  }),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Optional tags for later filtering",
    minItems: 1,
  })),
  metadata: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Unknown())),
}, {
  additionalProperties: false,
});

const memoryUpdateParameters: TSchema = Type.Object({
  id: Type.String({
    description: "Existing memory entry id to update",
    minLength: 1,
  }),
  content: Type.Optional(Type.String({
    description: "Replacement content text",
    minLength: 1,
  })),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Replacement tags",
    minItems: 1,
  })),
  metadata: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Unknown())),
}, {
  additionalProperties: false,
});

const memoryDeleteParameters: TSchema = Type.Object({
  id: Type.String({
    description: "Existing memory entry id to delete",
    minLength: 1,
  }),
}, {
  additionalProperties: false,
});

type MemorySearchParameters = {
  text?: string;
  tags?: string[];
  limit?: number;
};

type MemoryStoreParameters = {
  content: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

type MemoryUpdateParameters = {
  id: string;
  content?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

type MemoryDeleteParameters = {
  id: string;
};

export const createMemorySearchTool = (
  entityId: string,
  provider: MemoryProvider,
): AgentTool<typeof memorySearchParameters> => {
  return {
    name: "memory_search",
    label: "Memory Search",
    description: "Search stored long-term memory for the current entity.",
    parameters: memorySearchParameters,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as MemorySearchParameters;
      const result = await provider.search(entityId, params);
      return {
        content: [{
          type: "text",
          text: result.entries.length === 0
            ? "No matching memory entries found."
            : result.entries.map(formatEntry).join("\n\n"),
        }],
        details: {
          entityId,
          total: result.total,
          entries: result.entries,
        },
      };
    },
  };
};

export const createMemoryStoreTool = (
  entityId: string,
  provider: MemoryProvider,
): AgentTool<typeof memoryStoreParameters> => {
  return {
    name: "memory_store",
    label: "Memory Store",
    description: "Store a new long-term memory entry for the current entity.",
    parameters: memoryStoreParameters,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as MemoryStoreParameters;
      const entry = await provider.store(entityId, params);
      return {
        content: [{
          type: "text",
          text: `Stored memory entry ${entry.id}.`,
        }],
        details: {
          entityId,
          entryId: entry.id,
          entry,
        },
      };
    },
  };
};

export const createMemoryUpdateTool = (
  entityId: string,
  provider: MemoryProvider,
): AgentTool<typeof memoryUpdateParameters> => {
  return {
    name: "memory_update",
    label: "Memory Update",
    description: "Update an existing long-term memory entry for the current entity.",
    parameters: memoryUpdateParameters,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as MemoryUpdateParameters;
      const entry = await provider.update(entityId, params.id, {
        ...(params.content === undefined ? {} : { content: params.content }),
        ...(params.tags === undefined ? {} : { tags: params.tags }),
        ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
      });
      return {
        content: [{
          type: "text",
          text: `Updated memory entry ${entry.id}.`,
        }],
        details: {
          entityId,
          entryId: entry.id,
          entry,
        },
      };
    },
  };
};

export const createMemoryDeleteTool = (
  entityId: string,
  provider: MemoryProvider,
): AgentTool<typeof memoryDeleteParameters> => {
  return {
    name: "memory_delete",
    label: "Memory Delete",
    description: "Delete a long-term memory entry for the current entity.",
    parameters: memoryDeleteParameters,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as MemoryDeleteParameters;
      await provider.delete(entityId, params.id);
      return {
        content: [{
          type: "text",
          text: `Deleted memory entry ${params.id}.`,
        }],
        details: {
          entityId,
          entryId: params.id,
        },
      };
    },
  };
};

export const createMemoryTools = (
  entityId: string,
  provider: MemoryProvider,
): AgentTool[] => {
  return [
    createMemorySearchTool(entityId, provider) as AgentTool,
    createMemoryStoreTool(entityId, provider) as AgentTool,
    createMemoryUpdateTool(entityId, provider) as AgentTool,
    createMemoryDeleteTool(entityId, provider) as AgentTool,
  ];
};

const formatEntry = (entry: MemoryEntry): string => {
  const lines = [
    `id: ${entry.id}`,
    `content: ${entry.content}`,
    ...(entry.tags === undefined ? [] : [`tags: ${entry.tags.join(", ")}`]),
    `createdAt: ${entry.createdAt}`,
    `updatedAt: ${entry.updatedAt}`,
  ];
  return lines.join("\n");
};
