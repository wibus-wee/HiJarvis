# HiJarvis Plugin System V3 - 完整设计方案

## 🎯 设计目标

基于对现有架构的深入分析，设计一个**能力扩展为核心**的插件系统，允许破坏性重构。

## 🏗️ 核心架构

### 1. 插件能力矩阵 (Plugin Capability Matrix)

```typescript
// packages/jar-core/src/plugins/capabilities.ts

export interface PluginCapabilityMap {
  // 工具能力 - 贡献新的 AgentTool
  tools: {
    in: { config: LoadedRuntimeConfig; command: MessageIngressCommand };
    out: AgentTool[];
  };
  
  // 内存提供者能力 - 贡献新的 MemoryProvider
  memoryProviders: {
    in: { providerName: string };
    out: MemoryProviderFactory;
  };
  
  // 技能能力 - 贡献 SkillEntry
  skills: {
    in: { config: LoadedRuntimeConfig };
    out: SkillEntry[];
  };
  
  // 钩子能力 - 注册钩子处理器
  hooks: {
    in: { registry: HookRegistry };
    out: void;
  };
  
  // 提示覆盖能力 - 贡献系统提示片段
  overlays: {
    in: { config: LoadedRuntimeConfig };
    out: PromptSection[];
  };
  
  // 服务能力 - 注册长期运行的服务
  services: {
    in: { registry: ServiceRegistry };
    out: void;
  };
  
  // 配置验证能力 - 验证配置
  configValidation: {
    in: { config: unknown };
    out: { valid: boolean; errors: string[] };
  };
  
  // 网关扩展能力 - 扩展特定网关功能
  gatewayExtensions: {
    in: { gateway: 'cli' | 'slack' | 'telegram'; context: unknown };
    out: unknown;
  };
}

export type PluginCapability = keyof PluginCapabilityMap;

// 类型安全的能力处理器
export type CapabilityHandler<C extends PluginCapability> = (
  input: PluginCapabilityMap[C]['in']
) => PluginCapabilityMap[C]['out'] | Promise<PluginCapabilityMap[C]['out']>;
```

### 2. 插件元数据和依赖系统

```typescript
// packages/jar-core/src/plugins/metadata.ts

export interface PluginMetadata {
  // 基础信息
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  
  // API 兼容性
  apiVersion: string; // 支持的 HiJarvis API 版本
  
  // 依赖关系
  dependencies?: {
    plugins?: string[]; // 依赖的其他插件
    services?: string[]; // 依赖的系统服务
    minHiJarvisVersion?: string;
  };
  
  // 冲突声明
  conflicts?: string[]; // 与哪些插件冲突
  
  // 能力声明
  capabilities: PluginCapability[];
  
  // 配置模式
  configSchema?: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  
  // 生命周期钩子
  lifecycle?: {
    beforeLoad?: boolean;
    afterLoad?: boolean;
    beforeUnload?: boolean;
    afterUnload?: boolean;
  };
}

export interface PluginDependencyGraph {
  nodes: Map<string, PluginMetadata>;
  edges: Map<string, string[]>; // plugin -> dependencies
  conflicts: Map<string, string[]>; // plugin -> conflicts
}
```

### 3. 新插件接口

```typescript
// packages/jar-core/src/plugins/types.ts

export interface JarPluginV3 {
  // 元数据（必须）
  metadata: PluginMetadata;
  
  // 能力贡献者映射
  capabilities: {
    [C in PluginCapability]?: CapabilityHandler<C>;
  };
  
  // 生命周期钩子
  lifecycle?: {
    beforeLoad?: (context: PluginLifecycleContext) => void | Promise<void>;
    afterLoad?: (context: PluginLifecycleContext) => void | Promise<void>;
    beforeUnload?: (context: PluginLifecycleContext) => void | Promise<void>;
    afterUnload?: (context: PluginLifecycleContext) => void | Promise<void>;
  };
  
  // 清理函数
  cleanup?: () => void | Promise<void>;
}

export interface PluginLifecycleContext {
  config: LoadedRuntimeConfig;
  services: ServiceRegistry;
  logger: Logger;
  pluginConfig: Record<string, unknown>;
}

// 插件工厂
export type PluginFactoryV3 = (
  pluginConfig: Record<string, unknown>
) => JarPluginV3 | Promise<JarPluginV3>;
```

