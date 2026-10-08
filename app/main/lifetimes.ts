// The shapes a subsystem takes in the layer graphs (hostLayer.ts,
// shellLayer.ts) while its insides are not Effect yet. A start that
// throws is logged and the rest of the graph still comes up: a build
// that failed would close the graph's scope, running the quit's
// finalizers under a live app.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// Each start and stop is a span in the trace file, named for the
// subsystem, so a slow boot or quit shows which one held it.
const traced = (step: "start" | "stop", name: string) =>
  Effect.withSpan(`Lifetime.${step}`, { attributes: { subsystem: name } });

const started = (name: string, start: Effect.Effect<void>) =>
  start.pipe(
    traced("start", name),
    Effect.catchCause((cause) =>
      Effect.logError(`[boot] ${name} failed to start:`, Cause.squash(cause)),
    ),
  );

// Started with the app and never stopped.
export const starts = (name: string, start: () => void) =>
  Layer.effectDiscard(started(name, Effect.sync(start)));

// Started with the app and stopped when the graph closes.
export const lifetime = (
  name: string,
  start: Effect.Effect<void>,
  stop: () => void,
) =>
  Layer.effectDiscard(
    Effect.acquireRelease(started(name, start), () =>
      Effect.sync(stop).pipe(traced("stop", name)),
    ),
  );

// Nothing to start, something to undo when the graph closes.
export const onQuit = (name: string, stop: Effect.Effect<void>) =>
  Layer.effectDiscard(
    Effect.addFinalizer(() => stop.pipe(traced("stop", name))),
  );
