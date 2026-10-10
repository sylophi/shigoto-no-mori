// The root's own way into the graph, for the callbacks it hands host
// code that is not Effect yet (the hub connection's connectInfo answer,
// say): the graph's services, captured once the layer below them is up
// and dropped when it closes. Only the composition root reads it.
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { HostServices } from "./services";

let current: Context.Context<HostServices> | undefined;

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    current = yield* Effect.context<HostServices>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        current = undefined;
      }),
    );
  }),
);

// `effect` read now, or `orElse` while the graph is not up.
export const readNow = <A>(
  effect: Effect.Effect<A, never, HostServices>,
  orElse: () => A,
): A =>
  current === undefined ? orElse() : Effect.runSyncWith(current)(effect);
