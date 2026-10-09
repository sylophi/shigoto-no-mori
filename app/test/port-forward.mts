// Durable proof for port forwarding over byte channels (binary
// channel frames): TCP bytes cross a REAL DIRECT
// websocket between the two fixtures as channel frames
// (shared/remote/channels.ts), brokered by the stub device hub
// exactly as production does (test/lib/directBoot.mts). Nothing
// here is a double on the forward path: device A registers the REAL
// forward contract and handlers on a real direct listener, B
// attaches channels on the real client transport and opens them
// through the real dialer and bridge cache, and A's handler dials REAL
// loopback TCP fixture servers. Asserts:
//   - an ungranted peer is refused (typed CommandRefusedError) before
//     the handler runs, so the fixture server sees no connection,
//   - a granted echo round trip on a channel (attach, open, write,
//     read, reset),
//   - server-initiated bytes arrive with no write first,
//   - a ~1.5 MB transfer crosses in many data frames, byte-identical,
//     while the stub device hub's forwardedCount stays FLAT (nothing
//     but the one-time broker frames ever rides the device hub),
//   - a server-side close ends the channel's direction after its tail
//     bytes, and ending this side too completes the channel,
//   - dialing a dead port fails with the coded "connect-failed", a
//     reused channel id with "channel-taken", and the per-connection
//     channel cap with "too-many-conns",
//   - the surface still serves a fresh channel after full teardown.
//
// Then the CLIENT ENGINE (main/core/portForward/engine.ts), electron-free
// and driven here over the same session, so every engine scenario
// exercises the full chain: a plain local TCP client -> engine
// listener -> channel -> host handler -> loopback fixture. Asserts:
//   - a local dial round-trips an echo through the whole chain, and a
//     duplicate startForward returns the existing forward (taking on
//     the worktree it names), while one naming a different local port
//     moves the listener and keeps that worktree,
//   - a ~1.5 MB local transfer lands byte-identical,
//   - the fixture server closing its socket ends the local client
//     socket (end propagation),
//   - a forward to a port with nothing behind it starts anyway, closes
//     a local dial empty, and reaches a server that comes up later,
//   - stopForward closes the listener and live conns, and a fresh
//     forward still round-trips,
//   - the first concurrent local socket OVER the client-side
//     per-device cap (MAX_CONNS_PER_DEVICE, derived from the engine's
//     exported constant) is destroyed while the capped set stands,
//     with no wire traffic spent on the doomed dial.
//
// Both "devices" share one node process. What separates them is the
// direct wire between them, which is exactly the surface this proof
// pins.
// Run: pnpm test port-forward.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { afterAll, beforeAll, it } from "vitest";
import { CommandRefusedError } from "@shigomori/contracts/errors";
import { CHANNEL_MAX_WRITE_BYTES } from "@shigomori/contracts/modules/link";
import { buildClient } from "@shared/ipc/buildClient";
import { forwardContract } from "@shigomori/contracts/modules/forward";
import type { Client } from "@shigomori/contracts/types";
import { forwardHandlers } from "@host/ipc/modules/forward";
import { mintHexId } from "@host/lib/hexId";
import {
  createPortForwardEngine,
  MAX_CONNS_PER_DEVICE,
  type PortForwardEngine,
} from "../main/core/portForward/engine.ts";
import {
  freeLoopbackPort,
  type LoopbackServer,
  makeTracker,
  startLoopbackServer,
  waitFor,
} from "./lib/checkKit.mts";
import {
  bootDirectWire,
  type DirectWire,
  type PeerTransport,
} from "./lib/directBoot.mts";

