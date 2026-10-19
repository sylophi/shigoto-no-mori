// One run of `effect` at a time, shared: a caller arriving while one runs
// waits on it, and the first after it settles starts another. Nothing is
// kept and no clock read, where an `Effect.cachedWithTTL` of zero reads
// the wall clock to tell its run settled.
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

export const joinInFlight = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  let running: Deferred.Deferred<A, E> | undefined;
  return Effect.suspend(() => {
    if (running !== undefined) return Deferred.await(running);
    const deferred = Deferred.makeUnsafe<A, E>();
    running = deferred;
    return effect.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          running = undefined;
          Deferred.doneUnsafe(deferred, exit);
        }),
      ),
    );
  });
};
