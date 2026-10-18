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
//     close the link that dial makes. It says the host stopped
//     answering from the drop until that dial lands (the window's
//     "Not responding" on this device), and a reconnect asked while
//     a link is up is no drop. Over the REAL loopback
//     (host/socket/Loopback.ts), with the shell's token.
//   - the link outlives a sleep: neither the window's end nor the
//     host's judges it by a wall clock the sleep moved, so a wake
//     drops nothing (V3.md, "Local links and liveness"). Over a
//     browser's socket, which Effect still sets to read frames as
//     bytes through the link's wrapper.
//   - a host that is starting is watched by its loop's beats: a real
//     process whose loop is stuck in a watch's open (the stall V3.md's
//     "A watch that froze the host" records) is called silent within
//     the start limit, and one that beats is left alone.
//   - a host gone unasked leaves no loopback behind: its pid's
//     loopback.json and the one it was writing aside go, and a
//     loopback.json another host published stays.
//   - terminal callers (stopped `sm`s holding their sockets) fill a
//     place of their own on the loopback: past it the next terminal is
//     turned away as busy, while a window and the shell still link.
//
// Run: pnpm test host-hold.
import { LOOPBACK_FILE } from "@shigomori/engine/Control";
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { afterAll, it } from "vitest";
import { WebSocket as WsWebSocket } from "ws";
import { CLOSE_TRY_AGAIN, LoopbackGroup } from "@shigomori/contracts/link";
import { sessionContract } from "@shigomori/contracts/modules/session";
import { PROTOCOL_VERSION } from "@shigomori/contracts/protocol";
import { effectClient } from "@shared/ipc/effectClient";
import { createServed } from "@shared/ipc/served";
import { type HostAddress, hostLink } from "@shared/remote/hostLink";
import * as Views from "@host/lib/Views";
import type { LinkRegistrar } from "@host/socket/DeviceLink";
import * as Loopback from "@host/socket/Loopback";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import { beats, busyWithin, watchHost } from "../main/core/host/watchdog.ts";
import { clearLoopbackOf } from "../main/core/host/leftovers.ts";
import { hostContext } from "./lib/hostRuntime.mts";
import { pushesLayer } from "./lib/hostStandIns.mts";
import { sleepingClock, testClock, waitFor } from "./lib/checkKit.mts";

const IDLE = {
  runningScripts: 0,
  inflightDeletes: 0,
  inflightMoves: 0,
  engineChanges: [],
  busyTerminals: 0,
};

it("the watchdog leaves an answering host alone and calls a silent one once", async () => {
  const clock = testClock();
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromiseWith(clock.context)(effect);
  let answers: "yes" | "fails" | "never" = "yes";
  let watching = true;
  let asleep = false;
  let sleeps = 0;
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
      asleep: () => asleep,
      sleeps: () => sleeps,
      silent: () => {
        silent += 1;
      },
    }),
  );
  await clock.advance(60_000);
  answers = "fails";
  await clock.advance(60_000);
  assert.equal(silent, 0, "an answer, or a failed link, is not silence");
  // Rounds start every 10 s after the last ended: one ran at 120 s.
  // The machine sleeps through the round begun at 130 s: the clock runs
  // on, and its deadline (160 s) proves nothing.
  answers = "never";
  await clock.advance(15_000);
  asleep = true;
  sleeps += 1;
  await clock.advance(25_000);
  asleep = false;
  sleeps += 1;
  assert.equal(silent, 0, "a round the machine slept through");
  // The machine says it will sleep (160 s) before the next round begins
  // (170 s), whose deadline (200 s) comes due before the wake is heard.
  asleep = true;
  sleeps += 1;
  await clock.advance(40_000);
  asleep = false;
  sleeps += 1;
  assert.equal(silent, 0, "a round begun as the machine went to sleep");
  // Awake: the round begun at 210 s goes unanswered to 240 s.
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
      asleep: () => asleep,
      sleeps: () => sleeps,
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

it("the watchdog calls no host silent on a limit that came late, and asks again", async () => {
  const clock = testClock();
  const { wall, stop } = sleepingClock(clock);
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromiseWith(clock.context)(
      Effect.provideService(effect, Clock.Clock, wall),
    );
  let silent = 0;
  let watching = true;
  const watched = run(
    watchHost({
      probe: Effect.never,
      every: "10 seconds",
      limit: "30 seconds",
      watching: () => watching,
      asleep: () => false,
      sleeps: () => 0,
      silent: () => {
        silent += 1;
      },
    }),
  );
  // The whole app stopped a minute inside the round begun at 10 s: its
  // limit comes due as it runs again, a minute late.
  await clock.advance(20_000);
  stop(60_000);
  await clock.advance(20_000);
  assert.equal(silent, 0, "a limit the shell ran a minute late for");
  // The next round, on time, is silence.
  await clock.advance(40_000);
  assert.equal(silent, 1);
  watching = false;
  await watched;
});

