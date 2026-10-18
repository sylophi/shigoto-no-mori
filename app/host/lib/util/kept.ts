// An answer kept a while in the host's memory: performance policy, so
// it ages on both clocks and a failure is never one of them (V3.md's
// Time design).
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

// Each key's answer, kept `ttl` from when its lookup began, on the
// Clock of the fiber that asks. A lookup that fails is not kept, and
// concurrent gets of a key share one lookup.
export const keptAnswers = Effect.fnUntraced(function* <K, A, E, R>(
  lookup: (key: K) => Effect.Effect<A, E, R>,
  ttl: Duration.Input,
) {
  const ttlMs = Duration.toMillis(Duration.fromInputUnsafe(ttl));
  // Cache's own TTLs read the wall clock, so it keeps answers for good
  // and drops failures at once, and the age is judged here.
  const cache = yield* Cache.makeWith(
    (key: K) =>
      Effect.flatMap(stamp, (at) =>
        Effect.map(lookup(key), (value) => ({ value, at })),
      ),
    {
      capacity: Infinity,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
    },
  );
  return {
    get: (key: K): Effect.Effect<A, E> =>
      Clock.clockWith((clock) =>
        Cache.invalidateWhen(
          cache,
          key,
          ({ at }) => ageOf(at, stampOf(clock)) >= ttlMs,
        ),
      ).pipe(
        Effect.andThen(Cache.get(cache, key)),
        Effect.map(({ value }) => value),
      ),
    invalidate: (key: K): Effect.Effect<void> => Cache.invalidate(cache, key),
  };
});

// One answer, kept as keptAnswers keeps each key's.
export const keptAnswer = <A, E, R>(
  lookup: Effect.Effect<A, E, R>,
  ttl: Duration.Input,
) =>
  Effect.map(
    keptAnswers(() => lookup, ttl),
    (kept) => kept.get(undefined),
  );
