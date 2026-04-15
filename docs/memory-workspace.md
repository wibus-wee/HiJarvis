# Memory Workspace Plugin (MEMORY.md + notes/)

这个插件提供一套“工作区记忆”的轻量机制：用 `{dir}/{entityId}/MEMORY.md` 作为长期记忆索引，并允许 agent 通过工具读写 `{dir}/{entityId}/notes/` 下的 Markdown 笔记文件。

它和现有的 JSONL memory provider（`memory_search` / `memory_store` 等）是**两套系统并存**：本插件不替换 memory provider，只是额外注入 system prompt overlay 与一组 workspace 工具。

## 行为概览

1. **启动时注入 MEMORY.md**
   - 插件在 `install()` 时读取默认 entity 的 `MEMORY.md`，并作为 `overlays` 注入 system prompt。
   - 这是 **static** 的：进程运行期间不会自动重载；你更新 `MEMORY.md` 后需要重启进程才能让新内容进入 system prompt（这是预期行为，避免每个 turn 的额外 I/O 与不确定性）。

2. **每次请求注入 workspace 工具**
   - 插件通过 `tools:resolve` hook，在每个 ingress turn 根据 command 路由解析出 `entityId`，并注入一组工具，读写该 entity 的 `notes/` 和 `MEMORY.md`。

## 目录结构

```text
{dir}/{entityId}/
├── MEMORY.md
└── notes/
    ├── user-prefs.md
    └── work-log.md
```

默认 `dir` 为 `.jar/memory`（相对于 `jar.toml` 所在目录）。

## 配置方式（jar.toml）

开发/本地（`tsx` 运行时可以直接加载 `.ts`）：

```toml
[[plugins]]
module = "./packages/jar-core/src/memory/workspace-plugin.ts"

[plugins.config]
dir = ".jar/memory"
```

构建产物/纯 Node ESM（建议指向编译后的 `.js`）：

```toml
[[plugins]]
module = "./packages/jar-core/dist/memory/workspace-plugin.js"

[plugins.config]
dir = ".jar/memory"
```

## 工具列表

- `workspace_read_note`：读取 `notes/<filename>.md`
- `workspace_write_note`：写入/覆盖 `notes/<filename>.md`
- `workspace_list_notes`：列出 `notes/` 下的 `.md` 文件
- `workspace_update_memory_index`：覆盖写入 `MEMORY.md`

## 安全与边界

- 工具侧对 `filename` 做了 basename 校验，并强制 `.md` 后缀，避免路径穿越（例如 `notes/../../etc/passwd`）。
- 该插件不修改任何已有 memory provider 行为；如果你希望“自动记忆”或“语义检索”，应该通过替换 memory provider 或单独的 plugin 来实现。

## 相关实现

- `packages/jar-core/src/memory/workspace-plugin.ts`
- `packages/jar-core/src/execution/resolve-tools.ts`（`resolveEntityMemoryScope`）
- `docs/plugins.md`（Plugin 系统与 hooks）

