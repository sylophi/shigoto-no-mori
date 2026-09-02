// Durable proof for the port-forward wire (v2 step 8, slice A;
// direct-only since step 10 slice C): TCP bytes as chunked,
// grant-gated invoke responses over a REAL DIRECT websocket between
// the two fixtures, brokered by the stub device hub exactly as production
// does (scripts/lib/directBoot.mjs). Nothing here is a double on the
// forward path itself: device A registers the REAL forward contract
// and handlers on a real ticket-mode listener, B drives them through
// the real dialer and bridge cache, and the handlers dial REAL
// loopback TCP fixture servers. Asserts:
//   - an ungranted peer is refused (typed CommandRefusedError) before
//     the handler runs, so the fixture server sees no connection.
//   - a granted echo round trip (open, send, poll, close).
//   - server-initiated bytes arrive through poll without an uplink
//     write first (the long-poll downlink).
//   - a ~1.5 MB transfer crosses chunked, byte-identical, in multiple
//     send AND poll round trips, while the stub device hub's forwardedCount
//     stays FLAT (nothing but the one-time broker frames ever rides
//     the device hub).
//   - a server-side close drains buffered bytes before eof, refuses a
//     send with the coded "conn-closed", and a drained conn is gone
//     ("unknown-conn").
//   - dialing a dead port fails with the coded "connect-failed".
//   - close is idempotent, a concurrent second poll is refused
//     ("poll-in-flight"), and a poll parked across a close resolves
//     eof.
//   - the surface still serves a fresh conn after full teardown.
//
// Slice B adds the CLIENT ENGINE (main/portForward/engine.ts), which is
// electron-free and driven here over the same peer transport, so every
// engine scenario exercises the full chain: a plain local TCP client ->
// engine listener -> hub stub -> host verbs -> loopback fixture.
// Asserts on top of the slice A set:
//   - a local dial round-trips an echo through the whole chain, and a
//     duplicate startForward returns the existing forward, while one
//     naming a different local port moves the listener.
//   - a ~1.5 MB local transfer lands byte-identical.
//   - the fixture server closing its socket ends the local client
//     socket (eof propagation).
//   - stopForward closes the listener and live conns, and the host
//     registry does not leak (a fresh forward still round-trips).
//   - the first concurrent local socket OVER the client-side
//     per-device cap (MAX_CONNS_PER_DEVICE, derived from the engine's
//     exported constant) is destroyed while the capped set stands,
//     with no wire traffic spent on the doomed dial.
//
// Both "devices" share one node process. What separates them is the
// direct wire between them, which is exactly the surface this proof
// pins. Runs under scripts/lib/register-ts-alias.mjs. See
// package.json "forward:check".
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { connect, createServer } from "node:net";
import {
  CommandRefusedError,
  WIRE_CHUNK_BYTES,
} from "@shared/ipc/socket/frames";
import { buildClient } from "@shared/ipc/buildClient";
import { forwardContract } from "@shared/ipc/modules/forward";
import { registerContract } from "@shared/ipc/registerContract";
import { forwardHandlers } from "@host/ipc/modules/forward";
import {
  createPortForwardEngine,
  MAX_CONNS_PER_DEVICE,
} from "../main/portForward/engine.ts";
import { freeLoopbackPort, makeProof, makeTracker } from "./lib/checkKit.mjs";
import { bootDirectWire } from "./lib/directBoot.mjs";
import { delay, waitFor } from "./lib/hubBoot.mjs";

// once() with waitFor's deadline treatment: an event that never fires
// fails loudly with a descriptive message instead of hanging the check.
function onceWithin(emitter, event, what, timeoutMs = 10_000) {
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

// A loopback fixture server on an ephemeral port. `onConnection` is
// the per-socket behavior (echo, greet, close). `connections` counts
// accepted sockets so the grant proof can assert the handler never
// dialed.
function startFixtureServer(onConnection) {
  return new Promise((resolve) => {
    const state = { connections: 0 };
    const sockets = new Set();
    const server = createServer((socket) => {
      state.connections += 1;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      // A host-side destroy can surface as ECONNRESET here, and an
      // unlistened socket error would take down the whole check.
      socket.on("error", () => {});
      onConnection(socket);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        connections: () => state.connections,
        close: () =>
          new Promise((done) => {
            // server.close waits out live connections, and an assertion
            // failure reaches this finally with host-side conns still
            // open, so destroy accepted sockets or the process hangs
            // with no diagnostic instead of reporting the failure.
            for (const socket of sockets) socket.destroy();
            server.close(done);
          }),
      });
    });
  });
}

