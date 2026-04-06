import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getModels, getProviders, type KnownProvider } from "@mariozechner/pi-ai";

import { loadAgentConfig } from "./config.js";

const pickProviderAndModel = (): { provider: KnownProvider; model: string } => {
  const providers = getProviders();
  if (providers.length === 0) {
    throw new Error("No providers available in pi-ai registry");
  }

  for (const provider of providers) {
    const models = getModels(provider);
    const firstModel = models.at(0);
    if (firstModel) {
      return {
        provider,
        model: firstModel.id,
      };
    }
  }

  throw new Error("No models available for any provider");
};

const writeConfigFile = async (content: string): Promise<string> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jar-config-"));
  const configPath = path.join(tempDir, "jar.toml");
  await writeFile(configPath, content, "utf8");
  return configPath;
};

const cleanupConfigFile = async (configPath: string): Promise<void> => {
  await rm(path.dirname(configPath), { recursive: true, force: true });
};

test("loadAgentConfig applies default prompt execution policy values", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."
`);

  try {
    const config = await loadAgentConfig(configPath);
    assert.deepEqual(config.runtime.execution, {
      requestTimeoutMs: 120_000,
      retryAttempts: 5,
      retryInitialDelayMs: 1_000,
      retryBackoffMultiplier: 2,
      retryMaxDelayMs: 30_000,
    });
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig reads custom prompt execution policy values", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."
request_timeout_ms = 90000
retry_attempts = 7
retry_initial_delay_ms = 1200
retry_backoff_multiplier = 1.6
retry_max_delay_ms = 45000
`);

  try {
    const config = await loadAgentConfig(configPath);
    assert.deepEqual(config.runtime.execution, {
      requestTimeoutMs: 90_000,
      retryAttempts: 7,
      retryInitialDelayMs: 1_200,
      retryBackoffMultiplier: 1.6,
      retryMaxDelayMs: 45_000,
    });
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig rejects invalid retry policy ordering", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."
retry_initial_delay_ms = 5000
retry_max_delay_ms = 1000
`);

  try {
    await assert.rejects(
      () => loadAgentConfig(configPath),
      /retry_max_delay_ms must be greater than or equal to agent.retry_initial_delay_ms/,
    );
  } finally {
    await cleanupConfigFile(configPath);
  }
});
