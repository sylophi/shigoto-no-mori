// The Promise face of a converted subsystem, for the callers that are
// not Effect yet (EFFECT.md, runtime boundaries). Its layer sits beside
// the subsystem's in the layer graph (main/hostLayer.ts): building it
// captures the graph's context, so a call runs on the graph's own
// services, logger and tracer included, and closing it turns every
// later call away. A call made before the graph is up waits for it,
// since the IPC handlers and a few module-level probes come first.
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const make = <I>(name: string) => {
  let open!: (context: Context.Context<I>) => void;
  let context = new Promise<Context.Context<I>>((resolve) => {
    open = resolve;
  });
  const layer = Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.context<I>().pipe(
        Effect.tap((ctx) => Effect.sync(() => open(ctx))),
      ),
      () =>
        Effect.sync(() => {
          context = Promise.reject(new Error(`${name} stopped with the app`));
          context.catch(() => {});
        }),
    ),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, I>): Promise<A> =>
    context.then((ctx) => Effect.runPromiseWith(ctx)(effect));
  return { layer, run };
};
