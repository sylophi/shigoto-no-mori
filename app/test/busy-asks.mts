// Proof that a quit or an update kills only a host that left its busy
// ask unanswered (main/core/host/busyAsks.ts):
//   - a host that answers is heard, so Restart to update still asks
//     about an agent running in a terminal, and is let close,
//   - a host that doesn't answer reads idle, and the quit after kills
//     it, its successor never,
//   - an answer after that, or a time past the watchdog's limit, takes
//     the kill back, and of two asks that overlap the later says.
//
// Run: pnpm test busy-asks.
import assert from "node:assert/strict";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { it } from "vitest";
import { busyAsks } from "../main/core/host/busyAsks.ts";

type Busy = { readonly busyTerminals: number };
const IDLE: Busy = { busyTerminals: 0 };
const AGENT: Busy = { busyTerminals: 1 };
const answered = Effect.succeed(Option.some(AGENT));
const silent = Effect.succeed(Option.none<Busy>());

const asks = () => {
  let now = 0;
  const busy = busyAsks<string, Busy>({
    idle: IDLE,
    freshMs: 30_000,
    now: () => now,
  });
  return {
    busy,
    later: (ms: number) => {
      now += ms;
    },
  };
};

it("a host that answers is heard and let close; one that doesn't reads idle and is killed, its successor never", async () => {
  const { busy } = asks();
  assert.deepEqual(await Effect.runPromise(busy.ask("host", answered)), AGENT);
  assert.equal(busy.kills("host"), false, "killed though it answered");
  assert.deepEqual(await Effect.runPromise(busy.ask("host", silent)), IDLE);
  assert.equal(busy.kills("host"), true);
  assert.equal(busy.kills("next"), false, "its successor killed");
});

it("an answer after it, or a time past the limit, takes the kill back", async () => {
  const { busy, later } = asks();
  await Effect.runPromise(busy.ask("host", silent));
  await Effect.runPromise(busy.ask("host", answered));
  assert.equal(busy.kills("host"), false);
  await Effect.runPromise(busy.ask("host", silent));
  later(30_000);
  assert.equal(busy.kills("host"), false, "killed on a stale ask");
});

it("of two asks that overlap, the later says", async () => {
  const { busy } = asks();
  const gate = Deferred.makeUnsafe<void>();
  const killed = await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* Effect.forkChild(
        busy.ask("host", Effect.as(Deferred.await(gate), Option.none())),
      );
      yield* Effect.yieldNow;
      yield* busy.ask("host", answered);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(first);
      return busy.kills("host");
    }),
  );
  assert.equal(killed, false, "an earlier ask that timed out said");
});