// Drives poll until `total` raw bytes arrived, then returns them. An
// empty answer is a long-poll retry, never a failure, but the deadline
// (same shape as waitFor) keeps bytes that never arrive from spinning
// this forever: expiry throws a descriptive error instead.
async function pollBytes(forward, connId, total, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const parts = [];
  let size = 0;
  while (size < total) {
    if (Date.now() > deadline) {
      throw new Error(
        `pollBytes: timed out with ${size} of ${total} bytes after ${timeoutMs}ms`,
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential by design
    const { dataB64, eof } = await forward.poll({ connId });
    assert.equal(eof, false, "eof before the expected bytes all arrived");
    const data = Buffer.from(dataB64, "base64");
    parts.push(data);
    size += data.length;
  }
  return Buffer.concat(parts, size);
}

// Dials a local listener, writes `payload`, and resolves with the first
// `total` echoed bytes. The deadline turns a wedged chain into a
// descriptive failure instead of a hang. resetAndDestroy, not destroy:
// a plain destroy on a drained socket sends a FIN, which the engine's
// allowHalfOpen listener treats as a live half-open conn held until the
// forward stops, so the collector must RST to release its conn and keep
// the later connCount and cap scenarios honest.
function dialAndCollect(port, payload, total, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const parts = [];
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

const { ok, done, fail } = makeProof("port-forward proof");

async function main() {
  console.log("port-forward proof\n");

  const echo = await startFixtureServer((socket) => socket.pipe(socket));

  // The direct wire: A hosts the forward surface on a real ticket-mode
  // listener, B drives it through the real dialer and bridge cache,
  // and the stub device hub carries only the broker exchange
  // (bootDirectWire, the shared fixture).
  const { track, teardown } = makeTracker();
  track(() => echo.close());
  // The registered send handler is wrapped with a counter, so the
  // chunking assertion in the transfer scenario counts PRODUCTION
  // dispatches on the serving side (frames that provably crossed the
  // wire), not the check's own loop iterations.
  let serverSends = 0;
  const countedForwardHandlers = {
    ...forwardHandlers,
    send: (input, ctx) => {
      serverSends += 1;
      return forwardHandlers.send(input, ctx);
    },
  };
  const { stub, listener, peerA } = await bootDirectWire(track, {
    registerHandlers: (binding) => {
      registerContract(forwardContract, countedForwardHandlers, binding, {
        validateOutputs: true,
      });
    },
  });
  // Torn down in the finally so an assertion failure mid-scenario does
  // not leave listeners and parked polls holding the process open.
  let engine = null;
  try {
    const forward = buildClient(forwardContract, peerA.transport);

    // (1) Ungranted: refused typed at the direct listener's dispatch
    // (the grant gate lives on the direct wire now), before the
    // handler runs. The echo server never sees a dial.
    await assert.rejects(
      () => forward.open({ port: echo.port }),
      (error) =>
        error instanceof CommandRefusedError &&
        /not permitted to run commands/.test(error.message),
    );
    assert.equal(
      echo.connections(),
      0,
      "an ungranted open still dialed the fixture server",
    );
    ok(
      "ungranted peer: forward:open is refused with the typed CommandRefusedError and no conn is dialed",
    );

    listener.granted.add("B");

    // (2) The basic round trip: open, send, poll the echo, close.
    const { connId } = await forward.open({ port: echo.port });
    assert.equal(echo.connections(), 1);
    await forward.send({
      connId,
      dataB64: Buffer.from("hello").toString("base64"),
    });
    const echoed = await pollBytes(forward, connId, 5);
    assert.equal(echoed.toString("utf8"), "hello");
    await forward.close({ connId });
    ok("granted echo round trip: open, send, poll, close");

    // (3) Server-initiated bytes: the downlink must not require an
    // uplink write first. The long-poll picks up a greeting the
    // service pushed on connect.
    const greeter = await startFixtureServer((socket) => {
      socket.write("welcome\n");
    });
    const greeted = await forward.open({ port: greeter.port });
    const greeting = await pollBytes(forward, greeted.connId, 8);
    assert.equal(greeting.toString("utf8"), "welcome\n");
    await forward.close({ connId: greeted.connId });
    await greeter.close();
    ok("server-initiated bytes arrive through poll without an uplink write");

    // (4) A ~1.5 MB transfer, chunked both ways: sent in
    // WIRE_CHUNK_BYTES slices, echoed back, polled until complete. The
    // transfer rides the direct socket, so the stub device hub must stay
    // COMPLETELY flat (it only ever saw the one-time broker exchange).
    // Chunking is proven on both halves: the send half counts the
    // registered handler's dispatches SERVER-SIDE (production frames
    // that crossed the wire, not this loop's own iterations), and the
    // poll half counts client round trips through the peer transport.
    const big = randomBytes(1_500_000);
    const hubBaseline = stub.forwardedCount();
    const sendsBefore = serverSends;
    const pollsBefore = peerA.invokeCount("forward:poll");
    const bulk = await forward.open({ port: echo.port });
    for (let offset = 0; offset < big.length; offset += WIRE_CHUNK_BYTES) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await forward.send({
        connId: bulk.connId,
        dataB64: big
          .subarray(offset, offset + WIRE_CHUNK_BYTES)
          .toString("base64"),
      });
    }
    const returned = await pollBytes(forward, bulk.connId, big.length);
    assert.ok(
      Buffer.compare(big, returned) === 0,
      "echoed bytes differ byte-for-byte",
    );
    const sendReqs = serverSends - sendsBefore;
    const pollReqs = peerA.invokeCount("forward:poll") - pollsBefore;
    assert.ok(sendReqs >= 3, `expected >= 3 send frames, saw ${sendReqs}`);
    assert.ok(pollReqs >= 3, `expected >= 3 poll frames, saw ${pollReqs}`);
    assert.equal(
      stub.forwardedCount(),
      hubBaseline,
      "the port-forward stream rode the device hub instead of the direct socket",
    );
    await forward.close({ connId: bulk.connId });
    ok(
      "large transfer: ~1.5 MB crosses chunked in >= 3 send and >= 3 poll round trips with the device hub flat, byte-identical",
    );

    // (5) The server closes: buffered bytes drain first (eof only once
    // the buffer is empty), a send into the ended stream refuses with
    // the coded "conn-closed", and the drained conn is dropped.
    const closer = await startFixtureServer((socket) => {
      socket.end("tail");
    });
    const closing = await forward.open({ port: closer.port });
    // Let both the bytes and the FIN land host-side before polling, so
    // the first poll provably sees data AND remoteEnded together.
    await delay(100);
    const drained = await forward.poll({ connId: closing.connId });
    assert.equal(
      Buffer.from(drained.dataB64, "base64").toString("utf8"),
      "tail",
    );
    assert.equal(drained.eof, false, "eof must wait for a drained buffer");
    await assert.rejects(
      () =>
        forward.send({
          connId: closing.connId,
          dataB64: Buffer.from("late").toString("base64"),
        }),
      /conn-closed/,
    );
    const final = await forward.poll({ connId: closing.connId });
    assert.equal(final.dataB64, "");
    assert.equal(final.eof, true);
    await assert.rejects(
      () => forward.poll({ connId: closing.connId }),
      /unknown-conn/,
    );
    await assert.rejects(
      () =>
        forward.send({
          connId: closing.connId,
          dataB64: Buffer.from("gone").toString("base64"),
        }),
      /unknown-conn/,
    );
    await closer.close();
    ok(
      'server close: bytes drain before eof, then "conn-closed" and "unknown-conn" refusals',
    );

    // (6) A dead port: nothing listens once the fixture closed, so the
    // dial refuses with the coded "connect-failed".
    const dead = await startFixtureServer(() => {});
    const deadPort = dead.port;
    await dead.close();
    await assert.rejects(
      () => forward.open({ port: deadPort }),
      /connect-failed/,
    );
    ok('a dead port refuses with the coded "connect-failed"');

    // (7) Teardown semantics: close is idempotent, a second concurrent
    // poll is refused loudly, and a poll parked across the close
    // resolves eof instead of waiting out its long-poll timer.
    const idle = await forward.open({ port: echo.port });
    const parked = forward.poll({ connId: idle.connId });
    await delay(50);
    await assert.rejects(
      () => forward.poll({ connId: idle.connId }),
      /poll-in-flight/,
    );
    await forward.close({ connId: idle.connId });
    const released = await parked;
    assert.equal(released.eof, true);
    await forward.close({ connId: idle.connId });
    ok(
      "teardown: double close is a no-op, a second poll is refused, and a parked poll resolves eof on close",
    );

    // (8) End state, asserted through behavior: with everything above
    // torn down, a fresh conn still opens and round-trips, so no stale
    // registry entry is wedging the surface.
    const again = await forward.open({ port: echo.port });
    await forward.send({
      connId: again.connId,
      dataB64: Buffer.from("still here").toString("base64"),
    });
    const still = await pollBytes(forward, again.connId, 10);
    assert.equal(still.toString("utf8"), "still here");
    await forward.close({ connId: again.connId });
    ok("end state: a fresh conn opens and round-trips after full teardown");

    // ---- Slice B: the client engine over the same wire ----

    // The engine on device B, its forward api the SAME peer client the
    // direct scenarios drove, so nothing on the forward path is a
    // double. deviceId is ignored on purpose: this check has one peer.
    engine = createPortForwardEngine({ forwardApiFor: () => forward });

    // (9) Local round trip through the whole chain, and duplicate
    // startForward semantics (one forward per device+port pair).
    let started = await engine.startForward({
      deviceId: "A",
      remotePort: echo.port,
    });
    assert.match(started.forwardId, /^[0-9a-f]{32}$/);
    const dup = await engine.startForward({
      deviceId: "A",
      remotePort: echo.port,
    });
    assert.equal(dup.forwardId, started.forwardId);
    assert.equal(dup.localPort, started.localPort);
    assert.equal(engine.listForwards().length, 1);
    const enginePing = await dialAndCollect(
      started.localPort,
      Buffer.from("engine ping"),
      11,
    );
    assert.equal(enginePing.toString("utf8"), "engine ping");
    ok(
      "engine: a local dial round-trips through the whole chain, and a duplicate start returns the existing forward",
    );

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
    ok("engine: a start naming another local port moves the listener");

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
    ok("engine: a ~1.5 MB transfer lands byte-identical");

    // (11) eof propagation: the fixture ends its socket after a tail,
    // and the local client must see the bytes AND its own 'end'.
    const byeServer = await startFixtureServer((socket) => {
      socket.end("bye");
    });
    const byeForward = await engine.startForward({
      deviceId: "A",
      remotePort: byeServer.port,
    });
    const bye = await new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: byeForward.localPort });
      const parts = [];
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
    ok("engine: the fixture closing its socket ends the local client socket");

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
        new Promise((resolve, reject) => {
          const probe = connect({ host: "127.0.0.1", port: started.localPort });
          probe.once("connect", () => {
            probe.destroy();
            resolve();
          });
          probe.once("error", reject);
        }),
      undefined,
      "the stopped forward's listener still accepts",
    );
    const fresh = await engine.startForward({
      deviceId: "A",
      remotePort: echo.port,
    });
    const freshEcho = await dialAndCollect(
      fresh.localPort,
      Buffer.from("fresh"),
      5,
    );
    assert.equal(freshEcho.toString("utf8"), "fresh");
    ok(
      "engine: stopForward closes the listener and live conns, and a fresh forward still works",
    );

    // (13) The client-side per-device cap, derived from the engine's
    // exported MAX_CONNS_PER_DEVICE so this scenario tracks the
    // constant: the first local socket OVER the cap is destroyed
    // immediately while the capped set stands. Mirrors the host's
    // MAX_CONNS without spending a hub round trip on the doomed dial.
    const capOpensBefore = peerA.invokeCount("forward:open");
    const capSockets = [];
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
    ok(
      `engine: local socket ${MAX_CONNS_PER_DEVICE + 1} is destroyed at the cap of ${MAX_CONNS_PER_DEVICE}`,
    );
  } finally {
    engine?.stopAll();
    // Reverse creation order via the shared tracker: the direct
    // sessions and listener first, then the hub connections, then
    // the stub and the fixture server.
    await teardown();
  }

  done();
}

main().catch(fail);
