import { readFile } from "node:fs/promises";
import path from "node:path";

import { logLevels, type LogLevel } from "./logger.js";
import type { PromptExecutionPolicy } from "./prompt-executor.js";
import type {
  JarAgentConfig,
  RuntimeModelConfig,
  RuntimeProviderConfig,
} from "./runtime.js";
import {
  defaultCompactionSettings,
  type CompactionSettings,
} from "./compaction/index.js";
import {
  resolveSkillsRuntime,
  type SkillsRuntime,
  type SkillsConfigInput,
} from "./skills.js";
import { getModels, getProviders, type Api, type KnownProvider, type Provider } from "@mariozechner/pi-ai";
import { parse } from "smol-toml";
import { z } from "zod";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ToolOptions } from "./tools.js";

const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ThinkingLevel[];

const nonEmptyString = z.string().trim().min(1);

const compactionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  trigger_ratio: z.number().min(0).max(1).optional(),
  budget_ratio: z.number().min(0).max(1).optional(),
  summary_max_tokens: z.number().int().positive().optional(),
}).strict();

const skillsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  roots: z.array(nonEmptyString).optional(),
  max_scan_depth: z.number().int().min(0).optional(),
  max_skills: z.number().int().positive().optional(),
  max_catalog_chars: z.number().int().positive().optional(),
  max_body_chars: z.number().int().positive().optional(),
}).strict();

const memoryConfigSchema = z.object({
  enabled: z.boolean().optional(),
  provider: nonEmptyString.optional(),
  root_dir: nonEmptyString.optional(),
  providers: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
}).strict();

const entityConfigSchema = z.object({
  display_name: nonEmptyString.optional(),
  system_prompt: nonEmptyString.optional(),
}).strict();

