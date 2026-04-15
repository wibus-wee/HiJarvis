import type { AgentEvent, AgentTool, AfterToolCallContext, AfterToolCallResult, BeforeToolCallContext, BeforeToolCallResult } from "@mariozechner/pi-agent-core";

import type { LoadedRuntimeConfig } from "../config.js";
import type { MessageIngressCommand } from "../ingress.js";
import type { Logger } from "../logger.js";
import type { PromptInput } from "../prompt-executor.js";
import type { PreparedPromptContext, SessionContext, MessageIngressResult } from "../execution/types.js";

// ── Hook Point Map ───────────────────────────────────
//
// Each entry defines a hook point with typed `in` (input) and `out` (output).
//
// - `out: void`  → **tap** hook (observe only, cannot alter the pipeline)
// - `out: T`     → **transform** hook (may rewrite data flowing through the pipeline)
//
// The type-level distinction is enforced by `TransformHookPoint` / `TapHookPoint`
// so callers cannot accidentally `transform()` a tap-only point or vice-versa.

export interface HookMap {
  // ── Ingress ────────────────────────────────────────

  /** Earliest interception. May rewrite or reject the incoming command. */
  "ingress:before": {
    in: { config: LoadedRuntimeConfig; command: MessageIngressCommand };
    out: { command: MessageIngressCommand };
  };

  // ── Session ────────────────────────────────────────

  /** Fired after the conversation session is loaded. Observe only. */
  "session:loaded": {
    in: SessionContext;
    out: void;
  };

  // ── Prompt ─────────────────────────────────────────

  /** Transform the prompt before skill injection and preparation. */
  "prompt:transform": {
    in: {
      config: LoadedRuntimeConfig;
      command: MessageIngressCommand;
      session: SessionContext;
      prompt: PromptInput;
      skillTriggerText: string;
    };
    out: { prompt: PromptInput; skillTriggerText: string };
  };

  /** Fired after the prompt is fully prepared (skills injected, tracker started). */
  "prompt:prepared": {
    in: PreparedPromptContext;
    out: void;
  };

  // ── Tools ──────────────────────────────────────────

  /** Add, remove, or reorder tools before the agent is created. */
  "tools:resolve": {
    in: { config: LoadedRuntimeConfig; command: MessageIngressCommand; tools: AgentTool[] };
    out: { tools: AgentTool[] };
  };

  /**
   * Called before each tool execution.
   *
   * Delegates to the upstream `Agent.beforeToolCall` API.
   * Return `{ block: true, reason }` to prevent execution.
   */
  "tool:before": {
    in: BeforeToolCallContext;
    out: BeforeToolCallResult | undefined;
  };

  /**
   * Called after each tool execution.
   *
   * Delegates to the upstream `Agent.afterToolCall` API.
   * Return partial overrides for the tool result.
   */
  "tool:after": {
    in: AfterToolCallContext;
    out: AfterToolCallResult | undefined;
  };

  // ── Agent Events ───────────────────────────────────

  /** Observe the agent event stream. Cannot alter events. */
  "agent:event": {
    in: { event: AgentEvent; threadId: string };
    out: void;
  };

  // ── Response ───────────────────────────────────────

  /** Transform the final output text before it is returned to the caller. */
  "response:transform": {
    in: { result: MessageIngressResult; durationMs: number };
    out: { outputText: string };
  };

  /** Fired after the response is finalized. Observe only. */
  "response:complete": {
    in: { result: MessageIngressResult; durationMs: number };
    out: void;
  };

  // ── Error ──────────────────────────────────────────

  /** Fired when an error is caught during execution. Observe only. */
  "error:caught": {
    in: { error: unknown; phase: string; envelope?: unknown };
    out: void;
  };
}

// ── Derived utility types ────────────────────────────

/** Union of all hook point string literals. */
export type HookPoint = keyof HookMap;

/**
 * Hook points whose `out` is non-void — these support `transform()`.
 *
 * ```ts
 * // "ingress:before" | "prompt:transform" | "tools:resolve" | "tool:before" | "tool:after" | "response:transform"
 * type T = TransformHookPoint;
 * ```
 */
export type TransformHookPoint = {
  [P in HookPoint]: HookMap[P]["out"] extends void ? never : P;
}[HookPoint];

/**
 * Hook points whose `out` is void — these support `tap()`.
 *
 * ```ts
 * // "session:loaded" | "prompt:prepared" | "agent:event" | "response:complete" | "error:caught"
 * type T = TapHookPoint;
 * ```
 */
export type TapHookPoint = {
  [P in HookPoint]: HookMap[P]["out"] extends void ? P : never;
}[HookPoint];

/**
 * Handler function signature, automatically derived from the hook point.
 *
 * - For tap points (`out: void`): `(input) => void | Promise<void>`
 * - For transform points: `(input) => Out | Promise<Out>`
 */
export type HookHandler<P extends HookPoint> =
  HookMap[P]["out"] extends void
    ? (input: HookMap[P]["in"]) => void | Promise<void>
    : (input: HookMap[P]["in"]) => HookMap[P]["out"] | Promise<HookMap[P]["out"]>;

/** A single hook registration. */
export interface HookRegistration<P extends HookPoint = HookPoint> {
  /** Which hook point to attach to. */
  point: P;
  /** Human-readable name for debugging and logging. */
  name: string;
  /** Execution priority — lower runs first. Defaults to 100. */
  priority?: number;
  /** The handler function. */
  handler: HookHandler<P>;
}

// ── Registry interface ───────────────────────────────

export interface HookRegistry {
  /**
   * Register a hook. Returns an unregister function.
   *
   * The generic parameter `P` is inferred from `reg.point`, so the handler
   * signature is fully type-checked:
   *
   * ```ts
   * registry.register({
   *   point: "prompt:transform",
   *   name: "inject-time",
     *   handler: (input) => {
     *     // input is typed as { config, command, session, prompt, skillTriggerText }
     *     // must return { prompt, skillTriggerText }
     *   },
     * });
   * ```
   */
  register<P extends HookPoint>(reg: HookRegistration<P>): () => void;

  /**
   * Run all transform hooks for a point, serially by priority.
   *
   * Each handler receives the (possibly rewritten) input from the previous one.
   * If no hooks are registered, returns a default output extracted from the input.
   *
   * Only callable on `TransformHookPoint`s — the type system prevents misuse.
   */
  transform<P extends TransformHookPoint>(
    point: P,
    input: HookMap[P]["in"],
  ): Promise<HookMap[P]["out"]>;

  /**
   * Run all tap hooks for a point, concurrently via `Promise.allSettled`.
   *
   * Individual handler failures are logged but do not propagate.
   *
   * Only callable on `TapHookPoint`s — the type system prevents misuse.
   */
  tap<P extends TapHookPoint>(
    point: P,
    input: HookMap[P]["in"],
  ): Promise<void>;

  /** Returns `true` if at least one hook is registered for the given point. */
  has(point: HookPoint): boolean;
}

/** Options for creating a hook registry. */
export interface HookRegistryOptions {
  logger?: Logger;
}
