// An answer kept a while in memory, to spare repeating a slow read: it
// ages on both clocks, and a failure is kept only when asked, never for
// the answer's life.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { elapsedMillisUnsafe } from "./elapsed.ts";

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
  readonly result: Deferred.Deferred<A, E>;
  readonly fiber: Fiber.Fiber<A, E>;
  waiters: number;
  // When the lookup ended and how long its answer is kept, null while
  // it runs.
  kept: { readonly at: Stamp; readonly ms: number } | null;
};

// Each key's answer, kept `ttl` from when its lookup ended, on the Clock
// of the fiber that asks. Keys compare by value. Every get while a
// lookup runs shares it, its failure included, and the last of them to
// stop waiting interrupts it. A failure is kept `failures` (none by
// default): long enough that a stuck lookup isn't run again by every
// ask, never for the answer's life.
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
  const entries = MutableHashMap.empty<K, Entry<A, E>>();

  const drop = (key: K, entry: Entry<A, E>) => {
    if (Option.getOrUndefined(MutableHashMap.get(entries, key)) === entry) {
      MutableHashMap.remove(entries, key);
    }
  };

  // Settled by the lookup's fiber however it ends: interrupted with the
  // layer, or never started on a set already closed, included.
  const start = (key: K, caller: Fiber.Fiber<unknown, unknown>) => {
    // A fork runs until its first wait before the set can refuse it.
    const fiber = Effect.runForkWith(Context.merge(context, caller.context))(
      Predicate.isTagged(lookups.state, "Closed")
        ? Effect.interrupt
        : lookup(key),
    );
    FiberSet.addUnsafe(lookups, fiber);
    const entry: Entry<A, E> = {
      result: Deferred.makeUnsafe<A, E>(),
      fiber,
      waiters: 0,
      kept: null,
    };
    MutableHashMap.set(entries, key, entry);
    const clock = caller.getRef(Clock.Clock);
    fiber.addObserver((exit) => {
      const ms = Exit.isSuccess(exit)
        ? answerMs
        : Exit.hasInterrupts(exit)
          ? 0
          : failureMs;
      entry.kept = { at: stampOf(clock), ms };
      if (ms === 0) drop(key, entry);
      Deferred.doneUnsafe(entry.result, exit);
    });
    return entry;
  };

  const leave = (key: K, entry: Entry<A, E>) =>
    Effect.suspend(() => {
      entry.waiters -= 1;
      if (entry.waiters > 0 || entry.kept !== null) return Effect.void;
      drop(key, entry);
      return Fiber.interrupt(entry.fiber);
    });

  return {
    // An entry is found or started and its asker counted in one
    // synchronous step, so no other fiber sees it between: a leave can't
    // interrupt a lookup just joined, nor an invalidate miss one just
    // started. Uninterruptible but for the wait, so a count taken is
    // always given back.
    get: (key: K): Effect.Effect<A, E> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.withFiber((caller) => {
          const now = stampOf(caller.getRef(Clock.Clock));
          // Every answer past its age goes as any key is asked, so a key
          // no longer asked keeps none.
          for (const [old, { kept }] of entries) {
            if (kept !== null && ageOf(kept.at, now) >= kept.ms) {
              MutableHashMap.remove(entries, old);
            }
          }
          const entry =
            Option.getOrUndefined(MutableHashMap.get(entries, key)) ??
            start(key, caller);
          entry.waiters += 1;
          return restore(Deferred.await(entry.result)).pipe(
            Effect.ensuring(leave(key, entry)),
          );
        }),
      ),
    invalidate: (key: K): Effect.Effect<void> =>
      Effect.sync(() => {
        MutableHashMap.remove(entries, key);
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
