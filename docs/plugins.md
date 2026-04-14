# Plugins

Plugin 系统让外部模块可以通过一个统一的 `plugins:` 配置字段扩展 Jar 的运行时行为，而无需修改 `jar-core` 内部代码。

## 能力概览

一个 plugin 可以做三件事：

| 能力 | 机制 | 侵入性 |
|------|------|--------|
| 注册 hooks | `context.hooks.register()` | 无 — 通过现有 hook 点接入 |
| 贡献 Skills | 返回 `{ skills: [...] }` | 无 — 合并到 catalog，不影响文件扫描 |
| 封装 Memory Provider | 通过 `tools:resolve` hook 追加 tools | 无 — 不替换内置 memory，并行存在 |

## 配置

在 `jar.toml` 里声明 plugin：

```toml
# 简单写法 — 模块路径或 npm 包名
plugins = ["./my-plugin.js", "@hijarvis/plugin-redis-memory"]

# 带配置写法 — 向 plugin 传入参数
[[plugins]]
module = "./my-plugin.js"

[plugins.config]
host = "localhost"
port = 6379
```

- 相对路径以配置文件所在目录为基准解析
- 绝对路径和 npm 包名直接使用
- `config` 子表原样透传给 `PluginFactory`，由 plugin 自己解释

## Plugin 接口

```typescript
import type { JarPlugin, PluginFactory, PluginInstallContext, PluginInstallResult } from "@hijarvis/jar-core";
```

### `JarPlugin`

```typescript
interface JarPlugin {
  name: string;
  install(context: PluginInstallContext): PluginInstallResult | Promise<PluginInstallResult>;
}
```

- `name`: 唯一标识符，用于日志和错误提示
- `install()`: 安装入口，在 `phase-init-stores` 时调用一次

### `PluginInstallContext`

```typescript
type PluginInstallContext = {
  config: LoadedRuntimeConfig;  // 只读，完整运行时配置
  hooks: HookRegistry;          // 共享 hook 注册表
};
```

### `PluginInstallResult`

```typescript
type PluginInstallResult = {
  skills?: SkillEntry[];                    // 注入 catalog 的额外 skills
  cleanup?: () => void | Promise<void>;     // 可选清理函数
};
```

### `PluginFactory`

```typescript
type PluginFactory = (
  pluginConfig: Record<string, unknown>,
) => JarPlugin | Promise<JarPlugin>;
```

## 模块导出约定

Plugin 模块期望导出以下之一：

```typescript
// 推荐：命名导出 createPlugin（factory 模式，支持配置参数）
export const createPlugin: PluginFactory = (cfg) => ({
  name: "my-plugin",
  install({ hooks }) { ... },
});

// 备选：default 导出（预实例化的 plugin 对象）
export default {
  name: "my-plugin",
  install({ hooks }) { ... },
} satisfies JarPlugin;
```

`createPlugin` 优先于 `default`。

## 加载时序

Plugin 在 `phase-init-stores` 时加载，早于 session 加载、prompt 准备和 agent 创建：

```
config.yaml
  plugins: [...]
       │
       ▼
loadPlugins(config, hooks)          ← phase-init-stores（最早阶段）
  import(modulePath)
  plugin.install({ config, hooks })
    └─ hooks.register(...)          ← 立即生效，对后续所有 hook 调用点有效
    └─ return { skills: [...] }
       │
       ▼
StoresContext.pluginSkills          ← 传递给后续 phases
       │
       ▼
preparePrompt                       ← phase-prepare-prompt
  skills.entries = [...builtIn, ...pluginSkills]
  resolveSkillPromptContext(...)    ← plugin skills 出现在 catalog
```

## 错误处理

Plugin 加载或 `install()` 失败只记录 `warn` 日志，不会中断运行时。单个 plugin 故障不影响其他 plugin 或主流程。

## 示例

### 1. 只注册 hooks（最简单）

