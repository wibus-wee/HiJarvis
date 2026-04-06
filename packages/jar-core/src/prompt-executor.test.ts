import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPromptFailure,
  executePromptWithPolicy,
  getRetryDelayMs,
  type PromptAgent,
  type PromptExecutionPolicy,
} from "./prompt-executor.js";

const defaultPolicy: PromptExecutionPolicy = {
  requestTimeoutMs: 50,
  retryAttempts: 2,
  retryInitialDelayMs: 1,
  retryBackoffMultiplier: 2,
  retryMaxDelayMs: 8,
};

test("getRetryDelayMs grows exponentially and respects max delay", () => {
  const policy: PromptExecutionPolicy = {
    ...defaultPolicy,
    retryInitialDelayMs: 100,
    retryBackoffMultiplier: 2,
    retryMaxDelayMs: 350,
  };

  assert.equal(getRetryDelayMs(policy, 0), 100);
  assert.equal(getRetryDelayMs(policy, 1), 200);
  assert.equal(getRetryDelayMs(policy, 2), 350);
  assert.equal(getRetryDelayMs(policy, 3), 350);
});

test("classifyPromptFailure detects retryable and non-retryable categories", () => {
  assert.equal(classifyPromptFailure("Request timed out", true).category, "timeout");
  assert.equal(
    classifyPromptFailure("429 Too Many Requests", false).category,
    "rate_limit",
  );
  assert.equal(classifyPromptFailure("fetch failed", false).category, "network");
  assert.equal(classifyPromptFailure("Unauthorized", false).category, "auth");
  assert.equal(classifyPromptFailure("Bad request", false).category, "input");
  assert.equal(classifyPromptFailure("Operation aborted", false).category, "aborted");
  assert.equal(classifyPromptFailure("Tool execution failed", false).category, "tool");
  assert.equal(classifyPromptFailure("Something odd happened", false).category, "unknown");
});

test("classifyPromptFailure treats upstream 5xx responses as retryable network failures", () => {
  const upstreamHtmlError = `521 <!DOCTYPE html>
<html>
  <head><title>Web server is down</title></head>
  <body>Cloudflare host error</body>
</html>`;

  assert.deepEqual(classifyPromptFailure(upstreamHtmlError, false), {
    category: "network",
    retryable: true,
    message: upstreamHtmlError,
  });

  assert.equal(
    classifyPromptFailure("HTTP 500 internal server error", false).category,
    "network",
  );
});

test("executePromptWithPolicy retries transient failures and then succeeds", async () => {
  let promptCalls = 0;
  const logs: string[] = [];
  const agent: PromptAgent = {
    state: {},
    abort: () => undefined,
    prompt: async () => {
      promptCalls += 1;
      if (promptCalls === 1) {
        agent.state.errorMessage = "429 Too Many Requests";
        return;
      }
      if (promptCalls === 2) {
        delete agent.state.errorMessage;
        throw new Error("fetch failed");
      }
      delete agent.state.errorMessage;
    },
  };

  await executePromptWithPolicy(agent, "hello", defaultPolicy, {
    stderr: { write: (value: string) => {
      logs.push(value);
      return true;
    } },
  });

  assert.equal(promptCalls, 3);
  assert.equal(
    logs.some((line) => line.includes("[prompt:retry]")),
    true,
  );
});

test("executePromptWithPolicy stops immediately for auth failures", async () => {
  let promptCalls = 0;
  const agent: PromptAgent = {
    state: {},
    abort: () => undefined,
    prompt: async () => {
      promptCalls += 1;
      agent.state.errorMessage = "Unauthorized";
    },
  };

  await assert.rejects(
    () =>
      executePromptWithPolicy(agent, "hello", defaultPolicy, {
        stderr: { write: () => true },
      }),
    /\[auth\]/,
  );
  assert.equal(promptCalls, 1);
});

test("executePromptWithPolicy aborts timed-out attempts", async () => {
  let aborted = false;
  let onAbort: (() => void) | undefined;

  const agent: PromptAgent = {
    state: {},
    abort: () => {
      aborted = true;
      onAbort?.();
    },
    prompt: async () => {
      await new Promise<void>((resolve) => {
        onAbort = resolve;
      });
    },
  };

  await assert.rejects(
    () =>
      executePromptWithPolicy(
        agent,
        "hello",
        {
          ...defaultPolicy,
          retryAttempts: 0,
          requestTimeoutMs: 10,
        },
        {
          stderr: { write: () => true },
        },
      ),
    /\[timeout\]/,
  );
  assert.equal(aborted, true);
});
