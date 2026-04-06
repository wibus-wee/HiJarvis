import { Agent, type AgentTool, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getModels, type KnownProvider, type Model } from "@mariozechner/pi-ai";

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
  tools: AgentTool[];
};

export const createAgent = (config: JarRuntimeOptions): Agent => {
  const model = resolveConfiguredModel(config);

  return new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
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
