// Durable proof that an answer kept in the host's memory
// (host/lib/util/kept.ts) is asked once for every get that arrives while
// its lookup runs, however long the lookup takes and whether it answers
// or fails.
//
// Run: pnpm test kept-answers.
import assert from "node:assert/strict";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { it } from "vitest";
import { keptAnswer } from "@host/lib/util/kept";
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