### 4. 服务注册表

```typescript
// packages/jar-core/src/plugins/service-registry.ts

export interface Service {
  name: string;
  instance: unknown;
  metadata?: Record<string, unknown>;
}

export interface ServiceRegistry {
  register<T>(name: string, instance: T, metadata?: Record<string, unknown>): void;
  get<T>(name: string): T | undefined;
  has(name: string): boolean;
  list(): Service[];
  unregister(name: string): boolean;
}

export const createServiceRegistry = (): ServiceRegistry => {
  const services = new Map<string, Service>();
  
  return {
    register<T>(name: string, instance: T, metadata?: Record<string, unknown>): void {
      if (services.has(name)) {
        throw new Error(`Service "${name}" is already registered`);
      }
      services.set(name, { name, instance, metadata });
    },
    
    get<T>(name: string): T | undefined {
      return services.get(name)?.instance as T;
    },
    
    has(name: string): boolean {
      return services.has(name);
    },
    
    list(): Service[] {
      return Array.from(services.values());
    },
    
    unregister(name: string): boolean {
      return services.delete(name);
    },
  };
};
```

### 5. 插件管理器 V3

```typescript
// packages/jar-core/src/plugins/manager-v3.ts

export interface PluginManagerV3 {
  // 生命周期
  load(): Promise<void>;
  unload(): Promise<void>;
  reload(): Promise<void>;
  
  // 能力获取
  getCapabilityContributions<C extends PluginCapability>(
    capability: C
  ): Array<{
    plugin: string;
    handler: CapabilityHandler<C>;
  }>;
  
  // 服务访问
  getServiceRegistry(): ServiceRegistry;
  
  // 状态查询
  getLoadedPlugins(): PluginInfo[];
  getDependencyGraph(): PluginDependencyGraph;
  getDiagnostics(): PluginDiagnostic[];
  
  // 动态管理
  loadPlugin(modulePath: string, config?: Record<string, unknown>): Promise<void>;
  unloadPlugin(pluginName: string): Promise<void>;
}

export interface PluginInfo {
  metadata: PluginMetadata;
  modulePath: string;
  loadedAt: number;
  status: 'loaded' | 'failed' | 'unloaded';
  error?: string;
}

export const createPluginManagerV3 = (options: {
  config: LoadedRuntimeConfig;
  hooks: HookRegistry;
  logger?: Logger;
}): PluginManagerV3 => {
  const serviceRegistry = createServiceRegistry();
  const loadedPlugins = new Map<string, PluginInfo>();
  const pluginInstances = new Map<string, JarPluginV3>();
  const diagnostics: PluginDiagnostic[] = [];
  
  // 实现细节...
  
  return {
    async load() {
      // 1. 解析依赖图
      // 2. 拓扑排序
      // 3. 按顺序加载插件
      // 4. 验证能力冲突
      // 5. 执行生命周期钩子
    },
    
    getCapabilityContributions<C extends PluginCapability>(capability: C) {
      const contributions: Array<{ plugin: string; handler: CapabilityHandler<C> }> = [];
      
      for (const [pluginName, plugin] of pluginInstances) {
        const handler = plugin.capabilities[capability];
        if (handler) {
          contributions.push({ plugin: pluginName, handler: handler as CapabilityHandler<C> });
        }
      }
      
      return contributions;
    },
    
    getServiceRegistry() {
      return serviceRegistry;
    },
    
    // 其他方法实现...
  };
};
```

### 6. 执行管道集成

