// joinInFlight (shared/inFlight.ts), the account's enroll and sign-out:
// callers while a run is out share it, the first after it settles starts
// another, and a failure or an interrupt is shared as it happened and
// kept by nothing.
//
// Run: pnpm test join-in-flight.
import assert from "node:assert/strict";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { it } from "vitest";
import { joinInFlight } from "../shared/inFlight.ts";

it("callers while a run is out share it, and the next after it starts another", async () => {
  let runs = 0;
  const gate = Deferred.makeUnsafe<void>();
  const once = joinInFlight(
    Effect.sync(() => ++runs).pipe(Effect.tap(() => Deferred.await(gate))),
  );
  const answers = await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* Effect.forkChild(once);
      const second = yield* Effect.forkChild(once);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      return [yield* Fiber.join(first), yield* Fiber.join(second)];
    }),
  );
  assert.deepEqual(answers, [1, 1]);
  assert.equal(runs, 1);
  assert.equal(await Effect.runPromise(once), 2, "a settled run was kept");
});

it("a failure reaches every caller of its run, and the next one asks again", async () => {
  let runs = 0;
  const once = joinInFlight(
    Effect.suspend(() =>
      ++runs === 1 ? Effect.fail("unreachable") : Effect.succeed("enrolled"),
    ),
  );
  const failed = await Effect.runPromiseExit(once);
  assert.ok(Exit.isFailure(failed));
  assert.equal(await Effect.runPromise(once), "enrolled");
  assert.equal(runs, 2);
});

it("a run whose caller is interrupted ends its joiners' wait, and the next one asks again", async () => {
  let runs = 0;
  const once = joinInFlight(
    Effect.suspend(() => (++runs === 1 ? Effect.never : Effect.succeed(runs))),
  );
  const joined = await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* Effect.forkChild(once);
      yield* Effect.yieldNow;
      const second = yield* Effect.forkChild(once);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(first);
      return yield* Fiber.await(second);
    }),
  );
  assert.ok(Exit.hasInterrupts(joined));
  assert.equal(await Effect.runPromise(once), 2);
});
