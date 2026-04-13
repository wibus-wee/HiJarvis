import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { MemoryEntry, MemoryProvider, MemorySearchResult } from "./types.js";

type FileSystemMemoryProviderOptions = {
  rootDir: string;
};

export class FileSystemMemoryProvider implements MemoryProvider {
  readonly rootDir: string;

  constructor(options: FileSystemMemoryProviderOptions) {
    this.rootDir = options.rootDir;
  }

  async search(
    entityId: string,
    query: { text?: string; tags?: string[]; limit?: number },
  ): Promise<MemorySearchResult> {
    const entries = await this.readEntries(entityId);
    const normalizedText = query.text?.trim().toLowerCase();
    const normalizedTags = query.tags?.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
    const limit = query.limit ?? entries.length;

    const filtered = entries
      .filter((entry) => {
        if (normalizedText && !entry.content.toLowerCase().includes(normalizedText)) {
          return false;
        }

        if (normalizedTags && normalizedTags.length > 0) {
          const entryTags = new Set(entry.tags ?? []);
          if (!normalizedTags.every((tag) => entryTags.has(tag))) {
            return false;
          }
        }

        return true;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);

    return {
      entries: filtered,
      total: filtered.length,
    };
  }

  async store(
    entityId: string,
    input: { content: string; tags?: string[]; metadata?: Record<string, unknown> },
  ): Promise<MemoryEntry> {
    const now = Date.now();
    const entry: MemoryEntry = {
      id: randomUUID(),
      content: input.content,
      tags: input.tags,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    const entries = await this.readEntries(entityId);
    entries.push(entry);
    await this.writeEntries(entityId, entries);
    return entry;
  }

  async update(
    entityId: string,
    id: string,
    patch: { content?: string; tags?: string[]; metadata?: Record<string, unknown> },
  ): Promise<MemoryEntry> {
    const entries = await this.readEntries(entityId);
    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1) {
      throw new Error(`Memory entry "${id}" not found`);
    }

    const current = entries[index]!;
    const updated: MemoryEntry = {
      ...current,
      content: patch.content ?? current.content,
      tags: patch.tags ?? current.tags,
      metadata: patch.metadata ?? current.metadata,
      updatedAt: Date.now(),
    };
    entries[index] = updated;
    await this.writeEntries(entityId, entries);
    return updated;
  }

  async delete(entityId: string, id: string): Promise<void> {
    const entries = await this.readEntries(entityId);
    const nextEntries = entries.filter((entry) => entry.id !== id);
    if (nextEntries.length === entries.length) {
      return;
    }
    await this.writeEntries(entityId, nextEntries);
  }

  private getEntityDirectory(entityId: string): string {
    return path.join(this.rootDir, entityId);
  }

  private getEntriesPath(entityId: string): string {
    return path.join(this.getEntityDirectory(entityId), "entries.jsonl");
  }

  private async readEntries(entityId: string): Promise<MemoryEntry[]> {
    const entriesPath = this.getEntriesPath(entityId);

    let content: string;
    try {
      content = await readFile(entriesPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as MemoryEntry);
  }

  private async writeEntries(entityId: string, entries: MemoryEntry[]): Promise<void> {
    const entityDirectory = this.getEntityDirectory(entityId);
    await mkdir(entityDirectory, { recursive: true });
    const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(this.getEntriesPath(entityId), body.length > 0 ? `${body}\n` : "", "utf8");
  }
}
