export type MemoryEntry = {
  id: string;
  content: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type MemorySearchResult = {
  entries: MemoryEntry[];
  total: number;
};

export interface MemoryProvider {
  search(
    entityId: string,
    query: { text?: string; tags?: string[]; limit?: number },
  ): Promise<MemorySearchResult>;
  store(
    entityId: string,
    input: { content: string; tags?: string[]; metadata?: Record<string, unknown> },
  ): Promise<MemoryEntry>;
  update(
    entityId: string,
    id: string,
    patch: { content?: string; tags?: string[]; metadata?: Record<string, unknown> },
  ): Promise<MemoryEntry>;
  delete(entityId: string, id: string): Promise<void>;
}