const pluginEntrySchema = z.union([
  nonEmptyString,
  z.object({
    module: nonEmptyString,
    config: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
]);

const rawConfigSchema = z.object({
  agent: z.object({
    provider: nonEmptyString,
    model: nonEmptyString,
    system_prompt: nonEmptyString,
    thinking_level: z.enum(thinkingLevels).default("minimal"),
    request_timeout_ms: z.number().int().positive().optional(),
    retry_attempts: z.number().int().min(0).optional(),
    retry_initial_delay_ms: z.number().int().positive().optional(),
    retry_backoff_multiplier: z.number().min(1).optional(),
    retry_max_delay_ms: z.number().int().positive().optional(),
    compaction: compactionConfigSchema.optional(),
  }).strict(),
  provider: z.record(z.string(), z.unknown()).default({}),
  platform: z.record(z.string(), z.unknown()).default({}),
  logging: z.object({
    level: z.enum(logLevels).optional(),
    stderr: z.boolean().optional(),
    file_path: nonEmptyString.optional(),
  }).strict().default({}),
  sessions: z.object({
    root_dir: nonEmptyString.optional(),
    // WARNING: raw event traces capture streaming deltas and can grow very large.
    // Keep this off unless you explicitly need low-level event debugging.
    record_events: z.boolean().optional(),
  }).strict().default({}),
  tools: z.object({
    workspace_root: nonEmptyString.optional(),
    max_file_bytes: z.number().int().positive().optional(),
    command_timeout_ms: z.number().int().positive().optional(),
    max_command_output_bytes: z.number().int().positive().optional(),
    web_request_timeout_ms: z.number().int().positive().optional(),
    max_web_response_bytes: z.number().int().positive().optional(),
    max_concurrent_shells: z.number().int().positive().optional(),
  }).strict().default({}),
  memory: memoryConfigSchema.default({}),
  skills: skillsConfigSchema.default({}),
  plugins: z.array(pluginEntrySchema).default([]),
  entities: z.record(nonEmptyString, entityConfigSchema).default({}),
}).strict();

type RawConfig = z.infer<typeof rawConfigSchema>;

const providerModelCostSchema = z.object({
  input: z.number().min(0).optional(),
  output: z.number().min(0).optional(),
  cache_read: z.number().min(0).optional(),
  cache_write: z.number().min(0).optional(),
  cacheRead: z.number().min(0).optional(),
  cacheWrite: z.number().min(0).optional(),
}).loose();

const providerModelLimitSchema = z.object({
  context: z.number().int().positive().optional(),
  output: z.number().int().positive().optional(),
}).loose();

const providerModelModalitiesSchema = z.object({
  input: z.array(nonEmptyString).optional(),
}).loose();

const providerModelSchema = z.object({
  id: nonEmptyString.optional(),
  name: nonEmptyString.optional(),
  api: nonEmptyString.optional(),
  base_url: z.string().trim().url().optional(),
  baseUrl: z.string().trim().url().optional(),
  reasoning: z.boolean().optional(),
  vision: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  toolCall: z.boolean().optional(),
  input: z.array(z.enum(["text", "image"])).optional(),
  context_window: z.number().int().positive().optional(),
  contextWindow: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  cost: providerModelCostSchema.optional(),
  limit: providerModelLimitSchema.optional(),
  modalities: providerModelModalitiesSchema.optional(),
  headers: z.record(nonEmptyString, nonEmptyString).optional(),
  compat: z.record(z.string(), z.unknown()).optional(),
}).loose();

const providerConfigSchema = z.object({
  api_key: nonEmptyString.optional(),
  base_url: z.string().trim().url().optional(),
  api: nonEmptyString.optional(),
  headers: z.record(nonEmptyString, nonEmptyString).optional(),
  compat: z.record(z.string(), z.unknown()).optional(),
  models: z.record(nonEmptyString, providerModelSchema).optional(),
}).loose();

export type LoadedBaseConfig = {
  configFilePath: string;
  logging: {
    level: LogLevel;
    stderr: boolean;
    filePath?: string;
  };
  agent: JarAgentConfig & { compaction: CompactionSettings };
  skillsConfig: SkillsConfigInput;
  toolOptions: ToolOptions;
  sessions: {
    rootDir: string;
    recordEvents: boolean;
  };
  memory: LoadedMemoryConfig;
  plugins: Array<{ module: string; config: Record<string, unknown> }>;
  entities: Record<string, LoadedEntityConfig>;
  platformIdentities: Record<string, PlatformIdentityRef>;
  platform: Record<string, unknown>;
};

export type LoadedRuntimeConfig = Omit<LoadedBaseConfig, "skillsConfig"> & {
  skills: SkillsRuntime;
};

export type LoadedMemoryConfig = {
  enabled: boolean;
  provider: string;
  providers: Record<string, Record<string, unknown>>;
};

export type LoadedEntityConfig = {
  id: string;
  displayName: string;
  systemPrompt?: string;
};

export type PlatformIdentityRef = {
  id: string;
  platform: string;
  entityId: string;
};

export type DefaultRuntimeConfigOptions = {
  provider: string;
  model: string;
  systemPrompt: string;
  api?: Api;
  apiKey?: string;
  baseUrl?: string;
  models?: Record<string, RuntimeModelConfig>;
  thinkingLevel?: ThinkingLevel;
  sessionsRootDir?: string;
  workspaceRoot?: string;
  /** Extra environment variables injected into every spawned shell subprocess. */
  extraShellEnv?: Record<string, string>;
};

export const loadBaseConfig = async (
  configFilePath: string,
): Promise<LoadedBaseConfig> => {
  const absoluteConfigPath = path.resolve(configFilePath);
  const configFileContent = await readFile(absoluteConfigPath, "utf8");
  const parsedToml = parse(configFileContent) as Record<string, unknown>;
  const parsedConfig = parseRawConfig(parsedToml);

  const providerConfig = parseProviderConfig(parsedConfig.provider, parsedConfig.agent.provider);
  const provider = parseProvider(parsedConfig.agent.provider, providerConfig);
  const execution = parseExecutionConfig(parsedConfig.agent);
  const compaction = parseCompactionConfig(parsedConfig.agent);
  const model = parseModel(provider, parsedConfig.agent.model, providerConfig);
  const configDirectory = path.dirname(absoluteConfigPath);
  const sessionRoot = path.resolve(
    configDirectory,
    parsedConfig.sessions.root_dir ?? ".jar/sessions",
  );
  const memoryConfig = normalizeMemoryConfig(parsedConfig.memory, configDirectory);
  const pluginsConfig = normalizePluginsConfig(parsedConfig.plugins, configDirectory);

  return {
    configFilePath: absoluteConfigPath,
    logging: {
      level: parsedConfig.logging.level ?? "info",
      stderr: parsedConfig.logging.stderr ?? true,
      filePath: parsedConfig.logging.file_path === undefined
        ? undefined
        : path.resolve(configDirectory, parsedConfig.logging.file_path),
    },
    agent: {
      provider,
      model,
      systemPrompt: parsedConfig.agent.system_prompt,
      thinkingLevel: parsedConfig.agent.thinking_level,
      providerConfig,
      execution,
      compaction,
    },
    skillsConfig: normalizeSkillsConfig(parsedConfig.skills),
    toolOptions: {
      provider,
      model,
      providerBaseUrl: providerConfig.baseUrl,
      providerApiKey: providerConfig.apiKey,
      workspaceRoot: path.resolve(
        configDirectory,
        parsedConfig.tools.workspace_root ?? ".",
      ),
      maxFileBytes: parsedConfig.tools.max_file_bytes ?? 32_768,
      commandTimeoutMs: parsedConfig.tools.command_timeout_ms ?? 30_000,
      maxCommandOutputBytes:
        parsedConfig.tools.max_command_output_bytes ?? 32_768,
      webRequestTimeoutMs: parsedConfig.tools.web_request_timeout_ms ?? 30_000,
      maxWebResponseBytes: parsedConfig.tools.max_web_response_bytes ?? 65_536,
      maxConcurrentShells: parsedConfig.tools.max_concurrent_shells ?? 10,
    },
    sessions: {
      rootDir: sessionRoot,
      recordEvents: parsedConfig.sessions.record_events ?? false,
    },
    memory: memoryConfig,
    plugins: pluginsConfig,
    entities: normalizeEntitiesConfig(parsedConfig.entities),
    platformIdentities: normalizePlatformIdentities(
      parsedConfig.platform,
      normalizeEntitiesConfig(parsedConfig.entities),
    ),
    platform: parsedConfig.platform,
  };
};

const normalizePluginsConfig = (
  plugins: RawConfig["plugins"],
  configDirectory: string,
): Array<{ module: string; config: Record<string, unknown> }> => {
  return plugins.map((entry) => {
    if (typeof entry === "string") {
      const modulePath = normalizePluginModule(entry, configDirectory);
      return { module: modulePath, config: {} };
    }
    const modulePath = normalizePluginModule(entry.module, configDirectory);
    return { module: modulePath, config: entry.config ?? {} };
  });
};

const normalizePluginModule = (modulePath: string, configDirectory: string): string => {
  if (path.isAbsolute(modulePath)) {
    return modulePath;
  }

  if (modulePath.startsWith("./") || modulePath.startsWith("../")) {
    return path.resolve(configDirectory, modulePath);
  }

  return modulePath;
};

const normalizeMemoryConfig = (
  memory: RawConfig["memory"],
  configDirectory: string,
): LoadedMemoryConfig => {
  const normalizedProviders = Object.fromEntries(
    Object.entries(memory.providers ?? {}).map(([providerName, providerConfig]) => [
      providerName,
      normalizeMemoryProviderConfig(providerName, providerConfig, configDirectory),
    ]),
  );

  const filesystemRootDir = path.resolve(
    configDirectory,
    memory.root_dir ?? (
      typeof normalizedProviders.filesystem?.rootDir === "string"
        ? normalizedProviders.filesystem.rootDir
        : ".jar/memory"
    ),
  );

  return {
    enabled: memory.enabled ?? true,
    provider: memory.provider ?? "filesystem",
    providers: {
      filesystem: {
        ...(normalizedProviders.filesystem ?? {}),
        rootDir: filesystemRootDir,
      },
      ...Object.fromEntries(
        Object.entries(normalizedProviders).filter(([providerName]) => providerName !== "filesystem"),
      ),
    },
  };
};

const normalizeMemoryProviderConfig = (
  providerName: string,
  providerConfig: Record<string, unknown>,
  configDirectory: string,
): Record<string, unknown> => {
  const entries = Object.entries(providerConfig).map(([key, value]) => {
    if (providerName === "filesystem" && key === "root_dir" && typeof value === "string") {
      return ["rootDir", path.resolve(configDirectory, value)] satisfies [string, unknown];
    }

    if (key === "module" && typeof value === "string" && value.trim().length > 0) {
      const resolvedValue = path.isAbsolute(value) ? value : path.resolve(configDirectory, value);
      return [key, resolvedValue] satisfies [string, unknown];
    }

    return [key, value] satisfies [string, unknown];
  });

  return Object.fromEntries(entries);
};

export const resolveSkillsFromConfig = async (
  baseConfig: LoadedBaseConfig,
): Promise<SkillsRuntime> => {
  const configDirectory = path.dirname(baseConfig.configFilePath);
  return resolveSkillsRuntime(baseConfig.skillsConfig, configDirectory);
};

export const loadRuntimeConfig = async (
  configFilePath: string,
): Promise<LoadedRuntimeConfig> => {
  const baseConfig = await loadBaseConfig(configFilePath);
  const skills = await resolveSkillsFromConfig(baseConfig);
  const { skillsConfig: _, ...rest } = baseConfig;
  return {
    ...rest,
    agent: rest.agent,
    skills,
  };
};

export type LoadedAgentConfig = LoadedRuntimeConfig;

export const loadAgentConfig = loadRuntimeConfig;

export const defaultRuntimeConfig = async (
  options: DefaultRuntimeConfigOptions,
): Promise<LoadedRuntimeConfig> => {
  const inlineProviderConfig = {
    api: options.api,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    models: options.models,
  } satisfies RuntimeProviderConfig;
  const provider = parseProvider(options.provider, inlineProviderConfig);
  const model = parseModel(provider, options.model, inlineProviderConfig);
  const cwd = process.cwd();

  return {
    configFilePath: "",
    logging: { level: "info", stderr: true },
    agent: {
      provider,
      model,
      systemPrompt: options.systemPrompt,
      thinkingLevel: options.thinkingLevel ?? "minimal",
      providerConfig: {
        ...(options.api === undefined ? {} : { api: options.api }),
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        ...(options.models === undefined ? {} : { models: options.models }),
      },
      execution: {
        requestTimeoutMs: 120_000,
        retryAttempts: 5,
        retryInitialDelayMs: 1_000,
        retryBackoffMultiplier: 2,
        retryMaxDelayMs: 30_000,
      },
      compaction: { ...defaultCompactionSettings },
    },
    toolOptions: {
      provider,
      model,
      providerBaseUrl: options.baseUrl,
      providerApiKey: options.apiKey,
      workspaceRoot: options.workspaceRoot ?? cwd,
      maxFileBytes: 32_768,
      commandTimeoutMs: 30_000,
      maxCommandOutputBytes: 32_768,
      webRequestTimeoutMs: 30_000,
      maxWebResponseBytes: 65_536,
      maxConcurrentShells: 10,
      ...(options.extraShellEnv ? { extraShellEnv: options.extraShellEnv } : {}),
    },
    sessions: {
      rootDir: options.sessionsRootDir ?? path.resolve(cwd, ".jar/sessions"),
      recordEvents: false,
    },
    memory: {
      enabled: false,
      provider: "filesystem",
      providers: {},
    },
    plugins: [],
    entities: {},
    platformIdentities: {},
    platform: {},
    skills: await resolveSkillsRuntime({ enabled: false }, cwd),
  };
};

const parseRawConfig = (input: Record<string, unknown>): RawConfig => {
  const result = rawConfigSchema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  const message = result.error.issues
    .map((issue) => {
      const fieldPath = issue.path.length > 0 ? issue.path.join(".") : "config";
      return `${fieldPath}: ${issue.message}`;
    })
    .join("\n");

  throw new Error(`Invalid TOML config:\n${message}`);
};

const parseProvider = (
  value: string,
  providerConfig: RuntimeProviderConfig,
): Provider => {
  const providers = new Set<string>(getProviders());
  if (!providers.has(value)) {
    if (providerConfig.api !== undefined) {
      return value;
    }

    throw new Error(
      `Unsupported provider "${value}". Configure provider.${value}.api for custom OpenAI-compatible or Anthropic-compatible providers. Available built-in providers: ${[
        ...providers,
      ].join(", ")}`,
    );
  }

  return value;
};

const parseModel = (
  provider: Provider,
  value: string,
  providerConfig: RuntimeProviderConfig,
): string => {
  const availableModels = isKnownProvider(provider)
    ? getModels(provider).map((candidate) => candidate.id)
    : [];
  const configuredModels = providerConfig.models ?? {};

  if (!availableModels.includes(value) && configuredModels[value] === undefined) {
    throw new Error(
      `Unsupported model "${value}" for provider "${provider}". Configure provider.${provider}.models."${value}" for custom models. Known models include: ${availableModels
        .slice(0, 20)
        .join(", ")}`,
    );
  }

  return value;
};

const isKnownProvider = (provider: Provider): provider is KnownProvider => {
  return (getProviders() as string[]).includes(provider);
};

const parseExecutionConfig = (
  agentConfig: RawConfig["agent"],
): PromptExecutionPolicy => {
  const execution = {
    requestTimeoutMs: agentConfig.request_timeout_ms ?? 120_000,
    retryAttempts: agentConfig.retry_attempts ?? 5,
    retryInitialDelayMs: agentConfig.retry_initial_delay_ms ?? 1_000,
    retryBackoffMultiplier: agentConfig.retry_backoff_multiplier ?? 2,
    retryMaxDelayMs: agentConfig.retry_max_delay_ms ?? 30_000,
  };

  if (execution.retryMaxDelayMs < execution.retryInitialDelayMs) {
    throw new Error(
      "Invalid TOML config:\nagent.retry_max_delay_ms must be greater than or equal to agent.retry_initial_delay_ms",
    );
  }

  return execution;
};

const normalizeEntitiesConfig = (
  entities: RawConfig["entities"],
): Record<string, LoadedEntityConfig> => {
  const entries = Object.entries(entities);
  if (entries.length === 0) {
    throw new Error("Invalid TOML config:\nAt least one entity must be configured");
  }

  return Object.fromEntries(entries.map(([id, entity]) => [id, {
    id,
    displayName: entity.display_name ?? id,
    systemPrompt: entity.system_prompt,
  } satisfies LoadedEntityConfig]));
};

const platformIdentityBaseSchema = z.looseObject({
  entity: nonEmptyString,
});

const normalizePlatformIdentities = (
  platform: RawConfig["platform"],
  entities: Record<string, LoadedEntityConfig>,
): Record<string, PlatformIdentityRef> => {
  const identities: Record<string, PlatformIdentityRef> = {};

  for (const [platformName, platformRaw] of Object.entries(platform)) {
    const parsed = z.looseObject({
      identities: z.record(nonEmptyString, platformIdentityBaseSchema),
    }).safeParse(platformRaw);
    if (!parsed.success) {
      throw new Error(
        `Invalid TOML config:\n${formatIssues(parsed.error.issues, `platform.${platformName}`)}`,
      );
    }

    for (const [id, identity] of Object.entries(parsed.data.identities)) {
      assertIdentityEntityExists(id, identity.entity, entities);
      identities[id] = {
        id,
        platform: platformName,
        entityId: identity.entity,
      };
    }
  }

  return identities;
};

const assertIdentityEntityExists = (
  identityId: string,
  entityId: string,
  entities: Record<string, LoadedEntityConfig>,
): void => {
  if (entities[entityId] !== undefined) {
    return;
  }

  throw new Error(
    `Invalid TOML config:\nplatform identity \"${identityId}\" references unknown entity \"${entityId}\"`,
  );
};

const formatIssues = (
  issues: Array<{ path: PropertyKey[]; message: string }>,
  prefix: string,
): string => {
  return issues.map((issue) => {
    const suffix = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
    return `${prefix}${suffix}: ${issue.message}`;
  }).join("\n");
};

const parseCompactionConfig = (
  agentConfig: RawConfig["agent"],
): CompactionSettings => {
  const raw = agentConfig.compaction ?? {};
  const resolved: CompactionSettings = {
    enabled: raw.enabled ?? defaultCompactionSettings.enabled,
    triggerRatio: raw.trigger_ratio ?? defaultCompactionSettings.triggerRatio,
    budgetRatio: raw.budget_ratio ?? defaultCompactionSettings.budgetRatio,
    summaryMaxTokens:
      raw.summary_max_tokens ?? defaultCompactionSettings.summaryMaxTokens,
  };

  if (resolved.triggerRatio <= 0 || resolved.triggerRatio > 1) {
    throw new Error(
      "Invalid TOML config:\nagent.compaction.trigger_ratio must be between 0 and 1",
    );
  }

  if (resolved.budgetRatio <= 0 || resolved.budgetRatio > 1) {
    throw new Error(
      "Invalid TOML config:\nagent.compaction.budget_ratio must be between 0 and 1",
    );
  }

  if (resolved.budgetRatio > resolved.triggerRatio) {
    throw new Error(
      "Invalid TOML config:\nagent.compaction.budget_ratio must be less than or equal to agent.compaction.trigger_ratio",
    );
  }

  return resolved;
};

const parseProviderConfig = (
  providerTables: RawConfig["provider"],
  provider: string,
): RuntimeProviderConfig => {
  const rawProviderConfig = providerTables[provider];
  if (rawProviderConfig === undefined) {
    return {};
  }

  const result = providerConfigSchema.safeParse(rawProviderConfig);
  if (result.success) {
    return providerConfigToRuntime(result.data);
  }

  const message = result.error.issues
    .map((issue) => {
      const suffix = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
      return `provider.${provider}${suffix}: ${issue.message}`;
    })
    .join("\n");

  throw new Error(`Invalid TOML config:\n${message}`);
};

const providerConfigToRuntime = (
  providerConfig: z.infer<typeof providerConfigSchema>,
): RuntimeProviderConfig => {
  return {
    ...(providerConfig.api === undefined ? {} : { api: providerConfig.api as Api }),
    apiKey: providerConfig.api_key,
    baseUrl: providerConfig.base_url,
    ...(providerConfig.headers === undefined ? {} : { headers: providerConfig.headers }),
    ...(providerConfig.compat === undefined ? {} : { compat: providerConfig.compat }),
    ...(providerConfig.models === undefined
      ? {}
      : { models: normalizeProviderModels(providerConfig.models) }),
  };
};

const normalizeProviderModels = (
  models: Record<string, z.infer<typeof providerModelSchema>>,
): Record<string, RuntimeModelConfig> => {
  return Object.fromEntries(
    Object.entries(models).map(([modelId, model]) => [
      modelId,
      normalizeProviderModel(model),
    ]),
  );
};

const normalizeProviderModel = (
  model: z.infer<typeof providerModelSchema>,
): RuntimeModelConfig => {
  return {
    ...(model.name === undefined ? {} : { name: model.name }),
    ...(model.api === undefined ? {} : { api: model.api as Api }),
    ...(readModelBaseUrl(model) === undefined ? {} : { baseUrl: readModelBaseUrl(model) }),
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    ...(readModelInput(model) === undefined ? {} : { input: readModelInput(model) }),
    ...(readModelCost(model) === undefined ? {} : { cost: readModelCost(model) }),
    ...(readContextWindow(model) === undefined ? {} : { contextWindow: readContextWindow(model) }),
    ...(readMaxTokens(model) === undefined ? {} : { maxTokens: readMaxTokens(model) }),
    ...(model.headers === undefined ? {} : { headers: model.headers }),
    ...(model.compat === undefined ? {} : { compat: model.compat }),
    ...(readToolCallSupport(model) === undefined ? {} : { toolCall: readToolCallSupport(model) }),
  };
};

const readModelBaseUrl = (
  model: z.infer<typeof providerModelSchema>,
): string | undefined => model.base_url ?? model.baseUrl;

const readContextWindow = (
  model: z.infer<typeof providerModelSchema>,
): number | undefined => model.context_window ?? model.contextWindow ?? model.limit?.context;

const readMaxTokens = (
  model: z.infer<typeof providerModelSchema>,
): number | undefined => model.max_tokens ?? model.maxTokens ?? model.limit?.output;

const readToolCallSupport = (
  model: z.infer<typeof providerModelSchema>,
): boolean | undefined => model.tool_call ?? model.toolCall;

const readModelInput = (
  model: z.infer<typeof providerModelSchema>,
): Array<"text" | "image"> | undefined => {
  if (model.input !== undefined) {
    return model.input;
  }

  const input = model.modalities?.input;
  if (input !== undefined) {
    const supportedInput = input.filter(
      (item): item is "text" | "image" => item === "text" || item === "image",
    );
    if (supportedInput.length > 0) {
      return supportedInput;
    }
  }

  if (model.vision !== undefined) {
    return model.vision ? ["text", "image"] : ["text"];
  }

  return undefined;
};

const readModelCost = (
  model: z.infer<typeof providerModelSchema>,
): RuntimeModelConfig["cost"] | undefined => {
  const cost = model.cost;
  if (cost === undefined) {
    return undefined;
  }

  return {
    ...(cost.input === undefined ? {} : { input: cost.input }),
    ...(cost.output === undefined ? {} : { output: cost.output }),
    ...((cost.cache_read ?? cost.cacheRead) === undefined
      ? {}
      : { cacheRead: cost.cache_read ?? cost.cacheRead }),
    ...((cost.cache_write ?? cost.cacheWrite) === undefined
      ? {}
      : { cacheWrite: cost.cache_write ?? cost.cacheWrite }),
  };
};

const normalizeSkillsConfig = (
  config: RawConfig["skills"],
): SkillsConfigInput => {
  return {
    enabled: config.enabled,
    roots: config.roots,
    maxScanDepth: config.max_scan_depth,
    maxSkills: config.max_skills,
    maxCatalogChars: config.max_catalog_chars,
    maxBodyChars: config.max_body_chars,
  };
};