```typescript
// packages/jar-core/src/execution/phase-init-stores-v3.ts

export const initStoresV3 = async (
  config: LoadedRuntimeConfig,
  command: MessageIngressCommand,
  logger?: Logger,
  hooks?: HookRegistry,
): Promise<StoresContext> => {
  // 创建插件管理器
  const pluginManager = createPluginManagerV3({ config, hooks, logger });
  await pluginManager.load();
  
  // 获取插件贡献的技能
  const skillContributions = pluginManager.getCapabilityContributions('skills');
  const pluginSkills: SkillEntry[] = [];
  
  for (const { handler } of skillContributions) {
    const skills = await handler({ config });
    pluginSkills.push(...skills);
  }
  
  // 获取插件贡献的覆盖
  const overlayContributions = pluginManager.getCapabilityContributions('overlays');
  const pluginOverlays: PromptSection[] = [];
  
  for (const { handler } of overlayContributions) {
    const overlays = await handler({ config });
    pluginOverlays.push(...overlays);
  }
  
  return {
    config,
    command,
    logger,
    hooks,
    pluginManager, // 新增：传递给后续阶段
    stateStore: createFileSystemConversationStateStore(),
    auditStore: createFileSystemExecutionAuditStore(),
    eventStore: createFileSystemEventLogStore(),
    usageStore: createFileSystemUsageStore(config.sessions.rootDir),
    startTime: Date.now(),
    pluginSkills: pluginSkills.length > 0 ? pluginSkills : undefined,
    pluginOverlays: pluginOverlays.length > 0 ? pluginOverlays : undefined,
  };
};
```

```typescript
// packages/jar-core/src/execution/resolve-tools-v3.ts

export const resolveMessageToolsV3 = async (
  config: LoadedRuntimeConfig,
  command: MessageIngressCommand,
  pluginManager?: PluginManagerV3,
): Promise<AgentTool[]> => {
  // 默认工具
  const defaultTools = createDefaultTools(config.toolOptions);
  
  // 内存工具
  let memoryTools: AgentTool[] = [];
  if (config.memory.enabled) {
    const entityId = resolveEntityMemoryScope(config, command);
    
    // 尝试从插件获取内存提供者
    let provider: MemoryProvider;
    const memoryProviderContributions = pluginManager?.getCapabilityContributions('memoryProviders') ?? [];
    const customProvider = memoryProviderContributions.find(c => 
      c.plugin === config.memory.provider
    );
    
    if (customProvider) {
      const factory = await customProvider.handler({ providerName: config.memory.provider });
      provider = await factory({
        providerName: config.memory.provider,
        providerConfig: config.memory.providers[config.memory.provider] ?? {},
      });
    } else {
      provider = await resolveConfiguredMemoryProvider(config);
    }
    
    memoryTools = createMemoryTools(entityId, provider);
  }
  
  // 插件贡献的工具
  let pluginTools: AgentTool[] = [];
  if (pluginManager) {
    const toolContributions = pluginManager.getCapabilityContributions('tools');
    for (const { handler } of toolContributions) {
      const tools = await handler({ config, command });
      pluginTools.push(...tools);
    }
  }
  
  return [...defaultTools, ...memoryTools, ...pluginTools];
};
```

### 7. 配置模式更新

```toml
# jarvis.toml

# V3 插件配置
[[plugins]]
module = "./my-plugin.js"
enabled = true

[plugins.config]
apiKey = "secret"
timeout = 5000

[[plugins]]
module = "@hijarvis/plugin-redis"
version = "^1.0.0"  # 可选：版本约束
enabled = true

[plugins.config]
host = "localhost"
port = 6379

# 插件全局设置
[plugins.settings]
failureMode = "isolate"  # "isolate" | "fail_fast"
loadTimeout = 30000
dependencyResolution = "strict"  # "strict" | "loose"
```

### 8. 示例插件

