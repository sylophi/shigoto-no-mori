// Durable proof for the port-forward wire (v2 step 8, slice A): TCP
// bytes as chunked, grant-gated invoke responses over the REAL relay
// transport. Nothing here is a double on the forward path itself: the
// stub relay (scripts/lib/relayStub.mjs) carries two real relay
// connections, device A registers the REAL forward contract and
// handlers, and the handlers dial REAL loopback TCP fixture servers.
// Asserts:
//   - an ungranted peer is refused (typed CommandRefusedError) before
//     the handler runs, so the fixture server sees no connection.
//   - a granted echo round trip (open, send, poll, close).
//   - server-initiated bytes arrive through poll without an uplink
//     write first (the long-poll downlink).
//   - a ~1.5 MB transfer crosses chunked, byte-identical, in multiple
//     send AND poll req frames each under the relay cap.
//   - a server-side close drains buffered bytes before eof, refuses a
//     send with the coded "conn-closed", and a drained conn is gone
//     ("unknown-conn").
//   - dialing a dead port fails with the coded "connect-failed".
//   - close is idempotent, a concurrent second poll is refused
//     ("poll-in-flight"), and a poll parked across a close resolves
//     eof.
//   - the surface still serves a fresh conn after full teardown.
//
// Both "devices" share one node process. What separates them is the
// relay wire between their connections, which is exactly the surface
// this slice adds. Runs under scripts/lib/register-ts-alias.mjs. See
// package.json "forward:check".
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { CommandRefusedError } from "@shared/ipc/socket/frames";
import { buildClient } from "@shared/ipc/buildClient";
import { forwardContract } from "@shared/ipc/modules/forward";
import { registerContract } from "@shared/ipc/registerContract";
import { RELAY_CHUNK_BYTES } from "@shared/relay/protocol";
import { createRelayConnection } from "@host/relay/connection";
import { forwardHandlers } from "@host/ipc/modules/forward";
import { startStubRelay } from "./lib/relayStub.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    // oxlint-disable-next-line no-await-in-loop -- a poll is sequential by nature
    await delay(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function bootDevice(stub, deviceId, opts = {}) {
  let mints = 0;
  const connection = createRelayConnection({
    isCommandGranted: opts.isCommandGranted,
  });
  await connection.refresh(async () => ({
    relayUrl: stub.relayUrl,
    accountId: "acct",
    mintTicket: async () => {
      mints += 1;
      return `t:${deviceId}:${mints}`;
    },
    deviceId,
    appVersion: "1.0.0",
  }));
  await waitFor(
    () => connection.status().socket.phase === "connected",
    `${deviceId} to connect`,
  );
  return connection;
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

// Count the req frames for one forward channel that crossed the stub
// after `since`, the wire-level proof a transfer was chunked.
function reqFramesSince(stub, since, channel) {
  return stub.received
    .slice(since)
    .filter(
      (entry) =>
        entry.frame?.sm?.t === "req" && entry.frame.sm.channel === channel,
    ).length;
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

const passed = [];
function ok(name) {
  passed.push(name);
  console.log(`  ok  ${name}`);
}

async function main() {
  console.log("port-forward proof\n");

  const echo = await startFixtureServer((socket) => socket.pipe(socket));

  const stub = await startStubRelay();
  let granted = false;
  const a = await bootDevice(stub, "A", { isCommandGranted: () => granted });
  registerContract(forwardContract, forwardHandlers, a.server, {
    validateOutputs: true,
  });
  const b = await bootDevice(stub, "B");
  try {
    const peer = await b.connectPeer("A");
    const forward = buildClient(forwardContract, peer.transport);

    // (1) Ungranted: refused typed at the relay link's dispatch, before
    // the handler runs. The echo server never sees a dial.
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

    granted = true;

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
    // RELAY_CHUNK_BYTES slices, echoed back, polled until complete.
    // The stub's frame log proves the chunking crossed the wire as
    // multiple send AND poll reqs, each inside the relay cap.
    const big = randomBytes(1_500_000);
    const framesBefore = stub.received.length;
    const bulk = await forward.open({ port: echo.port });
    for (let offset = 0; offset < big.length; offset += RELAY_CHUNK_BYTES) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await forward.send({
        connId: bulk.connId,
        dataB64: big
          .subarray(offset, offset + RELAY_CHUNK_BYTES)
          .toString("base64"),
      });
    }
    const returned = await pollBytes(forward, bulk.connId, big.length);
    assert.ok(
      Buffer.compare(big, returned) === 0,
      "echoed bytes differ byte-for-byte",
    );
    const sendReqs = reqFramesSince(stub, framesBefore, "forward:send");
    const pollReqs = reqFramesSince(stub, framesBefore, "forward:poll");
    assert.ok(sendReqs >= 3, `expected >= 3 send frames, saw ${sendReqs}`);
    assert.ok(pollReqs >= 3, `expected >= 3 poll frames, saw ${pollReqs}`);
    await forward.close({ connId: bulk.connId });
    ok(
      "large transfer: ~1.5 MB crosses chunked in >= 3 send and >= 3 poll frames, byte-identical",
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
  } finally {
    await b.stop();
    await a.stop();
    await stub.close();
    await echo.close();
  }

  console.log(`\nport-forward proof OK (${passed.length} assertions)`);
}

main().catch((error) => {
  console.error(`\nport-forward proof FAILED: ${error?.message ?? error}`);
  process.exitCode = 1;
});