```typescript
// my-logging-plugin.ts
import type { JarPlugin } from "@hijarvis/jar-core";

export const createPlugin = (): JarPlugin => ({
  name: "my-logging-plugin",
  install({ hooks }) {
    hooks.register({
      point: "response:complete",
      name: "my-logging-plugin:log",
      handler: ({ result }) => {
        console.log("[plugin] response:", result.outputText.slice(0, 80));
      },
    });
    return {};
  },
});
```

### 2. 贡献 Skills（npm 包内嵌 skill）

```typescript
// my-skill-plugin.ts
import type { JarPlugin } from "@hijarvis/jar-core";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const createPlugin = (): JarPlugin => ({
  name: "my-skill-plugin",
  install() {
    return {
      skills: [{
        name: "vector-memory",
        description: "Search semantic memory via Qdrant",
        path: path.join(path.dirname(fileURLToPath(import.meta.url)), "SKILL.md"),
        allowImplicitInvocation: true,
      }],
    };
  },
});
```

### 3. 封装 Memory Provider（非侵入式，通过 tools:resolve）

```typescript
// redis-memory-plugin.ts
import type { JarPlugin } from "@hijarvis/jar-core";
import { createMemoryTools } from "@hijarvis/jar-core";
import { RedisMemoryProvider } from "./redis-provider.js";

export const createPlugin = (cfg: Record<string, unknown>): JarPlugin => ({
  name: "redis-memory-plugin",
  install({ hooks }) {
    const provider = new RedisMemoryProvider({
      host: cfg.host as string ?? "localhost",
      port: cfg.port as number ?? 6379,
    });

    hooks.register({
      point: "tools:resolve",
      name: "redis-memory-plugin:tools",
      handler: ({ tools, ...rest }) => ({
        tools: [...tools, ...createMemoryTools("redis", provider)],
      }),
    });

    return {
      cleanup: () => provider.disconnect(),
    };
  },
});
```

### 4. 拦截并修改 prompt

```typescript
// datetime-plugin.ts
import type { JarPlugin } from "@hijarvis/jar-core";

export const createPlugin = (): JarPlugin => ({
  name: "datetime-plugin",
  install({ hooks }) {
    hooks.register({
      point: "prompt:transform",
      name: "datetime-plugin:inject",
      priority: 50,
      handler: ({ prompt, skillTriggerText }) => ({
        prompt: typeof prompt === "string"
          ? `[Current time: ${new Date().toISOString()}]\n\n${prompt}`
          : prompt,
        skillTriggerText,
      }),
    });
    return {};
  },
});
```

## 与 Memory Provider 的关系

Plugin 系统不替换 `[memory]` 配置机制。两者并行：

- `[memory]` 配置 → 内置 memory provider，通过 `resolveConfiguredMemoryProvider()` 加载，工具名固定为 `memory_search` / `memory_store` / `memory_update` / `memory_delete`
- Plugin `tools:resolve` hook → 可以追加额外的 memory tools（不同 entityId 或不同 provider），工具名由 plugin 自己决定

如果 plugin 想完全替换内置 memory，可以在 `tools:resolve` hook 里过滤掉内置 memory tools 再追加自己的。

## 相关文件

| 文件 | 说明 |
|------|------|
| `packages/jar-core/src/plugins/types.ts` | `JarPlugin`、`PluginFactory`、`PluginInstallContext`、`PluginInstallResult`、`LoadedPlugin` |
| `packages/jar-core/src/plugins/loader.ts` | `loadPlugins()` 实现：动态 import、factory/default 两种导出约定、错误隔离 |
| `packages/jar-core/src/plugins/index.ts` | re-exports |
| `packages/jar-core/src/execution/phase-init-stores.ts` | plugin 加载时机 |
| `packages/jar-core/src/execution/phase-prepare-prompt.ts` | plugin skills 合并逻辑 |
| `packages/jar-core/src/config.ts` | `plugins` 配置字段解析与路径归一化 |
