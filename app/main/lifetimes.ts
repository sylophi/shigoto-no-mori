// The shapes a subsystem takes in the layer graphs (hostLayer.ts,
// shellLayer.ts) while its insides are not Effect yet. A start that
// throws is logged and the rest of the graph still comes up: a build
// that failed would close the graph's scope, running the quit's
// finalizers under a live app.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const logged = (name: string, start: Effect.Effect<void>) =>
  start.pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        console.error(`[boot] ${name} failed to start:`, Cause.squash(cause));
      }),
    ),
  );

// Started with the app and never stopped.
export const starts = (name: string, start: () => void) =>
  Layer.effectDiscard(logged(name, Effect.sync(start)));

// Started with the app and stopped when the graph closes.
export const lifetime = (
  name: string,
  start: Effect.Effect<void>,
  stop: () => void,
) =>
  Layer.effectDiscard(
    Effect.acquireRelease(logged(name, start), () => Effect.sync(stop)),
  );

// Nothing to start, something to undo when the graph closes.
export const onQuit = (stop: Effect.Effect<void>) =>
  Layer.effectDiscard(Effect.addFinalizer(() => stop));
