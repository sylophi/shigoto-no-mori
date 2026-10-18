// An answer kept a while in the host's memory: performance policy, so
// it ages on both clocks and a failure is never one of them (V3.md's
// Time design).
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

  const start = (key: K, at: Stamp) => {
    const entry: Entry<A, E> = {
      at,
      result: Deferred.makeUnsafe<A, E>(),
      keptMs: null,
    };
    entries.set(key, entry);
    const run = Effect.updateContext(
      lookup(key),
      (input: Context.Context<never>) => Context.merge(context, input),
    ).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          entry.keptMs = Exit.isSuccess(exit) ? answerMs : failureMs;
          if (entry.keptMs === 0 && entries.get(key) === entry) {
            entries.delete(key);
          }
          Deferred.doneUnsafe(entry.result, exit);
        }),
      ),
    );
    return Effect.as(FiberSet.run(lookups, run), entry);
  };

  return {
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
      ).pipe(Effect.flatMap((entry) => Deferred.await(entry.result))),
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
