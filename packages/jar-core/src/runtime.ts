import { Agent, type AgentTool, type BeforeToolCallContext, type BeforeToolCallResult, type AfterToolCallContext, type AfterToolCallResult, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getModels, type KnownProvider, type Model } from "@mariozechner/pi-ai";

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
  apiKey?: string;
  baseUrl?: string;
};

/** Static agent configuration — loaded from config, does not change per request. */
export type JarAgentConfig = {
  provider: KnownProvider;
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
  provider: KnownProvider,
  modelId: string,
  inputType: "text" | "image",
): boolean => {
  const model = getModels(provider).find((candidate) => candidate.id === modelId);
  return model?.input.includes(inputType) ?? false;
};

const resolveConfiguredModel = (config: JarRuntimeOptions): Model<any> => {
  const model = getModels(config.provider).find(
    (candidate) => candidate.id === config.model,
  );
  if (model === undefined) {
    throw new Error(
      `Unable to resolve model "${config.model}" for provider "${config.provider}"`,
    );
  }

  if (config.providerConfig.baseUrl === undefined) {
    return model;
  }

  return {
    ...model,
    baseUrl: config.providerConfig.baseUrl,
  };
};
