// Proof that a quit or an update kills only a host that left its busy
// ask unanswered (main/core/host/busyAsks.ts):
//   - a host that answers is heard, so Restart to update still asks
//     about an agent running in a terminal (busyDetail, the dialog's
//     words), and is let close,
//   - a host that doesn't answer reads idle, and the quit after kills
//     it, its successor never,
//   - an answer after that, or a time past the watchdog's limit, takes
//     the kill back, of two asks that overlap the later says, and an
//     ask no quit follows (an update's look before anything is staged)
//     arms nothing.
// The update-button walk drives the same on the packaged app: a job in
// a terminal, Restart to update, and the busy dialog.
//
// Run: pnpm test busy-asks.
import assert from "node:assert/strict";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { it } from "vitest";
import { type BusyOperations, busyDetail } from "@shared/busy";
import { busyAsks } from "../main/core/host/busyAsks.ts";

const IDLE: BusyOperations = {
  runningScripts: 0,
  inflightDeletes: 0,
  inflightMoves: 0,
  engineChanges: [],
  busyTerminals: 0,
};
const AGENT: BusyOperations = { ...IDLE, busyTerminals: 1 };
const answered = Effect.succeed(Option.some(AGENT));
const silent = Effect.succeed(Option.none<BusyOperations>());

const asks = () => {
  let now = 0;
  const busy = busyAsks<string, BusyOperations>({
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

it("a host that answers is asked about and let close; one that doesn't reads idle and is killed, its successor never", async () => {
  const { busy } = asks();
  const heard = await Effect.runPromise(busy.ask("host", answered, true));
  assert.notEqual(
    busyDetail(heard, "restart"),
    null,
    "Restart to update asked nothing about the agent",
  );
  assert.equal(busy.kills("host"), false, "killed though it answered");
  const unheard = await Effect.runPromise(busy.ask("host", silent, true));
  assert.equal(busyDetail(unheard, "restart"), null);
  assert.equal(busy.kills("host"), true);
  assert.equal(busy.kills("next"), false, "its successor killed");
});

it("an answer after it, or a time past the limit, takes the kill back", async () => {
  const { busy, later } = asks();
  await Effect.runPromise(busy.ask("host", silent, true));
  await Effect.runPromise(busy.ask("host", answered, true));
  assert.equal(busy.kills("host"), false);
  await Effect.runPromise(busy.ask("host", silent, true));
  later(30_000);
  assert.equal(busy.kills("host"), false, "killed on a stale ask");
});

it("of two asks that overlap, the later says", async () => {
  const { busy } = asks();
  const gate = Deferred.makeUnsafe<void>();
  const killed = await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* Effect.forkChild(
        busy.ask("host", Effect.as(Deferred.await(gate), Option.none()), true),
      );
      yield* Effect.yieldNow;
      yield* busy.ask("host", answered, true);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(first);
      return busy.kills("host");
    }),
  );
  assert.equal(killed, false, "an earlier ask that timed out said");
});

it("an ask no quit follows arms nothing", async () => {
  const { busy } = asks();
  assert.deepEqual(
    await Effect.runPromise(busy.ask("host", silent, false)),
    IDLE,
  );
  assert.equal(busy.kills("host"), false, "a later nuke or relaunch killed it");
});
