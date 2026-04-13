import type {
  HookHandler,
  HookMap,
  HookPoint,
  HookRegistration,
  HookRegistry,
  HookRegistryOptions,
  TapHookPoint,
  TransformHookPoint,
} from "./types.js";

const DEFAULT_PRIORITY = 100;

// ── Type-safe heterogeneous store ────────────────────
//
// A plain `Map<HookPoint, HookRegistration[]>` loses the per-point
// generic and forces `any` internally. Instead we use a branded
// wrapper that preserves the relationship between each key `P` and
// its `HookRegistration<P>` values through accessor functions that
// narrow the type at each call site.

/**
 * Opaque store type. The only way to read/write is through the
 * typed accessor functions below, which enforce that the value
 * array matches the key's hook point.
 */
type HookStore = Map<string, unknown[]>;

/** Retrieve the registration list for a specific hook point. */
const getRegistrations = <P extends HookPoint>(
  store: HookStore,
  point: P,
): Array<HookRegistration<P>> => {
  return (store.get(point) ?? []) as Array<HookRegistration<P>>;
};

/** Append a registration to the store for its hook point. */
const addRegistration = <P extends HookPoint>(
  store: HookStore,
  reg: HookRegistration<P>,
): void => {
  let list = store.get(reg.point);
  if (list === undefined) {
    list = [];
    store.set(reg.point, list);
  }
  list.push(reg);
};

/** Remove a specific registration from the store. */
const removeRegistration = <P extends HookPoint>(
  store: HookStore,
  reg: HookRegistration<P>,
): void => {
  const list = store.get(reg.point);
  if (list === undefined) {
    return;
  }
  const index = list.indexOf(reg);
  if (index !== -1) {
    list.splice(index, 1);
  }
};

/** Return hooks for `point`, sorted by ascending priority. */
const getSorted = <P extends HookPoint>(
  store: HookStore,
  point: P,
): Array<HookRegistration<P>> => {
  const list = getRegistrations(store, point);
  if (list.length === 0) {
    return [];
  }
  return list
    .slice()
    .sort((a, b) => (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY));
};

// ── Registry implementation ──────────────────────────

/**
 * Create a new {@link HookRegistry}.
 *
 * The registry is a lightweight in-memory store — no global state, no singletons.
 * Pass it explicitly to the execution pipeline via the `hooks` option.
 */
export const createHookRegistry = (options?: HookRegistryOptions): HookRegistry => {
  const logger = options?.logger;
  const store: HookStore = new Map();

  const registry: HookRegistry = {
    register<P extends HookPoint>(reg: HookRegistration<P>): () => void {
      addRegistration(store, reg);

      // Return an idempotent unregister function.
      let removed = false;
      return () => {
        if (removed) {
          return;
        }
        removed = true;
        removeRegistration(store, reg);
      };
    },

    async transform<P extends TransformHookPoint>(
      point: P,
      input: HookMap[P]["in"],
    ): Promise<HookMap[P]["out"]> {
      const hooks = getSorted(store, point);

      // Fast path: no hooks registered — pass input through unchanged.
      if (hooks.length === 0) {
        return input as HookMap[P]["out"];
      }

      // Each handler receives the merged input and returns a typed output.
      // The output is spread back into the input for the next handler.
      let currentInput: HookMap[P]["in"] = input;
      let lastOutput: HookMap[P]["out"] = input as HookMap[P]["out"];

      for (const hook of hooks) {
        try {
          const handler: HookHandler<P> = hook.handler;
          lastOutput = await (handler as (input: HookMap[P]["in"]) => Promise<HookMap[P]["out"]>)(currentInput);
          // Merge output back into input for the next hook in the chain.
          if (lastOutput !== undefined && lastOutput !== null && typeof lastOutput === "object") {
            currentInput = { ...currentInput, ...lastOutput } as HookMap[P]["in"];
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger?.error("hook.transform_failed", {
            point,
            hookName: hook.name,
            message,
          });
          throw error;
        }
      }

      return lastOutput;
    },

    async tap<P extends TapHookPoint>(
      point: P,
      input: HookMap[P]["in"],
    ): Promise<void> {
      const hooks = getSorted(store, point);
      if (hooks.length === 0) {
        return;
      }

      const results = await Promise.allSettled(
        hooks.map(async (hook) => {
          const handler: HookHandler<P> = hook.handler;
          await (handler as (input: HookMap[P]["in"]) => Promise<void>)(input);
        }),
      );

      // Log failures but never propagate them.
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result !== undefined && result.status === "rejected") {
          const hook = hooks[index];
          const reason = result.reason;
          const message = reason instanceof Error ? reason.message : String(reason);
          logger?.warn("hook.tap_failed", {
            point,
            hookName: hook?.name ?? "unknown",
            message,
          });
        }
      }
    },

    has(point: HookPoint): boolean {
      const list = store.get(point);
      return list !== undefined && list.length > 0;
    },
  };

  return registry;
};
