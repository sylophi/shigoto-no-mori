// The root's way into the graph for the callbacks it hands host code
// that is not Effect yet (the broadcast seam, the hub connection's
// connectInfo answer, the data-folder move). A capture's layer sits in
// the graph (layer.ts) where the services it reads are up, so a call
// runs on them, and a call before then waits for them or settles
// without them. Only the composition root uses it; each goes as the
// code it serves becomes Effect (V3.md, the host's Promise adapters).
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const capture = <I>(name: string) => {
  let current: Context.Context<I> | undefined;
  let open!: (context: Context.Context<I>) => void;
  let ready = new Promise<Context.Context<I>>((resolve) => {
    open = resolve;
  });
  const layer = Layer.effectDiscard(
    Effect.gen(function* () {
      const context = yield* Effect.context<I>();
      current = context;
      open(context);
      ready = Promise.resolve(context);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          current = undefined;
          ready = Promise.reject(new Error(`${name} stopped with the app`));
          ready.catch(() => {});
        }),
      );
    }),
  );
  return {
    layer,
    // `effect` now, or `orElse` while the services are not up.
    readNow: <A>(effect: Effect.Effect<A, never, I>, orElse: () => A): A =>
      current === undefined ? orElse() : Effect.runSyncWith(current)(effect),
    // `effect` once the services are up, refused once they are gone.
    run: <A, E>(effect: Effect.Effect<A, E, I>): Promise<A> =>
      ready.then((context) => Effect.runPromiseWith(context)(effect)),
    // `effect` when the services are up, else nothing.
    runIfUp: (effect: Effect.Effect<void, never, I>): Promise<void> =>
      current === undefined
        ? Promise.resolve()
        : Effect.runPromiseWith(current)(effect),
  };
};
