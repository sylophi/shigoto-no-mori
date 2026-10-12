// Durable proof for the shell's hold on its host (main/hostProcess.ts)
// where it does not need Electron. Asserts:
//   - the watchdog (main/core/host/watchdog.ts) leaves a host that
//     answers, or whose link failed, alone, and calls a host silent
//     past its limit silent once, then stops; a round the machine
//     slept through is asked again rather than read as silence; it
//     stops with the host it watched.
//   - a quit's busy check takes the host's answer, or none once the
//     deadline passes or the call fails, so a quit never waits on a
//     host that does not answer.
//   - the shell's link (shared/remote/hostLink.ts) to a host that came
//     back elsewhere dials it once: the reconnect the shell asks for as
//     the new host says it is up, made while no link was up, does not
//     close the link that dial makes. Over the REAL loopback
//     (host/socket/Loopback.ts), with the shell's token.
//
// Run: pnpm test host-hold.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { afterAll, it } from "vitest";
import { WebSocket as WsWebSocket } from "ws";
import { sessionContract } from "@shigomori/contracts/modules/session";
import { effectClient } from "@shared/ipc/effectClient";
import { createServed } from "@shared/ipc/served";
import { type HostAddress, hostLink } from "@shared/remote/hostLink";
import * as Views from "@host/lib/Views";
import type { LinkRegistrar } from "@host/socket/DeviceLink";
import * as Loopback from "@host/socket/Loopback";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import { busyWithin, watchHost } from "../main/core/host/watchdog.ts";
import { hostContext } from "./lib/hostRuntime.mts";
import { pushesLayer } from "./lib/hostStandIns.mts";
import { testClock, waitFor } from "./lib/checkKit.mts";

const IDLE = { runningScripts: 0, inflightDeletes: 0 };

it("the watchdog leaves an answering host alone and calls a silent one once", async () => {
  const clock = testClock();
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromiseWith(clock.context)(effect);
  let answers: "yes" | "fails" | "never" = "yes";
  let watching = true;
  let wakes = 0;
  let silent = 0;
  const probe = Effect.suspend(() =>
    answers === "yes"
      ? Effect.succeed(IDLE)
      : answers === "fails"
        ? Effect.fail("remote device disconnected")
        : Effect.never,
  );
  const watched = run(
    watchHost({
      probe,
      every: "10 seconds",
      limit: "30 seconds",
      watching: () => watching,
      wakes: () => wakes,
      silent: () => {
        silent += 1;
      },
    }),
  );
  await clock.advance(60_000);
  answers = "fails";
  await clock.advance(60_000);
  assert.equal(silent, 0, "an answer, or a failed link, is not silence");
  // The machine sleeps through a round with its probe out: the clock
  // runs on, and on waking the round is asked again.
  answers = "never";
  await clock.advance(10_000 + 5_000);
  wakes += 1;
  await clock.advance(25_000);
  assert.equal(silent, 0, "a round the machine slept through");
  answers = "yes";
  await clock.advance(20_000);
  answers = "never";
  await clock.advance(10_000 + 29_000);
  assert.equal(silent, 0, "not before the limit");
  await clock.advance(1_000);
  assert.equal(silent, 1);
  await watched;
  await clock.advance(120_000);
  assert.equal(silent, 1, "once, then the watch ends");

  // A watch whose host went (it exited, or the app quits) ends at its
  // next look, whatever the probe would say.
  silent = 0;
  const ended = run(
    watchHost({
      probe: Effect.never,
      every: "10 seconds",
      limit: "30 seconds",
      watching: () => watching,
      wakes: () => wakes,
      silent: () => {
        silent += 1;
      },
    }),
  );
  watching = false;
  await clock.advance(10_000);
  await ended;
  assert.equal(silent, 0);
});

it("a quit's busy check takes the host's answer, or none past its deadline or on a failure", async () => {
  const clock = testClock();
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromiseWith(clock.context)(effect);
  const busy = { runningScripts: 2, inflightDeletes: 0 };
  assert.deepEqual(
    await run(busyWithin(Effect.succeed(busy), "3 seconds")),
    Option.some(busy),
  );
  assert.deepEqual(
    await run(busyWithin(Effect.fail("gone"), "3 seconds")),
    Option.none(),
  );
  const hung = run(busyWithin(Effect.never, "3 seconds"));
  await clock.advance(3_000);
  assert.deepEqual(await hung, Option.none());
});

// The REAL loopback, answering the shell's busy call, on its own scope.
async function startHost(dataDir: string) {
  const registrar: LinkRegistrar = createServed();
  registrar.serveOne(sessionContract, "busy", () => Effect.succeed(IDLE));
  const host = await hostContext();
  const scope = Scope.makeUnsafe();
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      Loopback.layer({
        registrar,
        deviceId: () => "this-device",
        appVersion: "9.9.9",
        file: () => join(dataDir, Loopback.LOOPBACK_FILE),
        services: Effect.succeed(host),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(StoreChanges.layer, pushesLayer, Views.layer).pipe(
            Layer.provideMerge(Layer.succeedContext(host)),
          ),
        ),
      ),
      scope,
    ) as Effect.Effect<Context.Context<Loopback.Loopback>, never, never>,
  );
  const { port, shellToken } = await Effect.runPromise(
    Context.get(context, Loopback.Loopback).address,
  );
  return {
    address: { port, token: shellToken, deviceId: "this-device" },
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

const dataDirs: string[] = [];
afterAll(() => {
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
});

it("the shell's link dials a restarted host once, the reconnect asked as it came up included", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "host-hold-"));
  dataDirs.push(dataDir);
  // The shell's address: the current host's, replaced as one forks.
  let address = Deferred.makeUnsafe<HostAddress>();
  const dialed: number[] = [];
  const scope = Scope.makeUnsafe();
  const link = await Effect.runPromise(
    hostLink({
      address: Effect.suspend(() => Deferred.await(address)),
      appVersion: "9.9.9",
      openSocket: (url) => {
        dialed.push(Number(new URL(url).port));
        return new WsWebSocket(url);
      },
    }).pipe(Scope.provide(scope)),
  );
  try {
    const session = effectClient(sessionContract, link);
    const first = await startHost(dataDir);
    Deferred.doneUnsafe(address, Exit.succeed(first.address));
    assert.deepEqual(await Effect.runPromise(session.busy()), IDLE);

    // The host exits: its waiters go to the next one, which comes up on
    // another port and says so, and the shell asks for a reconnect.
    address = Deferred.makeUnsafe<HostAddress>();
    await first.stop();
    const second = await startHost(dataDir);
    try {
      Deferred.doneUnsafe(address, Exit.succeed(second.address));
      await Effect.runPromise(link.reconnect);
      assert.deepEqual(await Effect.runPromise(session.busy()), IDLE);
      await waitFor(
        () => dialed.includes(second.address.port),
        "the link to dial the new host",
      );
      // A second call rides the same link, which nothing closed.
      assert.deepEqual(await Effect.runPromise(session.busy()), IDLE);
      assert.equal(
        dialed.filter((port) => port === second.address.port).length,
        1,
        "the new host was dialed again: its first link was closed",
      );
    } finally {
      await second.stop();
    }
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});
