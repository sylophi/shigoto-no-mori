// An answer kept a while in the host's memory, to spare repeating a
// slow read: it ages on both clocks, and a failure is kept only when
// asked, never for the answer's life.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import { elapsedMillisUnsafe } from "@shigomori/engine/elapsed";

// An observation's time on both clocks, and its age by whichever reads
// older, so neither a sleep nor a step of the wall clock either way
// keeps it past its age.
export type Stamp = { readonly elapsed: number; readonly wall: number };
export const stampOf = (clock: Clock.Clock): Stamp => ({
  elapsed: elapsedMillisUnsafe(clock),
  wall: clock.currentTimeMillisUnsafe(),
});
export const stamp: Effect.Effect<Stamp> = Clock.clockWith((clock) =>
  Effect.sync(() => stampOf(clock)),
);
export const ageOf = (at: Stamp, now: Stamp): number =>
  Math.max(now.elapsed - at.elapsed, now.wall - at.wall);

type Entry<A, E> = {
  readonly at: Stamp;
  readonly result: Deferred.Deferred<A, E>;
  // Null while the lookup runs.
  keptMs: number | null;
};

// Each key's answer, kept `ttl` from when its lookup began, on the
// Clock of the fiber that asks. Every get while a lookup runs shares it,
// its failure included. A failure is kept `failures` (none by default):
// long enough that a stuck lookup isn't run again by every ask, never
// for the answer's life.
export const keptAnswers = Effect.fnUntraced(function* <K, A, E, R>(
  lookup: (key: K) => Effect.Effect<A, E, R>,
  ttl: Duration.Input,
  options: { readonly failures?: Duration.Input } = {},
) {
  const answerMs = Duration.toMillis(Duration.fromInputUnsafe(ttl));
  const failureMs =
    options.failures === undefined
      ? 0
      : Duration.toMillis(Duration.fromInputUnsafe(options.failures));
  const context = yield* Effect.context<R>();
  // The lookups run here, so a caller that stops waiting leaves the
  // others theirs.
  const lookups = yield* FiberSet.make();
  const entries = new Map<K, Entry<A, E>>();

  // Settled by the lookup's fiber however it ends: interrupted with the
  // layer, or never started on a set already closed, included.
  const start = (key: K, at: Stamp) =>
    Effect.gen(function* () {
      const entry: Entry<A, E> = {
        at,
        result: Deferred.makeUnsafe<A, E>(),
        keptMs: null,
      };
      entries.set(key, entry);
      const fiber = yield* FiberSet.run(
        lookups,
        Effect.updateContext(lookup(key), (input: Context.Context<never>) =>
          Context.merge(context, input),
        ),
      );
      fiber.addObserver((exit) => {
        entry.keptMs = Exit.isSuccess(exit) ? answerMs : failureMs;
        if (entry.keptMs === 0 && entries.get(key) === entry) {
          entries.delete(key);
        }
        Deferred.doneUnsafe(entry.result, exit);
      });
      return entry;
    });

  return {
    // The entry is set and its lookup started in one uninterruptible
    // step: an asker interrupted between the two would leave an entry
    // nothing settles, which every later get would wait on.
    get: (key: K): Effect.Effect<A, E> =>
      Clock.clockWith((clock) =>
        Effect.suspend(() => {
          const now = stampOf(clock);
          const entry = entries.get(key);
          const fresh =
            entry !== undefined &&
            (entry.keptMs === null || ageOf(entry.at, now) < entry.keptMs);
          return fresh ? Effect.succeed(entry) : start(key, now);
        }),
      ).pipe(
        Effect.uninterruptible,
        Effect.flatMap((entry) => Deferred.await(entry.result)),
      ),
    invalidate: (key: K): Effect.Effect<void> =>
      Effect.sync(() => {
        entries.delete(key);
      }),
  };
});

// One answer, kept as keptAnswers keeps each key's.
export const keptAnswer = <A, E, R>(
  lookup: Effect.Effect<A, E, R>,
  ttl: Duration.Input,
  options: { readonly failures?: Duration.Input } = {},
) =>
  Effect.map(
    keptAnswers(() => lookup, ttl, options),
    (kept) => kept.get(undefined),
  );
