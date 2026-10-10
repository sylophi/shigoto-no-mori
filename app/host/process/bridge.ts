// The root's way into the graph for the callbacks it hands host code
// that is not Effect yet (the broadcast seam, the hub connection's
// connectInfo answer, the data-folder move). A capture's layer sits in
// the graph (layer.ts) where the services it reads are up, so a call
// runs on them, and a call before then waits for them or settles
// without them. A call runs in the layer's own fiber set, so the graph
// closing interrupts whatever is still under way. Only the composition
// root uses it; each goes as the code it serves becomes Effect (V3.md,
// the host's Promise adapters).
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";

type RunPromise<I> = <A, E>(effect: Effect.Effect<A, E, I>) => Promise<A>;

export const capture = <I>(name: string) => {
  let current: Context.Context<I> | undefined;
  let runner: RunPromise<I> | undefined;
  let open!: (runPromise: RunPromise<I>) => void;
  let ready = new Promise<RunPromise<I>>((resolve) => {
    open = resolve;
  });
  const layer = Layer.effectDiscard(
    Effect.gen(function* () {
      const context = yield* Effect.context<I>();
      const runPromise: RunPromise<I> = yield* FiberSet.makeRuntimePromise<I>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          current = undefined;
          runner = undefined;
          ready = Promise.reject(new Error(`${name} stopped with the app`));
          ready.catch(() => {});
        }),
      );
      current = context;
      runner = runPromise;
      open(runPromise);
      ready = Promise.resolve(runPromise);
    }),
  );
  return {
    layer,
    // `effect` now, or `orElse` while the services are not up.
    readNow: <A>(effect: Effect.Effect<A, never, I>, orElse: () => A): A =>
      current === undefined ? orElse() : Effect.runSyncWith(current)(effect),
    // `effect` once the services are up, refused once they are gone.
    run: <A, E>(effect: Effect.Effect<A, E, I>): Promise<A> =>
      ready.then((runPromise) => runPromise(effect)),
    // `effect` when the services are up, else nothing.
    runIfUp: (effect: Effect.Effect<void, never, I>): Promise<void> =>
      runner === undefined ? Promise.resolve() : runner(effect),
  };
};