```typescript
// examples/redis-cache-plugin.ts

import type { JarPluginV3, PluginFactoryV3 } from '@hijarvis/jar-core/plugins';
import Redis from 'ioredis';

export const createPlugin: PluginFactoryV3 = (config) => {
  const redis = new Redis({
    host: config.host as string ?? 'localhost',
    port: config.port as number ?? 6379,
  });
  
  const plugin: JarPluginV3 = {
    metadata: {
      name: 'redis-cache',
      version: '1.0.0',
      description: 'Redis-based caching and memory provider',
      apiVersion: '^3.0.0',
      capabilities: ['tools', 'memoryProviders', 'services', 'hooks'],
      configSchema: {
        type: 'object',
        properties: {
          host: { type: 'string' },
          port: { type: 'number' },
          ttl: { type: 'number' },
        },
        required: ['host', 'port'],
      },
    },
    
    capabilities: {
      // 贡献缓存工具
      tools: async ({ config, command }) => {
        return [{
          name: 'redis_cache',
          description: 'Cache data in Redis',
          parameters: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
              ttl: { type: 'number' },
            },
            required: ['key', 'value'],
          },
          handler: async ({ key, value, ttl }) => {
            await redis.setex(key, ttl ?? 3600, value);
            return `Cached ${key} for ${ttl ?? 3600} seconds`;
          },
        }];
      },
      
      // 贡献 Redis 内存提供者
      memoryProviders: async ({ providerName }) => {
        if (providerName !== 'redis') return null;
        
        return ({ providerConfig }) => new RedisMemoryProvider({
          redis,
          keyPrefix: providerConfig.keyPrefix as string ?? 'hijarvis:memory:',
        });
      },
      
      // 注册 Redis 服务
      services: async ({ registry }) => {
        registry.register('redis', redis, { 
          type: 'database',
          connection: `${config.host}:${config.port}`,
        });
      },
      
      // 注册性能监控钩子
      hooks: async ({ registry }) => {
        registry.register({
          point: 'tool:before',
          name: 'redis-cache:performance-monitor',
          handler: async ({ toolName }) => {
            const start = Date.now();
            return { metadata: { startTime: start } };
          },
        });
        
        registry.register({
          point: 'tool:after',
          name: 'redis-cache:performance-log',
          handler: async ({ toolName, result, metadata }) => {
            const duration = Date.now() - (metadata?.startTime as number ?? 0);
            await redis.zadd('tool_performance', duration, `${toolName}:${Date.now()}`);
          },
        });
      },
    },
    
    lifecycle: {
      beforeLoad: async ({ logger }) => {
        logger?.info('redis-cache: Connecting to Redis...');
        await redis.ping();
      },
      
      afterLoad: async ({ logger }) => {
        logger?.info('redis-cache: Plugin loaded successfully');
      },
    },
    
    cleanup: async () => {
      await redis.quit();
    },
  };
  
  return plugin;
};
```

## 🚀 迁移策略

### 阶段 1：基础架构
1. 实现新的类型定义和接口
2. 创建 PluginManagerV3 和 ServiceRegistry
3. 更新配置解析器支持新格式

### 阶段 2：执行管道集成
1. 修改 `phase-init-stores.ts` 使用新插件管理器
2. 更新 `resolve-tools.ts` 支持插件工具贡献
3. 修改 `phase-prepare-prompt.ts` 支持插件技能贡献

### 阶段 3：网关激活
1. 更新 `jar-cli`、`jar-slack`、`jar-telegram` 创建 HookRegistry
2. 在网关中实例化 PluginManagerV3
3. 添加插件诊断 API

### 阶段 4：高级特性
1. 实现依赖解析和冲突检测
2. 添加动态插件加载/卸载
3. 实现配置验证和 API 版本检查

## 🎯 关键优势

1. **类型安全**：完全类型化的能力系统，编译时检查
2. **能力导向**：插件可以扩展系统的任何方面
3. **依赖管理**：明确的依赖关系和冲突检测
4. **服务化**：插件可以注册长期运行的服务
5. **诊断友好**：丰富的调试信息和错误处理
6. **向后兼容**：可以与现有系统共存，逐步迁移

这个设计将 HiJarvis 从一个"行为修改"框架转变为一个真正的"能力扩展"平台。