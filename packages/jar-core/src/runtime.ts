import { Agent, type AgentTool, type BeforeToolCallContext, type BeforeToolCallResult, type AfterToolCallContext, type AfterToolCallResult, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getModels, getProviders, type Api, type KnownProvider, type Model, type Provider } from "@mariozechner/pi-ai";

import {
  createCompactionTransform,
  defaultCompactionSettings,
  type CompactionEvent,
  type CompactionSettings,
} from "./compaction/index.js";
import type { Logger } from "./logger.js";
import { buildSystemPrompt, type PromptSection } from "./prompt-builder.js";
import { stripMemoryExcludedPromptContextFromHistory } from "./prompt-context.js";
import type { PromptExecutionPolicy } from "./prompt-executor.js";

export type RuntimeProviderConfig = {
  api?: Api;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: Record<string, RuntimeModelConfig>;
};

export type RuntimeModelConfig = {
  name?: string;
  api?: Api;
  baseUrl?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  toolCall?: boolean;
};

/** Static agent configuration — loaded from config, does not change per request. */
export type JarAgentConfig = {
  provider: Provider;
  model: string;
  systemPrompt: string;
  systemPromptOverlays?: PromptSection[];
  thinkingLevel: ThinkingLevel;
  providerConfig: RuntimeProviderConfig;
  execution: PromptExecutionPolicy;
  compaction?: CompactionSettings;
};

/** Full runtime options — agent config + per-request parameters. */
export type JarRuntimeOptions = JarAgentConfig & {
  tools: AgentTool[];
  logger?: Logger;
  compactionEventSink?: (event: CompactionEvent) => void;
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
};

export const createAgent = (config: JarRuntimeOptions): Agent => {
  const model = resolveConfiguredModel(config);
  assertToolSupport(config, model);
  const compactionSettings =
    config.compaction ?? defaultCompactionSettings;
  const systemPrompt = buildSystemPrompt({
    basePrompt: config.systemPrompt,
    sections: config.systemPromptOverlays ?? [],
  });
  const compactionRuntime = {
    model,
    systemPrompt,
    settings: compactionSettings,
    apiKey: config.providerConfig.apiKey,
    logger: config.logger,
  };

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: config.thinkingLevel,
      tools: config.tools,
    },
    maxRetryDelayMs: config.execution.retryMaxDelayMs,
    beforeToolCall: config.beforeToolCall,
    afterToolCall: config.afterToolCall,
    getApiKey: (provider) => {
      if (provider !== config.provider) {
        return undefined;
      }

      return config.providerConfig.apiKey;
    },
  });

  const compactContext = createCompactionTransform({
    ...compactionRuntime,
    onCompaction: (event, messages) => {
      agent.state.messages = messages;
      config.compactionEventSink?.(event);
    },
  });
  agent.transformContext = async (messages, signal) => {
    const sanitizedMessages = stripMemoryExcludedPromptContextFromHistory(messages);
    return compactContext(sanitizedMessages, signal);
  };

  return agent;
};

export const supportsModelInput = (
  provider: Provider,
  modelId: string,
  inputType: "text" | "image",
  providerConfig: RuntimeProviderConfig = {},
): boolean => {
  try {
    const model = resolveConfiguredModel({
      provider,
      model: modelId,
      providerConfig,
    });
    return model.input.includes(inputType);
  } catch {
    return false;
  }
};

const resolveConfiguredModel = (config: Pick<JarRuntimeOptions, "provider" | "model" | "providerConfig">): Model<any> => {
  const registryModel = lookupRegistryModel(config.provider, config.model);
  const modelConfig = config.providerConfig.models?.[config.model];

  if (registryModel === undefined && modelConfig === undefined) {
    throw new Error(
      `Unable to resolve model "${config.model}" for provider "${config.provider}"`,
    );
  }

  if (registryModel !== undefined) {
    return applyModelConfig(registryModel, config.providerConfig, modelConfig);
  }

  return createConfiguredModel(config.provider, config.model, config.providerConfig, modelConfig);
};

