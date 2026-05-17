import assert from "node:assert/strict";
import test from "node:test";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

import { createAgent, supportsModelInput } from "./runtime.js";

const createTool = (): AgentTool => ({
  name: "echo",
  label: "Echo",
  description: "Echo input",
  parameters: Type.Object({
    text: Type.String(),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text", text: String((params as { text?: unknown }).text ?? "") }],
    details: null,
  }),
});

test("createAgent resolves an OpenAI-compatible custom model", () => {
  const agent = createAgent({
    provider: "local-openai",
    model: "llama-3.1-8b",
    systemPrompt: "Test",
    thinkingLevel: "minimal",
    providerConfig: {
      api: "openai-completions",
      baseUrl: "http://localhost:11434/v1",
      models: {
        "llama-3.1-8b": {
          name: "Llama 3.1 8B",
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 131072,
          maxTokens: 32768,
          toolCall: true,
        },
      },
    },
    execution: {
      requestTimeoutMs: 120000,
      retryAttempts: 0,
      retryInitialDelayMs: 1000,
      retryBackoffMultiplier: 2,
      retryMaxDelayMs: 30000,
    },
    tools: [],
  });

  assert.equal(agent.state.model.provider, "local-openai");
  assert.equal(agent.state.model.api, "openai-completions");
  assert.equal(agent.state.model.baseUrl, "http://localhost:11434/v1");
  assert.equal(agent.state.model.contextWindow, 131072);
  assert.equal(agent.state.model.maxTokens, 32768);
  assert.deepEqual(agent.state.model.input, ["text", "image"]);
});

test("createAgent resolves an Anthropic-compatible custom model distinctly from OpenAI-compatible models", () => {
  const agent = createAgent({
    provider: "proxied-anthropic",
    model: "claude-proxy",
    systemPrompt: "Test",
    thinkingLevel: "minimal",
    providerConfig: {
      api: "anthropic-messages",
      baseUrl: "https://anthropic-proxy.example.test",
      models: {
        "claude-proxy": {
          name: "Claude Proxy",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 200000,
          maxTokens: 8192,
          toolCall: true,
        },
      },
    },
    execution: {
      requestTimeoutMs: 120000,
      retryAttempts: 0,
      retryInitialDelayMs: 1000,
      retryBackoffMultiplier: 2,
      retryMaxDelayMs: 30000,
    },
    tools: [],
  });

  assert.equal(agent.state.model.provider, "proxied-anthropic");
  assert.equal(agent.state.model.api, "anthropic-messages");
  assert.equal(agent.state.model.baseUrl, "https://anthropic-proxy.example.test");
});

test("createAgent rejects configured tools when model metadata disables tool calls", () => {
  assert.throws(
    () => createAgent({
      provider: "local-openai",
      model: "plain-text-model",
      systemPrompt: "Test",
      thinkingLevel: "minimal",
      providerConfig: {
        api: "openai-completions",
        baseUrl: "http://localhost:11434/v1",
        models: {
          "plain-text-model": {
            name: "Plain Text Model",
            reasoning: false,
            input: ["text"],
            contextWindow: 8192,
            maxTokens: 2048,
            toolCall: false,
          },
        },
      },
      execution: {
        requestTimeoutMs: 120000,
        retryAttempts: 0,
        retryInitialDelayMs: 1000,
        retryBackoffMultiplier: 2,
        retryMaxDelayMs: 30000,
      },
      tools: [createTool()],
    }),
    /does not support tool calls/,
  );
});

test("supportsModelInput uses configured custom model metadata when supplied", () => {
  assert.equal(
    supportsModelInput("local-openai", "llama-3.1-8b", "image", {
      api: "openai-completions",
      baseUrl: "http://localhost:11434/v1",
      models: {
        "llama-3.1-8b": {
          input: ["text", "image"],
          contextWindow: 131072,
          maxTokens: 32768,
          toolCall: true,
        },
      },
    }),
    true,
  );
});
