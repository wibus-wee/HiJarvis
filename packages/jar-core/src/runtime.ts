import { Agent, type AgentTool, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getModels, type KnownProvider, type Model } from "@mariozechner/pi-ai";

import {
  createCompactionTransform,
  defaultCompactionSettings,
  type CompactionEvent,
  type CompactionSettings,
} from "./compaction.js";
import type { Logger } from "./logger.js";
import { buildSystemPrompt } from "./prompt-builder.js";
import type { PromptExecutionPolicy } from "./prompt-executor.js";

export type RuntimeProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
};

export type JarRuntimeOptions = {
  provider: KnownProvider;
  model: string;
  systemPrompt: string;
  thinkingLevel: ThinkingLevel;
  providerConfig: RuntimeProviderConfig;
  execution: PromptExecutionPolicy;
  compaction?: CompactionSettings;
  logger?: Logger;
  compactionEventSink?: (event: CompactionEvent) => void;
  tools: AgentTool[];
};

export const createAgent = (config: JarRuntimeOptions): Agent => {
  const model = resolveConfiguredModel(config);
  const compactionSettings =
    config.compaction ?? defaultCompactionSettings;
  const systemPrompt = buildSystemPrompt({
    basePrompt: config.systemPrompt,
  });
  const compactionRuntime = {
    model,
    systemPrompt,
    settings: compactionSettings,
    ...(config.providerConfig.apiKey
      ? { apiKey: config.providerConfig.apiKey }
      : {}),
    ...(config.logger ? { logger: config.logger } : {}),
  };

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: config.thinkingLevel,
      tools: config.tools,
    },
    maxRetryDelayMs: config.execution.retryMaxDelayMs,
    getApiKey: (provider) => {
      if (provider !== config.provider) {
        return undefined;
      }

      return config.providerConfig.apiKey;
    },
  });

  agent.transformContext = createCompactionTransform({
    ...compactionRuntime,
    onCompaction: (event, messages) => {
      agent.state.messages = messages;
      config.compactionEventSink?.(event);
    },
  });

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
