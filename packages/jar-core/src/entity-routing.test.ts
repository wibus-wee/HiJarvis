import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findMostRecentIdentityThread,
  openConversationHandle,
  parseIdentitySessionId,
  resolveIdentitySessionId,
  type LoadedRuntimeConfig,
} from "./index.js";

const createConfig = (rootDir: string): LoadedRuntimeConfig => ({
  configFilePath: path.join(rootDir, "jar.toml"),
  logging: { level: "info", stderr: true },
  agent: {
    provider: "openai",
    model: "gpt-4o-mini",
    systemPrompt: "You are Jarvis.",
    thinkingLevel: "minimal",
    providerConfig: {},
    execution: {
      requestTimeoutMs: 120_000,
      retryAttempts: 0,
      retryInitialDelayMs: 1_000,
      retryBackoffMultiplier: 2,
      retryMaxDelayMs: 30_000,
    },
    compaction: {
      enabled: true,
      triggerRatio: 0.9,
      budgetRatio: 0.9,
      summaryMaxTokens: 1024,
    },
    systemPromptOverlays: [],
  },
  skills: {
    enabled: false,
    roots: [],
    entries: [],
    catalog: "",
    errors: [],
    truncatedByLimit: false,
    maxScanDepth: 0,
    maxSkills: 0,
    maxCatalogChars: 0,
    maxBodyChars: 0,
  },
  toolOptions: {
    provider: "openai",
    model: "gpt-4o-mini",
    workspaceRoot: rootDir,
    maxFileBytes: 32_768,
    commandTimeoutMs: 30_000,
    maxCommandOutputBytes: 32_768,
    webRequestTimeoutMs: 30_000,
    maxWebResponseBytes: 65_536,
  },
  sessions: { rootDir },
  entities: {
    jarvis: {
      id: "jarvis",
      displayName: "Jarvis",
    },
    pm: {
      id: "pm",
      displayName: "PM Jarvis",
      systemPrompt: "You are PM Jarvis.",
    },
  },
  platformIdentities: {
    slack_main: {
      id: "slack_main",
      platform: "slack",
      entityId: "jarvis",
      botToken: "xoxb-main",
      appToken: "xapp-main",
      signingSecret: "main-secret",
      contextLookbackMinutes: 15,
      contextMessageLimit: 12,
    },
    slack_pm: {
      id: "slack_pm",
      platform: "slack",
      entityId: "pm",
      botToken: "xoxb-pm",
      appToken: "xapp-pm",
      signingSecret: "pm-secret",
      contextLookbackMinutes: 15,
      contextMessageLimit: 12,
    },
    telegram_main: {
      id: "telegram_main",
      platform: "telegram",
      entityId: "jarvis",
      botToken: "telegram-token",
    },
  },
  platform: {},
});

test("resolveIdentitySessionId encodes identity and platform into thread id", () => {
  const threadId = resolveIdentitySessionId({
    identityId: "slack_main",
    platform: "slack",
    scope: "thread:C123:1743931234.56789",
  });

  assert.equal(
    threadId,
    "identity__slack_main__slack__thread__C123__1743931234.56789",
  );
  assert.deepEqual(parseIdentitySessionId(threadId), {
    identityId: "slack_main",
    platform: "slack",
    scope: "thread__C123__1743931234.56789",
  });
});

test("identity routing keeps same platform scope distinct per identity", () => {
  const mainSessionId = resolveIdentitySessionId({
    identityId: "slack_main",
    platform: "slack",
    scope: "thread:C1:2",
  });
  const pmSessionId = resolveIdentitySessionId({
    identityId: "slack_pm",
    platform: "slack",
    scope: "thread:C1:2",
  });

  assert.notEqual(mainSessionId, pmSessionId);
});

test("findMostRecentIdentityThread returns latest matching identity thread", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "jar-identity-routing-"));
  try {
    const config = createConfig(rootDir);
    const firstId = resolveIdentitySessionId({
      identityId: "slack_main",
      platform: "slack",
      scope: "channel:C1",
    });
    const secondId = resolveIdentitySessionId({
      identityId: "slack_main",
      platform: "slack",
      scope: "thread:C1:2",
    });

    const first = await openConversationHandle({
      rootDir,
      threadId: firstId,
      provider: "openai",
      model: "gpt-4o-mini",
    });
    await first.flush();

    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await openConversationHandle({
      rootDir,
      threadId: secondId,
      provider: "openai",
      model: "gpt-4o-mini",
    });
    await second.flush();

    const match = await findMostRecentIdentityThread(config, "slack_main");
    assert.equal(match?.threadId, secondId);
    assert.equal(match?.platform, "slack");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