const lookupRegistryModel = (
  provider: Provider,
  modelId: string,
): Model<any> | undefined => {
  if (!isKnownProvider(provider)) {
    return undefined;
  }

  return getModels(provider).find((candidate) => candidate.id === modelId);
};

const isKnownProvider = (provider: Provider): provider is KnownProvider => {
  return (getProviders() as string[]).includes(provider);
};

const applyModelConfig = (
  model: Model<any>,
  providerConfig: RuntimeProviderConfig,
  modelConfig: RuntimeModelConfig | undefined,
): Model<any> => {
  return {
    ...model,
    name: modelConfig?.name ?? model.name,
    api: modelConfig?.api ?? providerConfig.api ?? model.api,
    baseUrl: modelConfig?.baseUrl ?? providerConfig.baseUrl ?? model.baseUrl,
    reasoning: modelConfig?.reasoning ?? model.reasoning,
    input: modelConfig?.input ?? model.input,
    cost: {
      input: modelConfig?.cost?.input ?? model.cost.input,
      output: modelConfig?.cost?.output ?? model.cost.output,
      cacheRead: modelConfig?.cost?.cacheRead ?? model.cost.cacheRead,
      cacheWrite: modelConfig?.cost?.cacheWrite ?? model.cost.cacheWrite,
    },
    contextWindow: modelConfig?.contextWindow ?? model.contextWindow,
    maxTokens: modelConfig?.maxTokens ?? model.maxTokens,
    headers: mergeHeaders(providerConfig.headers, model.headers, modelConfig?.headers),
    compat: modelConfig?.compat ?? providerConfig.compat ?? model.compat,
  };
};

const createConfiguredModel = (
  provider: Provider,
  modelId: string,
  providerConfig: RuntimeProviderConfig,
  modelConfig: RuntimeModelConfig | undefined,
): Model<any> => {
  if (modelConfig === undefined) {
    throw new Error(`Missing model config for "${modelId}"`);
  }

  const api = modelConfig.api ?? providerConfig.api;
  if (api === undefined) {
    throw new Error(
      `Model "${modelId}" for provider "${provider}" must configure api`,
    );
  }

  const baseUrl = modelConfig.baseUrl ?? providerConfig.baseUrl;
  if (baseUrl === undefined) {
    throw new Error(
      `Model "${modelId}" for provider "${provider}" must configure baseUrl`,
    );
  }

  if (modelConfig.contextWindow === undefined) {
    throw new Error(
      `Model "${modelId}" for provider "${provider}" must configure contextWindow`,
    );
  }

  if (modelConfig.maxTokens === undefined) {
    throw new Error(
      `Model "${modelId}" for provider "${provider}" must configure maxTokens`,
    );
  }

  return {
    id: modelId,
    name: modelConfig.name ?? modelId,
    api,
    provider,
    baseUrl,
    reasoning: modelConfig.reasoning ?? false,
    input: modelConfig.input ?? ["text"],
    cost: {
      input: modelConfig.cost?.input ?? 0,
      output: modelConfig.cost?.output ?? 0,
      cacheRead: modelConfig.cost?.cacheRead ?? 0,
      cacheWrite: modelConfig.cost?.cacheWrite ?? 0,
    },
    contextWindow: modelConfig.contextWindow,
    maxTokens: modelConfig.maxTokens,
    headers: mergeHeaders(providerConfig.headers, modelConfig.headers),
    compat: modelConfig.compat ?? providerConfig.compat,
  };
};

const mergeHeaders = (
  ...sources: Array<Record<string, string> | undefined>
): Record<string, string> | undefined => {
  const entries = sources.flatMap((source) => Object.entries(source ?? {}));
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
};

const assertToolSupport = (
  config: Pick<JarRuntimeOptions, "model" | "tools" | "providerConfig">,
  model: Model<any>,
): void => {
  const modelConfig = config.providerConfig.models?.[config.model];
  if (modelConfig?.toolCall === false && config.tools.length > 0) {
    throw new Error(
      `Model "${model.id}" for provider "${model.provider}" does not support tool calls`,
    );
  }
};
