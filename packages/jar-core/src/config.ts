import { readFile } from "node:fs/promises";
import path from "node:path";

import type { PromptExecutionPolicy } from "./prompt-executor.js";
import type { JarRuntimeOptions, RuntimeProviderConfig } from "./runtime.js";
import { getModels, getProviders, type KnownProvider } from "@mariozechner/pi-ai";
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
  }).strict(),
  provider: z.record(z.string(), z.unknown()).default({}),
  platform: z.object({
    slack: z.object({
      bot_name: nonEmptyString.optional(),
      bot_token: nonEmptyString.optional(),
      signing_secret: nonEmptyString.optional(),
      context_lookback_minutes: z.number().int().positive().optional(),
      context_message_limit: z.number().int().positive().optional(),
      host: nonEmptyString.optional(),
      port: z.number().int().positive().optional(),
    }).strict().default({}),
  }).strict().default({ slack: {} }),
  sessions: z.object({
    root_dir: nonEmptyString.optional(),
  }).strict().default({}),
  tools: z.object({
    workspace_root: nonEmptyString.optional(),
    max_file_bytes: z.number().int().positive().optional(),
    command_timeout_ms: z.number().int().positive().optional(),
    max_command_output_bytes: z.number().int().positive().optional(),
  }).strict().default({}),
}).strict();

type RawConfig = z.infer<typeof rawConfigSchema>;

const providerConfigSchema = z.object({
  api_key: nonEmptyString.optional(),
  base_url: z.string().trim().url().optional(),
}).strict();

export type LoadedAgentConfig = {
  configFilePath: string;
  platform: {
    slack: {
      botName?: string;
      botToken?: string;
      signingSecret?: string;
      contextLookbackMinutes: number;
      contextMessageLimit: number;
      host?: string;
      port?: number;
    };
  };
  runtime: Omit<JarRuntimeOptions, "tools">;
  toolOptions: ToolOptions;
  sessions: {
    rootDir: string;
  };
};

export const loadAgentConfig = async (
  configFilePath: string,
): Promise<LoadedAgentConfig> => {
  const absoluteConfigPath = path.resolve(configFilePath);
  const configFileContent = await readFile(absoluteConfigPath, "utf8");
  const parsedToml = parse(configFileContent) as Record<string, unknown>;
  const parsedConfig = parseRawConfig(parsedToml);

  const provider = parseProvider(parsedConfig.agent.provider);
  const providerConfig = parseProviderConfig(parsedConfig.provider, provider);
  const execution = parseExecutionConfig(parsedConfig.agent);
  const model = parseModel(provider, parsedConfig.agent.model);
  const configDirectory = path.dirname(absoluteConfigPath);
  const sessionRoot = path.resolve(
    configDirectory,
    parsedConfig.sessions.root_dir ?? ".jar/sessions",
  );

  return {
    configFilePath: absoluteConfigPath,
    platform: {
      slack: {
        ...(parsedConfig.platform.slack.bot_name === undefined
          ? {}
          : { botName: parsedConfig.platform.slack.bot_name }),
        ...(parsedConfig.platform.slack.bot_token === undefined
          ? {}
          : { botToken: parsedConfig.platform.slack.bot_token }),
        ...(parsedConfig.platform.slack.signing_secret === undefined
          ? {}
          : { signingSecret: parsedConfig.platform.slack.signing_secret }),
        contextLookbackMinutes:
          parsedConfig.platform.slack.context_lookback_minutes ?? 15,
        contextMessageLimit:
          parsedConfig.platform.slack.context_message_limit ?? 12,
        ...(parsedConfig.platform.slack.host === undefined
          ? {}
          : { host: parsedConfig.platform.slack.host }),
        ...(parsedConfig.platform.slack.port === undefined
          ? {}
          : { port: parsedConfig.platform.slack.port }),
      },
    },
    runtime: {
      provider,
      model,
      systemPrompt: parsedConfig.agent.system_prompt,
      thinkingLevel: parsedConfig.agent.thinking_level,
      providerConfig: toRuntimeProviderConfig(providerConfig),
      execution,
    },
    toolOptions: {
      workspaceRoot: path.resolve(
        configDirectory,
        parsedConfig.tools.workspace_root ?? ".",
      ),
      maxFileBytes: parsedConfig.tools.max_file_bytes ?? 32_768,
      commandTimeoutMs: parsedConfig.tools.command_timeout_ms ?? 30_000,
      maxCommandOutputBytes:
        parsedConfig.tools.max_command_output_bytes ?? 32_768,
    },
    sessions: {
      rootDir: sessionRoot,
    },
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

const parseProvider = (value: string): KnownProvider => {
  const providers = new Set<string>(getProviders());
  if (!providers.has(value)) {
    throw new Error(
      `Unsupported provider "${value}". Available providers: ${[
        ...providers,
      ].join(", ")}`,
    );
  }

  return value as KnownProvider;
};

const parseModel = (provider: KnownProvider, value: string): string => {
  const availableModels = getModels(provider).map((candidate) => candidate.id);
  if (!availableModels.includes(value)) {
    throw new Error(
      `Unsupported model "${value}" for provider "${provider}". Known models include: ${availableModels
        .slice(0, 20)
        .join(", ")}`,
    );
  }

  return value;
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

const parseProviderConfig = (
  providerTables: RawConfig["provider"],
  provider: KnownProvider,
) => {
  const rawProviderConfig = providerTables[provider];
  if (rawProviderConfig === undefined) {
    return {};
  }

  const result = providerConfigSchema.safeParse(rawProviderConfig);
  if (result.success) {
    return result.data;
  }

  const message = result.error.issues
    .map((issue) => {
      const suffix = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
      return `provider.${provider}${suffix}: ${issue.message}`;
    })
    .join("\n");

  throw new Error(`Invalid TOML config:\n${message}`);
};

const toRuntimeProviderConfig = (
  providerConfig: { api_key?: string | undefined; base_url?: string | undefined },
): RuntimeProviderConfig => {
  return {
    ...(providerConfig.api_key === undefined
      ? {}
      : { apiKey: providerConfig.api_key }),
    ...(providerConfig.base_url === undefined
      ? {}
      : { baseUrl: providerConfig.base_url }),
  };
};