// once() with waitFor's deadline treatment: an event that never fires
// fails loudly with a descriptive message instead of hanging the check.
function onceWithin(
  emitter: EventEmitter,
  event: string,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${what}`)),
      timeoutMs,
    );
    emitter.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// A channel driven by hand from B's side: attached on the session
// BEFORE the open (the production order), collecting every inbound
// data frame and counting them, with the peer's end and reset
// observable. `open` runs the real forward:open for the channel id.
async function openChannel(
  peer: PeerTransport,
  forward: Client<typeof forwardContract>,
  port: number,
) {
  const mux = await peer.channels();
  const channelId = mintHexId();
  const parts: Buffer[] = [];
  let size = 0;
  let frames = 0;
  let ended = false;
  let reset = false;
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const waiter of waiters) waiter();
  };
  const handle = mux.attach(channelId, {
    onData: (data, consumed) => {
      parts.push(Buffer.from(data));
      size += data.length;
      frames += 1;
      consumed();
      notify();
    },
    onEnd: () => {
      ended = true;
      notify();
    },
    onReset: () => {
      reset = true;
      notify();
    },
    onWritable: () => {},
  });
  try {
    await forward.open({ port, channelId });
  } catch (error) {
    handle.reset();
    throw error;
  }
  const until = (predicate: () => boolean, what: string, timeoutMs = 15_000) =>
    new Promise<void>((resolve, reject) => {
      if (predicate()) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(
          new Error(
            `${what}: timed out with ${size} bytes after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      const check = () => {
        if (!predicate()) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve();
      };
      waiters.add(check);
    });
  return {
    channelId,
    handle,
    write: (data: Uint8Array) => handle.write(data),
    end: () => handle.end(),
    reset: () => handle.reset(),
    received: () => Buffer.concat(parts, size),
    frames: () => frames,
    ended: () => ended,
    wasReset: () => reset,
    readBytes: async (total: number, timeoutMs?: number) => {
      await until(() => size >= total, `readBytes(${total})`, timeoutMs);
      return Buffer.concat(parts, size).subarray(0, total);
    },
    waitEnded: (timeoutMs?: number) =>
      until(() => ended, "peer end", timeoutMs),
  };
}

