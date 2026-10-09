// The Promise face of a converted subsystem, for the callers that are
// not Effect yet (EFFECT.md, runtime boundaries). Its layer sits beside
// the subsystem's in the layer graph (main/hostLayer.ts): building it
// captures the graph's context, so a call runs on the graph's own
// services, logger and tracer included, and closing it turns every
// later call away. A call made before the graph is up waits for it,
// since the IPC handlers and a few module-level probes come first.
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";

type RunPromise<I> = <A, E>(
  effect: Effect.Effect<A, E, I>,
  options?: { readonly signal?: AbortSignal | undefined },
) => Promise<A>;

export const make = <I>(name: string) => {
  let open!: (runPromise: RunPromise<I>) => void;
  let runner = new Promise<RunPromise<I>>((resolve) => {
    open = resolve;
  });
  let current: Context.Context<I> | undefined;
  // Each call runs in the layer's own fiber set, so the graph closing
  // interrupts whatever is still under way, after turning new calls
  // away.
  const layer = Layer.effectDiscard(
    Effect.gen(function* () {
      const ctx = yield* Effect.context<I>();
      const runPromise: RunPromise<I> = yield* FiberSet.makeRuntimePromise<I>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          current = undefined;
          runner = Promise.reject(new Error(`${name} stopped with the app`));
          runner.catch(() => {});
        }),
      );
      open(runPromise);
      runner = Promise.resolve(runPromise);
      current = ctx;
    }),
  );
  // `signal` interrupts the run, as a caller's cancel.
  const run = <A, E>(
    effect: Effect.Effect<A, E, I>,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<A> => runner.then((runPromise) => runPromise(effect, options));
  // A synchronous read for a caller that cannot wait, `orElse` while
  // the layer is not up.
  const runSyncOr = <A>(
    effect: Effect.Effect<A, never, I>,
    orElse: () => A,
  ): A =>
    current === undefined ? orElse() : Effect.runSyncWith(current)(effect);
  // For a caller with nothing to do while the layer is not up: settles
  // at once then, and never refuses.
  const runIfOpen = (effect: Effect.Effect<void, never, I>): Promise<void> =>
    current === undefined
      ? Promise.resolve()
      : Effect.runPromiseWith(current)(effect).catch(() => {});
  return { layer, run, runSyncOr, runIfOpen };
};

// The adapter of one service, with `call` running a method of it:
// `call((cli) => cli.readiness)`.
export const forService = <I, S>(tag: Context.Key<I, S>, name: string) => {
  const adapter = make<I>(name);
  const call = <A, E>(f: (service: S) => Effect.Effect<A, E>): Promise<A> =>
    adapter.run(Effect.flatMap(tag, f));
  return { ...adapter, call };
};
