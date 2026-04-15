# Plugins

Plugin 系统让外部模块可以通过一个统一的 `plugins:` 配置字段扩展 Jar 的运行时行为，而无需修改 `jar-core` 内部代码。

一个典型的“轻插件”例子是 `packages/jar-core/src/memory/workspace-plugin.ts`：它不增加新系统边界，只是在 `prompt:transform` 里读取工作区内的 `MEMORY.md` 并直接注入当前 turn prompt。

## 能力概览

一个 plugin 可以做五件事：

| 能力 | 机制 | 说明 |
|------|------|------|
| 注册 hooks | `context.hooks.register()` | 接入 11 个 hook 点，拦截或观察执行管道 |
| 贡献 Skills | 返回 `{ skills: [...] }` | 合并到 catalog，出现在 agent 系统提示 |
| 贡献 AgentTools | 返回 `{ tools: [...] }` | 追加到默认工具列表，agent 可直接调用 |
| 替换 Memory Provider | 返回 `{ memoryProvider: factory }` | 覆盖内置 filesystem provider，last-wins |
| 共享服务实例 | `context.services.register()` / `.get()` | 跨 plugin 共享连接、客户端等长期对象 |

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
import type {
  JarPlugin,
  PluginFactory,
  PluginInstallContext,
  PluginInstallResult,
  ServiceRegistry,
} from "@hijarvis/jar-core";
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
  services: ServiceRegistry;    // 跨 plugin 服务共享
  logger?: Logger;              // 可选日志记录器
};
```

### `PluginInstallResult`

```typescript
type PluginInstallResult = {
  skills?: SkillEntry[];                    // 注入 catalog 的额外 skills
  overlays?: PromptSection[];               // 注入系统提示的额外片段
  tools?: AgentTool[];                      // 追加到 agent 工具列表
  memoryProvider?: MemoryProviderFactory;   // 替换内置 memory provider（last-wins）
  cleanup?: () => void | Promise<void>;     // 可选清理函数
};
```

### `ServiceRegistry`

```typescript
type ServiceRegistry = {
  register<T>(name: string, instance: T): void;  // 重复注册同名 service 会抛出
  get<T>(name: string): T | undefined;
  has(name: string): boolean;
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
  install({ hooks, services, logger }) { ... },
});

// 备选：default 导出（预实例化的 plugin 对象）
export default {
  name: "my-plugin",
  install({ hooks }) { ... },
} satisfies JarPlugin;
```

`createPlugin` 优先于 `default`。

## 加载时序

Plugin 在 `phase-init-stores` 时通过 `createPluginManager` 加载，早于 session 加载、prompt 准备和 agent 创建：

```
jar.toml plugins: [...]
       │
       ▼
createPluginManager(config, hooks)   ← phase-init-stores（最早阶段）
  import(modulePath)
  plugin.install({ config, hooks, services, logger })
    └─ hooks.register(...)           ← 立即生效，对后续所有 hook 调用点有效
    └─ services.register(...)        ← 注册供其他 plugin 使用的服务实例
    └─ return { skills, tools, memoryProvider, ... }
       │
       ▼
StoresContext                        ← 传递给后续 phases
  .pluginSkills                      ← phase-prepare-prompt 合并到 catalog
  .pluginOverlays                    ← phase-create-agent 注入系统提示
  .pluginTools                       ← phase-create-agent 追加到工具列表
  .pluginMemoryProvider              ← phase-create-agent 替换 memory provider
```

## 错误处理

默认 `failureMode: "isolate"`：plugin 加载或 `install()` 失败只记录诊断日志，不会中断运行时，其他 plugin 和主流程不受影响。

可通过 `PluginManagerOptions.defaultFailureMode: "fail_fast"` 改为快速失败模式。

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

### 3. 贡献 AgentTools

```typescript
// weather-plugin.ts
import type { JarPlugin } from "@hijarvis/jar-core";

export const createPlugin = (cfg: Record<string, unknown>): JarPlugin => ({
  name: "weather-plugin",
  install() {
    return {
      tools: [{
        name: "get_weather",
        description: "Get current weather for a city",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
        execute: async ({ city }) => {
          const res = await fetch(`https://wttr.in/${city}?format=3`);
          return res.text();
        },
      }],
    };
  },
});
```

### 4. 替换 Memory Provider

```typescript
// redis-memory-plugin.ts
import type { JarPlugin } from "@hijarvis/jar-core";
import { RedisMemoryProvider } from "./redis-provider.js";

export const createPlugin = (cfg: Record<string, unknown>): JarPlugin => {
  const provider = new RedisMemoryProvider({
    host: cfg.host as string ?? "localhost",
    port: cfg.port as number ?? 6379,
  });

  return {
    name: "redis-memory-plugin",
    install() {
      return {
        // Replaces the built-in filesystem provider when memory is enabled.
        // Receives the same { providerName, providerConfig } from jar.toml.
        memoryProvider: () => provider,
        cleanup: () => provider.disconnect(),
      };
    },
  };
};
```

### 5. 跨 Plugin 共享服务实例

```typescript
// plugin-a.ts — 注册共享客户端
export const createPlugin = (cfg: Record<string, unknown>): JarPlugin => ({
  name: "plugin-a",
  install({ services }) {
    const client = new MyDatabaseClient(cfg);
    services.register("my-db", client);
    return { cleanup: () => client.close() };
  },
});

// plugin-b.ts — 消费共享客户端
export const createPlugin = (): JarPlugin => ({
  name: "plugin-b",
  install({ services }) {
    const client = services.get<MyDatabaseClient>("my-db");
    // plugin-b 依赖 plugin-a 先加载（由 jar.toml 中的声明顺序保证）
    return {};
  },
});
```

### 6. 拦截并修改 prompt

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

## Memory Provider 替换 vs hooks 追加

| 方式 | 场景 |
|------|------|
| `memoryProvider` 返回值 | 完全替换内置 filesystem provider，`memory_search` 等工具指向新 provider |
| `tools:resolve` hook | 在现有工具基础上追加额外工具，不影响内置 memory |

多个 plugin 都返回 `memoryProvider` 时，**最后加载的 plugin 生效**（last-wins）。加载顺序由 `jar.toml` 中的声明顺序决定。

## 相关文件

| 文件 | 说明 |
|------|------|
| `packages/jar-core/src/plugins/types.ts` | `JarPlugin`、`PluginFactory`、`PluginInstallContext`、`PluginInstallResult`、`ServiceRegistry`、`PluginContribution` |
| `packages/jar-core/src/plugins/manager.ts` | `createPluginManager()` 实现：动态 import、factory/default 导出约定、错误隔离、诊断记录 |
| `packages/jar-core/src/plugins/index.ts` | re-exports |
| `packages/jar-core/src/execution/phase-init-stores.ts` | plugin 加载时机，`createPluginManager` 调用点 |
| `packages/jar-core/src/execution/resolve-tools.ts` | plugin tools 和 memoryProvider 的合并逻辑 |
| `packages/jar-core/src/execution/phase-prepare-prompt.ts` | plugin skills 合并逻辑 |
| `packages/jar-core/src/config.ts` | `plugins` 配置字段解析与路径归一化 |