it("a quit's busy check takes the host's answer, or none past its deadline or on a failure", async () => {
  const clock = testClock();
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromiseWith(clock.context)(effect);
  const busy = { ...IDLE, runningScripts: 2 };
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

// The REAL loopback, answering the shell's busy call, on its own scope,
// on the clock given.
async function startHost(dataDir: string, clock?: Clock.Clock) {
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
        file: () => join(dataDir, LOOPBACK_FILE),
        services: Effect.succeed(host),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(StoreChanges.layer, pushesLayer, Views.layer).pipe(
            Layer.provideMerge(Layer.succeedContext(host)),
          ),
        ),
      ),
      scope,
    ).pipe(
      clock === undefined
        ? (built) => built
        : Effect.provideService(Clock.Clock, clock),
    ) as Effect.Effect<Context.Context<Loopback.Loopback>, never, never>,
  );
  const { port, token, shellToken } = await Effect.runPromise(
    Context.get(context, Loopback.Loopback).address,
  );
  return {
    address: { port, token: shellToken, deviceId: "this-device" },
    token,
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
  const answering: boolean[] = [];
  const scope = Scope.makeUnsafe();
  const link = await Effect.runPromise(
    hostLink({
      address: Effect.suspend(() => Deferred.await(address)),
      appVersion: "9.9.9",
      openSocket: (url) => {
        dialed.push(Number(new URL(url).port));
        return new WsWebSocket(url);
      },
      onAnswering: (now) => answering.push(now),
    }).pipe(Scope.provide(scope)),
  );
  try {
    const session = effectClient(sessionContract, link);
    const first = await startHost(dataDir);
    Deferred.doneUnsafe(address, Exit.succeed(first.address));
    assert.deepEqual(await Effect.runPromise(session.busy()), IDLE);
    assert.deepEqual(answering, [true]);

    // The host exits: its waiters go to the next one, which comes up on
    // another port and says so, and the shell asks for a reconnect.
    address = Deferred.makeUnsafe<HostAddress>();
    await first.stop();
    await waitFor(() => answering.at(-1) === false, "the drop said");
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
      assert.deepEqual(answering, [true, false, true]);
      // A reconnect asked while the link is up dials again, and the
      // host never read as not answering meanwhile.
      await Effect.runPromise(link.reconnect);
      await waitFor(
        () => answering.length === 4,
        "the reconnect's dial to land",
      );
      assert.deepEqual(answering, [true, false, true, true]);
    } finally {
      await second.stop();
    }
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

it("the link to the host outlives a sleep at either end", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "host-hold-"));
  dataDirs.push(dataDir);
  const clock = testClock();
  const { wall, sleep } = sleepingClock(clock);
  const host = await startHost(dataDir, wall);
  const answering: boolean[] = [];
  const scope = Scope.makeUnsafe();
  // The window's socket: a browser's, whose binaryType starts as
  // "blob" until Effect sets it, through the link's own wrapper.
  const sockets: WebSocket[] = [];
  try {
    const link = await Effect.runPromise(
      hostLink({
        address: Effect.succeed(host.address),
        appVersion: "9.9.9",
        openSocket: (url) => {
          const socket = new WebSocket(url);
          sockets.push(socket);
          return socket;
        },
        onAnswering: (now) => answering.push(now),
      }).pipe(Effect.provideService(Clock.Clock, wall), Scope.provide(scope)),
    );
    const session = effectClient(sessionContract, link);
    assert.deepEqual(await Effect.runPromise(session.busy()), IDLE);
    assert.equal(sockets[0]?.binaryType, "arraybuffer");
    // A night's sleep after the window's first ping, then the host's
    // liveness round and the window's pinger, in that order, at the
    // wake: either end, before the fix, cut the link there.
    await clock.advance(15_000);
    sleep(8 * 60 * 60_000);
    for (let round = 0; round < 3; round++) await clock.advance(15_000);
    assert.deepEqual(await Effect.runPromise(session.busy()), IDLE);
    assert.deepEqual(answering, [true]);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await host.stop();
  }
});

