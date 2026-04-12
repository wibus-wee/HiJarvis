# Memory

Jar's long-term memory subsystem adds explicit, tool-driven memory on top of the existing thread/lane session history.

The design goal is local-first memory with explicit promotion:

- default local memory
- per-entity isolation
- provider-backed storage behind a narrow interface
- thin tools that delegate to the configured provider

## Architecture

At runtime, memory is wired in this order:

1. `jar.toml` loads `[memory]` and `[memory.providers.*]` into `LoadedRuntimeConfig.memory`
2. `packages/jar-core/src/execution-service.ts` resolves the active entity for the current message turn
3. `packages/jar-core/src/memory/provider-resolution.ts` resolves the configured provider using either an internal registry or a configured external module
4. `createMemoryTools(entityId, provider)` adds four scoped tools to the turn's toolset

Current built-in provider:

- `FileSystemMemoryProvider` in `packages/jar-core/src/memory/fs-provider.ts`

Current built-in tools:

- `memory_search`
- `memory_store`
- `memory_update`
- `memory_delete`

## Entity Scope

Memory is always scoped per entity, not per thread and not per raw platform identity.

- Slack and Telegram turns resolve the entity through `platform.<platform>.identities.<identity>.entity`
- CLI/local-thread turns fall back to the first configured entity
- Every provider call receives `entityId`

This means `jarvis` and `pm` can share the same runtime and config file while keeping independent long-term memory stores.

## Provider Contract

The provider interface lives in `packages/jar-core/src/memory/types.ts`:

```ts
export interface MemoryProvider {
  search(entityId: string, query: { text?: string; tags?: string[]; limit?: number }): Promise<MemorySearchResult>;
  store(entityId: string, input: { content: string; tags?: string[]; metadata?: Record<string, unknown> }): Promise<MemoryEntry>;
  update(entityId: string, id: string, patch: { content?: string; tags?: string[]; metadata?: Record<string, unknown> }): Promise<MemoryEntry>;
  delete(entityId: string, id: string): Promise<void>;
}
```

The contract is intentionally narrow so alternate providers can be added later without changing the tool surface.

Provider creation is now also abstracted:

- built-in providers are registered in an internal resolver registry
- external providers can be loaded from `memory.providers.<name>.module`
- external modules must export `createMemoryProvider(context)`

## Filesystem Provider

The default provider stores memory under:

```text
<configured rootDir>/<entityId>/entries.jsonl
```

Behavior:

- each line is one JSON-serialized `MemoryEntry`
- writes rewrite the current entity file with the full entry set
- search is local keyword matching on `content`
- tag filters require every requested tag to be present
- results are returned newest-first by `updatedAt`

## Tool Semantics

The memory tools are thin facades over the provider:

- `memory_search`: keyword/tag lookup within the current entity namespace
- `memory_store`: append a new structured memory entry
- `memory_update`: patch an existing entry by id
- `memory_delete`: remove an entry by id

Entries use this shared shape:

```ts
type MemoryEntry = {
  id: string;
  content: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};
```

## Validation

Core coverage lives in:

- `packages/jar-core/src/memory/fs-provider.test.ts`
- `packages/jar-core/src/memory/memory-tools.test.ts`
- `packages/jar-core/src/execution-service.memory.test.ts`
- `packages/jar-core/src/config.test.ts`
