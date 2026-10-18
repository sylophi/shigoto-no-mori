// Durable proof that an answer kept in the host's memory
// (host/lib/util/kept.ts) is asked once for every get that arrives while
// its lookup runs, however long the lookup takes and whether it answers
// or fails, and that no get waits for good: not after an asker was
// interrupted as its lookup started, nor after the owner closed.
//
// Run: pnpm test kept-answers.
import assert from "node:assert/strict";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { it } from "vitest";
import { keptAnswer, keptAnswers } from "@host/lib/util/kept";
import { settleTurns, sleepingClock, testClock } from "./lib/checkKit.mts";

// Two gets while one lookup is held past its 1 s, then released with
// `outcome`: how many lookups ran, and what each get read.
const twoGetsDuring = (outcome: Effect.Effect<string, string>) => {
  const clock = testClock();
  const { wall, sleep } = sleepingClock(clock);
  return Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    let lookups = 0;
    const get = yield* keptAnswer(
      Effect.suspend(() => {
        lookups += 1;
        return Effect.andThen(Deferred.await(release), outcome);
      }),
      "1 second",
    );
    const first = yield* Effect.forkChild(Effect.exit(get));
    yield* Effect.promise(settleTurns);
    sleep(5_000);
    const second = yield* Effect.forkChild(Effect.exit(get));
    yield* Effect.promise(settleTurns);
    yield* Deferred.succeed(release, undefined);
    const exits = yield* Fiber.joinAll([first, second]);
    return { lookups, exits };
  }).pipe(Effect.provideService(Clock.Clock, wall), Effect.scoped);
};

it("two gets during a lookup slower than its time to keep share it", async () => {
  const { lookups, exits } = await Effect.runPromise(
    twoGetsDuring(Effect.succeed("answer")),
  );
  assert.equal(lookups, 1);
  for (const exit of exits) {
    assert.ok(Exit.isSuccess(exit));
    assert.equal(exit.value, "answer");
  }
});

it("two gets during a lookup that fails share it, and both fail", async () => {
  const { lookups, exits } = await Effect.runPromise(
    twoGetsDuring(Effect.fail("unanswered")),
  );
  assert.equal(lookups, 1);
  for (const exit of exits) assert.ok(Exit.isFailure(exit));
});

// A get, or a failure once it has waited a second: what a hang reads as.
const within = <A, E>(get: Effect.Effect<A, E>) =>
  Effect.raceFirst(
    Effect.exit(get),
    Effect.promise(() => new Promise((r) => setTimeout(r, 1_000))).pipe(
      Effect.andThen(Effect.die(new Error("the get hung"))),
    ),
  );

it("a get interrupted as its lookup starts leaves the next get answered", async () => {
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      let asker: Fiber.Fiber<unknown, unknown> | undefined;
      let lookups = 0;
      const get = yield* keptAnswers(() => {
        lookups += 1;
        // The asker is interrupted with its entry set, before the
        // lookup is forked.
        if (lookups === 1) asker?.interruptUnsafe();
        return Effect.succeed("answer");
      }, "1 minute");
      asker = yield* Effect.forkChild(get.get(undefined));
      yield* Fiber.await(asker);
      return yield* within(get.get(undefined));
    }).pipe(Effect.scoped),
  );
  assert.ok(Exit.isSuccess(exit));
  assert.equal(exit.value, "answer");
});

it("a get after its owner closed fails rather than waits", async () => {
  const scope = Scope.makeUnsafe();
  const get = await Effect.runPromise(
    keptAnswer(Effect.succeed("answer"), "1 minute").pipe(Scope.provide(scope)),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));
  const exit = await Effect.runPromise(within(get));
  assert.ok(Exit.isFailure(exit));
});
