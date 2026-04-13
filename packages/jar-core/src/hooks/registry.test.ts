import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createHookRegistry } from "./registry.js";
import type { HookRegistration } from "./types.js";

describe("createHookRegistry", () => {
  it("transform returns input passthrough when no hooks are registered", async () => {
    const registry = createHookRegistry();
    const result = await registry.transform("ingress:before", {
      config: {} as any,
      command: { kind: "message", message: { text: "hello" } } as any,
    });
    // With no hooks, the input is returned as-is as the output.
    assert.equal((result as any).command.message.text, "hello");
  });

  it("transform runs hooks serially and chains output into next input", async () => {
    const registry = createHookRegistry();
    const calls: number[] = [];

    registry.register({
      point: "prompt:transform",
      name: "first",
      priority: 10,
      handler: (input) => {
        calls.push(1);
        return {
          prompt: `[first] ${input.prompt as string}`,
          skillTriggerText: input.skillTriggerText,
        };
      },
    });

    registry.register({
      point: "prompt:transform",
      name: "second",
      priority: 20,
      handler: (input) => {
        calls.push(2);
        return {
          prompt: `[second] ${input.prompt as string}`,
          skillTriggerText: input.skillTriggerText,
        };
      },
    });

    const result = await registry.transform("prompt:transform", {
      session: {} as any,
      prompt: "hello",
      skillTriggerText: "hello",
    });

    assert.deepEqual(calls, [1, 2]);
    assert.equal(result.prompt, "[second] [first] hello");
  });

  it("transform respects priority ordering (lower runs first)", async () => {
    const registry = createHookRegistry();
    const order: string[] = [];

    registry.register({
      point: "tools:resolve",
      name: "high-priority",
      priority: 200,
      handler: (input) => {
        order.push("high");
        return { tools: input.tools };
      },
    });

    registry.register({
      point: "tools:resolve",
      name: "low-priority",
      priority: 1,
      handler: (input) => {
        order.push("low");
        return { tools: input.tools };
      },
    });

    await registry.transform("tools:resolve", {
      config: {} as any,
      command: {} as any,
      tools: [],
    });

    assert.deepEqual(order, ["low", "high"]);
  });

  it("tap runs all handlers concurrently and does not propagate errors", async () => {
    const warnings: string[] = [];
    const registry = createHookRegistry({
      logger: {
        warn: (_msg: string, fields: any) => {
          warnings.push(fields.hookName);
        },
      } as any,
    });

    const calls: string[] = [];

    registry.register({
      point: "session:loaded",
      name: "observer-a",
      handler: () => {
        calls.push("a");
      },
    });

    registry.register({
      point: "session:loaded",
      name: "observer-b",
      handler: () => {
        calls.push("b");
        throw new Error("boom");
      },
    });

    registry.register({
      point: "session:loaded",
      name: "observer-c",
      handler: () => {
        calls.push("c");
      },
    });

    // Should not throw despite observer-b failing.
    await registry.tap("session:loaded", {} as any);

    assert.ok(calls.includes("a"));
    assert.ok(calls.includes("b"));
    assert.ok(calls.includes("c"));
    assert.deepEqual(warnings, ["observer-b"]);
  });

  it("register returns an unregister function", async () => {
    const registry = createHookRegistry();
    let called = false;

    const unregister = registry.register({
      point: "error:caught",
      name: "disposable",
      handler: () => {
        called = true;
      },
    });

    assert.equal(registry.has("error:caught"), true);

    unregister();

    assert.equal(registry.has("error:caught"), false);

    await registry.tap("error:caught", { error: new Error("test"), phase: "test" });
    assert.equal(called, false);
  });

  it("unregister is idempotent", () => {
    const registry = createHookRegistry();

    const unregister = registry.register({
      point: "response:complete",
      name: "once",
      handler: () => {},
    });

    unregister();
    unregister(); // Should not throw.

    assert.equal(registry.has("response:complete"), false);
  });

  it("has returns false for empty points", () => {
    const registry = createHookRegistry();
    assert.equal(registry.has("ingress:before"), false);
    assert.equal(registry.has("agent:event"), false);
  });

  it("has returns true after registration", () => {
    const registry = createHookRegistry();

    registry.register({
      point: "agent:event",
      name: "watcher",
      handler: () => {},
    });

    assert.equal(registry.has("agent:event"), true);
  });

  it("transform propagates handler errors", async () => {
    const registry = createHookRegistry();

    registry.register({
      point: "ingress:before",
      name: "failing",
      handler: () => {
        throw new Error("rejected");
      },
    });

    await assert.rejects(
      () => registry.transform("ingress:before", {
        config: {} as any,
        command: {} as any,
      }),
      { message: "rejected" },
    );
  });

  it("transform uses default priority 100 when not specified", async () => {
    const registry = createHookRegistry();
    const order: string[] = [];

    registry.register({
      point: "tools:resolve",
      name: "explicit-50",
      priority: 50,
      handler: (input) => {
        order.push("50");
        return { tools: input.tools };
      },
    });

    registry.register({
      point: "tools:resolve",
      name: "default-priority",
      // no priority → defaults to 100
      handler: (input) => {
        order.push("default");
        return { tools: input.tools };
      },
    });

    registry.register({
      point: "tools:resolve",
      name: "explicit-150",
      priority: 150,
      handler: (input) => {
        order.push("150");
        return { tools: input.tools };
      },
    });

    await registry.transform("tools:resolve", {
      config: {} as any,
      command: {} as any,
      tools: [],
    });

    assert.deepEqual(order, ["50", "default", "150"]);
  });

  it("tap with no hooks is a no-op", async () => {
    const registry = createHookRegistry();
    // Should resolve immediately without error.
    await registry.tap("error:caught", { error: null, phase: "test" });
  });

  it("multiple hooks on different points are independent", async () => {
    const registry = createHookRegistry();
    const calls: string[] = [];

    registry.register({
      point: "session:loaded",
      name: "session-hook",
      handler: () => { calls.push("session"); },
    });

    registry.register({
      point: "error:caught",
      name: "error-hook",
      handler: () => { calls.push("error"); },
    });

    await registry.tap("session:loaded", {} as any);
    assert.deepEqual(calls, ["session"]);

    await registry.tap("error:caught", { error: null, phase: "test" });
    assert.deepEqual(calls, ["session", "error"]);
  });
});