// Dials a local listener, writes `payload`, and resolves with the first
// `total` echoed bytes. The deadline turns a wedged chain into a
// descriptive failure instead of a hang. resetAndDestroy, not destroy:
// a plain destroy on a drained socket sends a FIN, which the engine's
// allowHalfOpen listener treats as a live half-open conn held until the
// forward stops, so the collector must RST to release its conn and keep
// the later connCount and cap scenarios honest.
function dialAndCollect(
  port: number,
  payload: Buffer,
  total: number,
  timeoutMs = 20_000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const parts: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      socket.resetAndDestroy();
      reject(
        new Error(
          `dialAndCollect: ${size} of ${total} bytes after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      parts.push(chunk);
      size += chunk.length;
      if (size >= total) {
        clearTimeout(timer);
        socket.resetAndDestroy();
        resolve(Buffer.concat(parts, size));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

let echo: LoopbackServer;
let stub: DirectWire["stub"];
let listener: DirectWire["listener"];
let peerA: DirectWire["peerA"];
let forward: Client<typeof forwardContract>;
let big: Buffer;
let engine: PortForwardEngine;
let started: Awaited<ReturnType<PortForwardEngine["startForward"]>>;
let fresh: Awaited<ReturnType<PortForwardEngine["startForward"]>>;
let fromWorktree: { projectId: string; worktreeId: string };

// The direct wire: A hosts the forward surface on a real direct
// listener, B drives it through the real dialer and bridge cache,
// and the stub device hub carries only the broker exchange
// (bootDirectWire, the shared fixture).
const { track, teardown } = makeTracker();

beforeAll(async () => {
  echo = await startLoopbackServer((socket) => socket.pipe(socket));
  track(() => echo.close());
  ({ stub, listener, peerA } = await bootDirectWire(track, {
    contracts: [[forwardContract, forwardHandlers]],
  }));
  forward = buildClient(forwardContract, peerA.transport);
});

// Reverse creation order via the shared tracker: the direct
// sessions and listener first, then the hub connections, then
// the stub and the fixture server.
afterAll(teardown);

it("ungranted peer: forward:open is refused with the typed CommandRefusedError and no conn is dialed", async () => {
  // (1) Ungranted: refused typed at the direct listener's dispatch
  // (the grant gate lives on the direct wire), before the handler
  // runs. The echo server never sees a dial, and the channel this
  // side attached is reset by the failed open.
  await assert.rejects(
    () => openChannel(peerA, forward, echo.port),
    (error) =>
      error instanceof CommandRefusedError &&
      /not permitted to run commands/.test(error.message),
  );
  assert.equal(
    echo.connections(),
    0,
    "an ungranted open still dialed the fixture server",
  );
});

it("granted echo round trip: attach, open, write, read, reset", async () => {
  listener.setAccepts(true);

  // (2) The basic round trip on a channel: attach, open, write, read
  // the echo, reset.
  const hello = await openChannel(peerA, forward, echo.port);
  assert.equal(echo.connections(), 1);
  hello.write(Buffer.from("hello"));
  assert.equal((await hello.readBytes(5)).toString("utf8"), "hello");
  hello.reset();
  assert.equal(hello.handle.open, false);
});

it("server-initiated bytes arrive with no write first", async () => {
  // (3) Server-initiated bytes: a greeting the service pushes on
  // connect arrives with no write from this side first.
  const greeter = await startLoopbackServer((socket) => {
    socket.write("welcome\n");
  });
  const greeted = await openChannel(peerA, forward, greeter.port);
  assert.equal((await greeted.readBytes(8)).toString("utf8"), "welcome\n");
  greeted.reset();
  await greeter.close();
});

it("large transfer: ~1.5 MB crosses in data frames with the device hub flat, byte-identical", async () => {
  // (4) A ~1.5 MB transfer, echoed back: it crosses as many data
  // frames (bounded by CHANNEL_MAX_WRITE_BYTES), byte-identical, and
  // the stub device hub stays COMPLETELY flat (it only ever saw the
  // one-time broker exchange).
  big = randomBytes(1_500_000);
  const hubBaseline = stub.forwardedCount();
  const bulk = await openChannel(peerA, forward, echo.port);
  bulk.write(big);
  const returned = await bulk.readBytes(big.length, 30_000);
  assert.ok(
    Buffer.compare(big, returned) === 0,
    "echoed bytes differ byte-for-byte",
  );
  const minFrames = Math.ceil(big.length / CHANNEL_MAX_WRITE_BYTES);
  assert.ok(
    bulk.frames() >= minFrames,
    `expected >= ${minFrames} data frames, saw ${bulk.frames()}`,
  );
  assert.equal(
    stub.forwardedCount(),
    hubBaseline,
    "the port-forward stream rode the device hub instead of the direct socket",
  );
  bulk.reset();
  console.log(
    `large transfer: ~1.5 MB crosses in ${bulk.frames()} data frames with the device hub flat, byte-identical`,
  );
});

it("server close: tail bytes, then the peer's end, and ending here completes the channel", async () => {
  // (5) The server closes: the tail bytes land, then the peer's end,
  // and ending this side completes the channel.
  const closer = await startLoopbackServer((socket) => {
    socket.end("tail");
  });
  const closing = await openChannel(peerA, forward, closer.port);
  assert.equal((await closing.readBytes(4)).toString("utf8"), "tail");
  await closing.waitEnded();
  assert.equal(closing.wasReset(), false);
  assert.equal(closing.handle.open, true, "still open for this side");
  closing.end();
  // The end is sent behind any bytes still going out, and the channel
  // goes once the host has it.
  await waitFor(() => !closing.handle.open, "both ends done: channel gone");
  await closer.close();
});

it("a large response followed by a server close arrives complete", async () => {
  // (5b) A large response then a close: a server that writes far more
  // than one channel window and hangs up must still deliver every
  // byte. The bytes the channel holds while the reader catches up
  // outlive the socket's close.
  const dumper = await startLoopbackServer((socket) => {
    socket.end(big);
  });
  const dumped = await openChannel(peerA, forward, dumper.port);
  const all = await dumped.readBytes(big.length, 30_000);
  assert.ok(
    Buffer.compare(big, all) === 0,
    "a large response followed by a close arrived truncated or altered",
  );
  await dumped.waitEnded();
  dumped.end();
  await dumper.close();
});

it('a dead port refuses with "connect-failed", a reused id with "channel-taken"', async () => {
  // (6) A dead port: nothing listens once the fixture closed, so the
  // dial refuses with the coded "connect-failed". A channel id that
  // is already attached on the connection refuses "channel-taken".
  const dead = await startLoopbackServer(() => {});
  const deadPort = dead.port;
  await dead.close();
  await assert.rejects(
    () => openChannel(peerA, forward, deadPort),
    /connect-failed/,
  );
  const taken = await openChannel(peerA, forward, echo.port);
  await assert.rejects(
    () => forward.open({ port: echo.port, channelId: taken.channelId }),
    /channel-taken/,
  );
  taken.reset();
});

it('the 33rd channel on one connection refuses with "too-many-conns"', async () => {
  // (7) The per-connection channel cap: the host refuses the 33rd
  // live channel with "too-many-conns", and the capped set stands.
  const capped = [];
  for (let i = 0; i < 32; i++) {
    // oxlint-disable-next-line no-await-in-loop -- sequential opens by design
    capped.push(await openChannel(peerA, forward, echo.port));
  }
  await assert.rejects(
    () => openChannel(peerA, forward, echo.port),
    /too-many-conns/,
  );
  for (const channel of capped) channel.reset();
});

it("end state: a fresh channel opens and round-trips after full teardown", async () => {
  // (8) End state, asserted through behavior: with everything above
  // torn down, a fresh channel still opens and round-trips.
  const again = await openChannel(peerA, forward, echo.port);
  again.write(Buffer.from("still here"));
  assert.equal((await again.readBytes(10)).toString("utf8"), "still here");
  again.reset();
});

it("engine: a local dial round-trips through the whole chain, and a duplicate start returns the existing forward", async () => {
  // ---- Slice B: the client engine over the same wire ----

  // The engine on device B, its forward api the SAME peer client the
  // direct scenarios drove, so nothing on the forward path is a
  // double. deviceId is ignored on purpose: this check has one peer.
  engine = createPortForwardEngine({
    forwardApiFor: () => forward,
    channelsFor: () => peerA.channels,
  });
  // Tracked last, so the finally's teardown stops it first: an
  // assertion failure mid-scenario must not leave its listeners
  // holding the process open.
  track(() => engine.stopAll());

  // (9) Local round trip through the whole chain, and duplicate
  // startForward semantics (one forward per device+port pair).
  started = await engine.startForward({
    deviceId: "A",
    remotePort: echo.port,
  });
  assert.match(started.forwardId, /^[0-9a-f]{32}$/);
  // The duplicate comes from a worktree's port list, which claims
  // the untagged forward for that worktree.
  fromWorktree = { projectId: "p1", worktreeId: "w1" };
  assert.equal(engine.listForwards()[0]?.worktree, undefined);
  const dup = await engine.startForward({
    deviceId: "A",
    remotePort: echo.port,
    worktree: fromWorktree,
  });
  assert.equal(dup.forwardId, started.forwardId);
  assert.equal(dup.localPort, started.localPort);
  assert.equal(engine.listForwards().length, 1);
  assert.deepEqual(engine.listForwards()[0]?.worktree, fromWorktree);
  const enginePing = await dialAndCollect(
    started.localPort,
    Buffer.from("engine ping"),
    11,
  );
  assert.equal(enginePing.toString("utf8"), "engine ping");
});

it("engine: a start naming another local port moves the listener", async () => {
  // (9b) A start naming a DIFFERENT local port moves the listener:
  // the old number refuses, the new one round-trips, still one
  // forward. Moving back onto the number just released proves the
  // old listener was closed once the new one was bound.
  const before = started.localPort;
  const freePort = await freeLoopbackPort();
  const moved = await engine.startForward({
    deviceId: "A",
    remotePort: echo.port,
    localPort: freePort,
  });
  assert.notEqual(moved.forwardId, started.forwardId);
  assert.equal(moved.localPort, freePort);
  assert.equal(engine.listForwards().length, 1);
  await assert.rejects(
    dialAndCollect(before, Buffer.from("x"), 1, 1_000),
    "the released local port still accepts",
  );
  const movedPing = await dialAndCollect(freePort, Buffer.from("moved"), 5);
  assert.equal(movedPing.toString("utf8"), "moved");
  started = await engine.startForward({
    deviceId: "A",
    remotePort: echo.port,
    localPort: before,
  });
  assert.equal(started.localPort, before);
  assert.equal(engine.listForwards().length, 1);
  // Moves that name no worktree keep the one the forward was tagged
  // with.
  assert.deepEqual(engine.listForwards()[0]?.worktree, fromWorktree);
});

it("engine: a ~1.5 MB transfer lands byte-identical", async () => {
  // (10) A ~1.5 MB transfer through the local listener, chunked by
  // the engine's uplink pump and reassembled off its poll loop.
  const bigLocal = randomBytes(1_500_000);
  const echoedLocal = await dialAndCollect(
    started.localPort,
    bigLocal,
    bigLocal.length,
    30_000,
  );
  assert.ok(
    Buffer.compare(bigLocal, echoedLocal) === 0,
    "engine-echoed bytes differ byte-for-byte",
  );
});

it("engine: the fixture closing its socket ends the local client socket", async () => {
  // (11) eof propagation: the fixture ends its socket after a tail,
  // and the local client must see the bytes AND its own 'end'.
  const byeServer = await startLoopbackServer((socket) => {
    socket.end("bye");
  });
  const byeForward = await engine.startForward({
    deviceId: "A",
    remotePort: byeServer.port,
  });
  const bye = await new Promise<Buffer>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: byeForward.localPort });
    const parts: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("no local eof within 15s"));
    }, 15_000);
    socket.on("data", (chunk) => parts.push(chunk));
    socket.on("end", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(Buffer.concat(parts));
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.equal(bye.toString("utf8"), "bye");
  engine.stopForward(byeForward.forwardId);
  await byeServer.close();
});

it("engine: a forward to a dead port starts anyway and reaches a server that comes up later", async () => {
  // (11b) A forward to a port with nothing behind it still starts: a
  // local dial is accepted and closed with no bytes, and once a server
  // comes up on that port the SAME forward round-trips, with no second
  // start. The local end is named: an ephemeral bind could be handed
  // the very port just reserved for the late server.
  const latePort = await freeLoopbackPort();
  let earlyLocalPort = await freeLoopbackPort();
  while (earlyLocalPort === latePort) {
    // oxlint-disable-next-line no-await-in-loop -- redrawn until distinct.
    earlyLocalPort = await freeLoopbackPort();
  }
  const early = await engine.startForward({
    deviceId: "A",
    remotePort: latePort,
    localPort: earlyLocalPort,
  });
  const deadDial = connect({ host: "127.0.0.1", port: early.localPort });
  let deadDialBytes = 0;
  deadDial.on("data", (chunk) => {
    deadDialBytes += chunk.length;
  });
  deadDial.on("error", () => {});
  deadDial.on("end", () => deadDial.destroy());
  await onceWithin(
    deadDial,
    "close",
    "the dial to a dead remote port to close",
  );
  assert.equal(deadDialBytes, 0);
  const lateServer = await startLoopbackServer(
    (socket) => socket.pipe(socket),
    { port: latePort },
  );
  const lateEcho = await dialAndCollect(
    early.localPort,
    Buffer.from("late"),
    4,
  );
  assert.equal(lateEcho.toString("utf8"), "late");
  engine.stopForward(early.forwardId);
  await lateServer.close();
});

it("engine: stopForward closes the listener and live conns, and a fresh forward still works", async () => {
  // (12) stopForward closes the listener and live conns, and the host
  // registry does not leak: a fresh forward still round-trips.
  const lingering = connect({ host: "127.0.0.1", port: started.localPort });
  lingering.on("error", () => {});
  const lingeringClosed = onceWithin(
    lingering,
    "close",
    "stopForward to tear down the lingering conn's local socket",
  );
  await waitFor(
    () =>
      engine.listForwards().find((f) => f.forwardId === started.forwardId)
        ?.connCount === 1,
    "the lingering conn to register",
  );
  engine.stopForward(started.forwardId);
  assert.equal(engine.listForwards().length, 0);
  await lingeringClosed;
  await assert.rejects(
    () =>
      new Promise<void>((resolve, reject) => {
        const probe = connect({ host: "127.0.0.1", port: started.localPort });
        probe.once("connect", () => {
          probe.destroy();
          resolve();
        });
        probe.once("error", reject);
      }),
    "the stopped forward's listener still accepts",
  );
  fresh = await engine.startForward({
    deviceId: "A",
    remotePort: echo.port,
  });
  const freshEcho = await dialAndCollect(
    fresh.localPort,
    Buffer.from("fresh"),
    5,
  );
  assert.equal(freshEcho.toString("utf8"), "fresh");
});

it(`engine: local socket ${MAX_CONNS_PER_DEVICE + 1} is destroyed at the cap of ${MAX_CONNS_PER_DEVICE}`, async () => {
  // (13) The client-side per-device cap, derived from the engine's
  // exported MAX_CONNS_PER_DEVICE so this scenario tracks the
  // constant: the first local socket OVER the cap is destroyed
  // immediately while the capped set stands. Mirrors the host's
  // MAX_CONNS without spending a hub round trip on the doomed dial.
  const capOpensBefore = peerA.invokeCount("forward:open");
  const capSockets: Socket[] = [];
  for (let i = 0; i < MAX_CONNS_PER_DEVICE; i += 1) {
    const socket = connect({ host: "127.0.0.1", port: fresh.localPort });
    socket.on("error", () => {});
    capSockets.push(socket);
  }
  // Also wait out the capped set's open round trips so the over-cap
  // socket's zero-traffic assertion below cannot miscount a
  // straggler from these dials.
  await waitFor(
    () =>
      engine.listForwards().find((f) => f.forwardId === fresh.forwardId)
        ?.connCount === MAX_CONNS_PER_DEVICE &&
      peerA.invokeCount("forward:open") - capOpensBefore ===
        MAX_CONNS_PER_DEVICE,
    "the capped conns and their open round trips to register",
    10_000,
  );
  const overCapOpensBefore = peerA.invokeCount("forward:open");
  const overCap = connect({ host: "127.0.0.1", port: fresh.localPort });
  overCap.on("error", () => {});
  await onceWithin(
    overCap,
    "close",
    "the over-cap socket to be destroyed at the accept cap",
  );
  // Destroyed at accept means no wire traffic: the doomed dial spent
  // no forward:open round trip.
  assert.equal(
    peerA.invokeCount("forward:open") - overCapOpensBefore,
    0,
    "the capped over-cap socket still spent a forward:open round trip",
  );
  assert.equal(
    engine.listForwards().find((f) => f.forwardId === fresh.forwardId)
      ?.connCount,
    MAX_CONNS_PER_DEVICE,
    "the cap tore down an established conn instead of the over-cap dial",
  );
  for (const socket of capSockets) socket.destroy();
  engine.stopAll();
  assert.equal(engine.listForwards().length, 0);
});