it("a starting host whose loop sticks in a watch's open is called silent, and one that beats is not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-host-start-"));
  const fifo = join(dir, "fifo");
  execFileSync("mkfifo", [fifo]);
  // A host's start in miniature: it beats as host.ts does, then (when
  // told to stick) watches a path whose open does not return.
  const script = join(dir, "host.cjs");
  writeFileSync(
    script,
    `const { watch } = require("node:fs");
setInterval(() => process.send("beat"), 100);
if (process.argv[2] === "stick") setTimeout(() => watch(process.argv[3]), 500);
`,
  );
  const watch = async (mode: "stick" | "beat") => {
    const child = fork(script, [mode, fifo], { stdio: "ignore" });
    const beat = beats();
    child.on("message", beat.beat);
    let silent = false;
    let watching = true;
    const watched = Effect.runPromise(
      watchHost({
        probe: beat.next,
        every: "200 millis",
        limit: "1 second",
        watching: () => watching,
        asleep: () => false,
        sleeps: () => 0,
        silent: () => {
          silent = true;
        },
      }),
    );
    const settled = await Promise.race([
      watched.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 4_000)),
    ]);
    watching = false;
    child.kill("SIGKILL");
    await watched;
    return { settled, silent };
  };
  try {
    assert.deepEqual(await watch("stick"), { settled: true, silent: true });
    assert.deepEqual(await watch("beat"), { settled: false, silent: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const published = (pid: number) =>
  JSON.stringify({ pid, port: 1, token: "t", appVersion: "0" });

it("a host gone unasked leaves no loopback behind, and another host's stays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-host-left-"));
  const file = join(dir, "loopback.json");
  try {
    writeFileSync(file, published(4242));
    writeFileSync(`${file}.4242`, published(4242));
    await clearLoopbackOf(dir, 4242);
    assert.ok(!existsSync(file), "its loopback.json must go");
    assert.ok(!existsSync(`${file}.4242`), "its file aside must go");

    writeFileSync(file, published(5151));
    await clearLoopbackOf(dir, 4242);
    assert.ok(existsSync(file), "another host's loopback.json must stay");

    // Nothing there, or something unreadable: nothing to clear.
    rmSync(file);
    await clearLoopbackOf(dir, 4242);
    writeFileSync(file, "{");
    await clearLoopbackOf(dir, 4242);
    assert.ok(existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A caller's hello on the loopback, its socket held until `scope`
// closes: a terminal's (no Origin), a window's (its page's Origin), or
// the shell's (its token).
async function helloOn(
  port: number,
  token: string,
  scope: Scope.Scope,
  origin?: string,
) {
  let closedWith: number | undefined;
  const ws = new WsWebSocket(
    `ws://127.0.0.1:${port}`,
    origin === undefined ? {} : { origin },
  );
  ws.on("close", (code) => {
    closedWith = code;
  });
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      // ws's socket is a WebSocketLike at runtime, but its event types differ
      const socket = yield* Socket.fromWebSocket(
        Effect.succeed(ws as Socket.WebSocketLike),
      );
      const protocol = yield* RpcClient.makeProtocolSocket({
        retryPolicy: Schedule.recurs(0),
      }).pipe(
        Effect.provideService(Socket.Socket, socket),
        Effect.provide(RpcSerialization.layerSchemaBinary()),
      );
      // oxlint-disable-next-line shigomori/no-double-cast -- the group's calls are typed only as Rpc.AnyWithProps
      const client = (yield* RpcClient.make(LoopbackGroup, {
        flatten: true,
      }).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      )) as unknown as (
        tag: string,
        payload: unknown,
      ) => Effect.Effect<unknown, unknown>;
      return yield* client("link:hello", {
        deviceId: "this-device",
        deviceKind: "desktop",
        connectionId: "c".repeat(32),
        appVersion: "9.9.9",
        protocolVersion: PROTOCOL_VERSION,
        token,
      });
    }).pipe(Scope.provide(scope)),
  );
  return { exit, closedWith: () => closedWith };
}

it("stopped terminals fill only the terminals' places on the loopback: the next is turned away as busy, and a window and the shell still link", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "host-hold-"));
  dataDirs.push(dataDir);
  const host = await startHost(dataDir);
  const scope = Scope.makeUnsafe();
  try {
    const { port } = host.address;
    for (let terminal = 0; terminal < 48; terminal++) {
      const linked = await helloOn(port, host.token, scope);
      assert.ok(Exit.isSuccess(linked.exit), `terminal ${terminal} linked`);
    }
    const turnedAway = await helloOn(port, host.token, scope);
    assert.ok(Exit.isFailure(turnedAway.exit), "a 49th terminal linked");
    await waitFor(
      () => turnedAway.closedWith() === CLOSE_TRY_AGAIN,
      "the terminal turned away as busy",
    );
    const window = await helloOn(
      port,
      host.token,
      scope,
      "http://localhost:5173",
    );
    assert.ok(Exit.isSuccess(window.exit), "a window was turned away");
    const shell = await helloOn(port, host.address.token, scope);
    assert.ok(Exit.isSuccess(shell.exit), "the shell was turned away");
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await host.stop();
  }
});
