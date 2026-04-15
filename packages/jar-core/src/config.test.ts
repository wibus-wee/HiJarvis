import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getModels, getProviders, type KnownProvider } from "@mariozechner/pi-ai";

import { loadAgentConfig } from "./config.js";
import { defaultCompactionSettings } from "./compaction/index.js";

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

const defaultIdentityConfig = `

[entities.jarvis]
display_name = "Jarvis"

[platform.telegram.identities.telegram_main]
entity = "jarvis"
bot_token = "123456:test-token"
`;

const writeConfigFile = async (
  content: string,
  options?: { withIdentityDefaults?: boolean },
): Promise<string> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jar-config-"));
  const configPath = path.join(tempDir, "jar.toml");
  const finalContent = `${content}${options?.withIdentityDefaults === false ? "" : defaultIdentityConfig}`;
  await writeFile(configPath, finalContent, "utf8");
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
    assert.deepEqual(config.agent.execution, {
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

test("loadAgentConfig allows configs without platform identities", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."

[entities.jarvis]
display_name = "Jarvis"
`, { withIdentityDefaults: false });

  try {
    const config = await loadAgentConfig(configPath);
    assert.deepEqual(config.platformIdentities, {});
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
    assert.deepEqual(config.agent.execution, {
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

test("loadAgentConfig applies default logging config values", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."
`);

  try {
    const config = await loadAgentConfig(configPath);
    assert.deepEqual(config.logging, {
      level: "info",
      stderr: true,
      filePath: undefined,
    });
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig applies default tool limits", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."
`);

  try {
    const config = await loadAgentConfig(configPath);
    assert.deepEqual(config.toolOptions, {
      provider,
      model,
      providerBaseUrl: undefined,
      providerApiKey: undefined,
      workspaceRoot: path.dirname(configPath),
      maxFileBytes: 32_768,
      commandTimeoutMs: 30_000,
      maxCommandOutputBytes: 32_768,
      webRequestTimeoutMs: 30_000,
      maxWebResponseBytes: 65_536,
      maxConcurrentShells: 10,
    });
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig reads custom tool limits", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."

[tools]
workspace_root = "./workspace"
max_file_bytes = 4096
command_timeout_ms = 45000
max_command_output_bytes = 8192
web_request_timeout_ms = 12000
max_web_response_bytes = 16384
`);

  try {
    const config = await loadAgentConfig(configPath);
    assert.deepEqual(config.toolOptions, {
      provider,
      model,
      providerBaseUrl: undefined,
      providerApiKey: undefined,
      workspaceRoot: path.join(path.dirname(configPath), "workspace"),
      maxFileBytes: 4_096,
      commandTimeoutMs: 45_000,
      maxCommandOutputBytes: 8_192,
      webRequestTimeoutMs: 12_000,
      maxWebResponseBytes: 16_384,
      maxConcurrentShells: 10,
    });
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig rejects invalid tool limits", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."

[tools]
max_file_bytes = 0
`);

  try {
    await assert.rejects(
      () => loadAgentConfig(configPath),
      /tools\.max_file_bytes/i,
    );
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig applies default memory config values", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."
`);

  try {
    const config = await loadAgentConfig(configPath);
    assert.deepEqual(config.memory, {
      enabled: true,
      provider: "filesystem",
      providers: {
        filesystem: {
          rootDir: path.join(path.dirname(configPath), ".jar", "memory"),
        },
      },
    });
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig reads provider-specific memory config values", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."

[memory]
enabled = false
provider = "filesystem"

[memory.providers.filesystem]
root_dir = "./var/memory"
`);

  try {
    const config = await loadAgentConfig(configPath);
    assert.deepEqual(config.memory, {
      enabled: false,
      provider: "filesystem",
      providers: {
        filesystem: {
          rootDir: path.join(path.dirname(configPath), "var", "memory"),
        },
      },
    });
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig reads memory provider modules and arbitrary provider options", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."

[memory]
provider = "custom"

[memory.providers.custom]
module = "./plugins/custom-memory.ts"
endpoint = "https://memory.example.test"
namespace = "jarvis-memory"
`);

  try {
    const config = await loadAgentConfig(configPath);
    assert.deepEqual(config.memory, {
      enabled: true,
      provider: "custom",
      providers: {
        filesystem: {
          rootDir: path.join(path.dirname(configPath), ".jar", "memory"),
        },
        custom: {
          module: path.join(path.dirname(configPath), "plugins", "custom-memory.ts"),
          endpoint: "https://memory.example.test",
          namespace: "jarvis-memory",
        },
      },
    });
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig keeps package-name plugin modules unchanged", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."

[[plugins]]
module = "@hijarvis/jar-plugin-slack"

[[plugins]]
module = "./plugins/local-plugin.ts"
`);

  try {
    const config = await loadAgentConfig(configPath);
    assert.deepEqual(config.plugins, [
      { module: "@hijarvis/jar-plugin-slack", config: {} },
      { module: path.join(path.dirname(configPath), "plugins", "local-plugin.ts"), config: {} },
    ]);
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig reads logging config from jar.toml", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."

[logging]
level = "debug"
stderr = false
file_path = "./runtime.log"
`);

  try {
    const config = await loadAgentConfig(configPath);
    assert.deepEqual(config.logging, {
      level: "debug",
      stderr: false,
      filePath: path.join(path.dirname(configPath), "runtime.log"),
    });
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig applies default compaction settings", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."
`);

  try {
    const config = await loadAgentConfig(configPath);
    assert.deepEqual(config.agent.compaction, defaultCompactionSettings);
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig reads custom compaction settings", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."

[agent.compaction]
enabled = false
trigger_ratio = 0.95
budget_ratio = 0.85
summary_max_tokens = 777
`);

  try {
    const config = await loadAgentConfig(configPath);
    assert.deepEqual(config.agent.compaction, {
      enabled: false,
      triggerRatio: 0.95,
      budgetRatio: 0.85,
      summaryMaxTokens: 777,
    });
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig applies default skills roots and limits", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."
`);

  try {
    const config = await loadAgentConfig(configPath);
    assert.equal(config.skills.enabled, true);
    assert.deepEqual(config.skills.roots, [
      path.join(path.dirname(configPath), ".jarvis/skills"),
      path.join(os.homedir(), ".jarvis/skills"),
    ]);
    assert.equal(config.skills.maxScanDepth, 6);
    assert.equal(config.skills.maxSkills, 2_000);
    assert.equal(config.skills.maxCatalogChars, 12_000);
    assert.equal(config.skills.maxBodyChars, 20_000);
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig reads custom skills settings", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."

[skills]
enabled = true
roots = ["./team-skills", "~/shared-skills"]
max_scan_depth = 3
max_skills = 9
max_catalog_chars = 2048
max_body_chars = 4096
`);

  try {
    const config = await loadAgentConfig(configPath);
    assert.equal(config.skills.enabled, true);
    assert.deepEqual(config.skills.roots, [
      path.join(path.dirname(configPath), "team-skills"),
      path.join(os.homedir(), "shared-skills"),
    ]);
    assert.equal(config.skills.maxScanDepth, 3);
    assert.equal(config.skills.maxSkills, 9);
    assert.equal(config.skills.maxCatalogChars, 2_048);
    assert.equal(config.skills.maxBodyChars, 4_096);
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig rejects invalid compaction ratios", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."

[agent.compaction]
trigger_ratio = 0.4
budget_ratio = 0.8
`);

  try {
    await assert.rejects(
      () => loadAgentConfig(configPath),
      /Invalid TOML config:\nagent\.compaction\.budget_ratio must be less than or equal to agent\.compaction\.trigger_ratio/,
    );
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig rejects removed tail ratio config", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."

[agent.compaction]
tail_ratio = 0.5
`);

  try {
    await assert.rejects(
      () => loadAgentConfig(configPath),
      /Invalid TOML config:\nagent\.compaction: Unrecognized key: "tail_ratio"/,
    );
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig requires explicit entities and platform identities", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."
`, { withIdentityDefaults: false });

  try {
    await assert.rejects(
      () => loadAgentConfig(configPath),
      /At least one entity must be configured/,
    );
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig reads configured platform identities", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."

[entities.jarvis]
display_name = "Jarvis"

[entities.pm]
display_name = "PM Jarvis"
system_prompt = "You are PM Jarvis."

[platform.slack.identities.slack_main]
entity = "jarvis"
bot_token = "xoxb-main"
app_token = "xapp-main"
signing_secret = "main-secret"

[platform.slack.identities.slack_pm]
entity = "pm"
bot_token = "xoxb-pm"
app_token = "xapp-pm"
signing_secret = "pm-secret"

[platform.telegram.identities.telegram_main]
entity = "jarvis"
bot_token = "123456:telegram-token"
allowed_chat_ids = [123456789]
allowed_usernames = ["wibus"]
`, { withIdentityDefaults: false });

  try {
    const config = await loadAgentConfig(configPath);
    assert.deepEqual(config.entities.jarvis, {
      id: "jarvis",
      displayName: "Jarvis",
      systemPrompt: undefined,
    });
    assert.deepEqual(config.entities.pm, {
      id: "pm",
      displayName: "PM Jarvis",
      systemPrompt: "You are PM Jarvis.",
    });
    assert.deepEqual(config.platformIdentities.slack_main, {
      id: "slack_main",
      platform: "slack",
      entityId: "jarvis",
    });
    assert.deepEqual(config.platformIdentities.slack_pm, {
      id: "slack_pm",
      platform: "slack",
      entityId: "pm",
    });
    assert.deepEqual(config.platformIdentities.telegram_main, {
      id: "telegram_main",
      platform: "telegram",
      entityId: "jarvis",
    });
  } finally {
    await cleanupConfigFile(configPath);
  }
});

test("loadAgentConfig rejects platform identities that reference unknown entities", async () => {
  const { provider, model } = pickProviderAndModel();
  const configPath = await writeConfigFile(`
[agent]
provider = "${provider}"
model = "${model}"
system_prompt = "You are a test agent."

[entities.jarvis]
display_name = "Jarvis A"

[platform.slack.identities.slack_main]
entity = "missing"
bot_token = "xoxb-main"
app_token = "xapp-main"
signing_secret = "main-secret"
`, { withIdentityDefaults: false });

  try {
    await assert.rejects(
      () => loadAgentConfig(configPath),
      /references unknown entity "missing"/,
    );
  } finally {
    await cleanupConfigFile(configPath);
  }
});
