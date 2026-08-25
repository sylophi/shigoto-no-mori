// Durable proof for the relay transport (shared/relay/link.ts driven
// through host/relay/connection.ts). Boots a STUB Durable Object (a
// node ws server implementing relayObject.ts's envelope behavior:
// deliver forwarding, full-roster presence on join and leave, offline
// and too-large nacks, supersede on a duplicate deviceId) and drives
// TWO real relay connections against it as devices A and B, with real
// handlers on B's ServerTransport half. Asserts the sm-level
// hello/welcome over the relay, req/res id correlation, the void-field
// framing invariant, broadcast gating on hello, error serialization
// (message only), the local outbound size guard, offline nacks,
// presence-driven peer teardown, supervisor redial with a fresh ticket
// per attempt, the blocked verdicts for the revoked and superseded
// close codes, the ignored hello token, the per-peer in-flight cap, and
// the hardening batch: neither a re-hello nor a hostile presence flap
// raises the in-flight cap, an
// off-roster hello is refused, an oversize RESPONSE yields ok:false
// rather than a hang, a stale-epoch res after a re-hello is dropped
// rather than mis-resolved, stop() during in-flight work runs no
// further handler, and a malformed inbound frame does not kill the
// process.
//
// Every sm frame the relay carries is wrapped as { epoch, sm } (see the
// SESSION EPOCH note in shared/relay/link.ts), so the stub forwards that
// wrapper verbatim and the assertions read the inner frame at
// entry.frame.sm.
//
// Runs under scripts/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. See package.json "relaylink:check".
import assert from "node:assert/strict";
import { WebSocket, WebSocketServer } from "ws";
import {
  CLOSE_DEVICE_REVOKED,
  CLOSE_SUPERSEDED,
  decodeEnvelope,
  DeviceEnvelopeSchema,
  encodeEnvelope,
  relayTextWithinLimit,
} from "@shared/relay/protocol";
import {
  RelayMessageTooLargeError,
  RelayPeerOfflineError,
} from "@shared/relay/link";
import { createRelayConnection } from "@host/relay/connection";

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

// The inner sm frame of a recorded device envelope, unwrapped from the
// epoch wrapper the relay carries.
const smOf = (entry) => entry?.frame?.sm;

// ---- The stub Durable Object ----

// Tickets are "t:<deviceId>:<n>". The real DO burns single-use tickets,
// but the app side never depends on that, so the stub just parses the
// deviceId out and accepts.
function deviceIdOfTicket(ticket) {
  const parts = ticket.split(":");
  return parts[0] === "t" && parts[1] ? parts[1] : null;
}

function startStubRelay() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const sockets = new Map();
    // Every device envelope the stub received, parsed, plus counters so
    // a test can assert a frame never hit the wire.
    const received = [];
    let forwarded = 0;

    function broadcastPresence() {
      const online = [...sockets.keys()].toSorted();
      const text = encodeEnvelope({ t: "presence", online });
      for (const ws of sockets.values()) {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      }
    }

    wss.on("connection", (ws, req) => {
      const url = new URL(req.url, "http://localhost");
      const deviceId = deviceIdOfTicket(url.searchParams.get("ticket") ?? "");
      if (deviceId === null) {
        ws.close(4101, "ticket rejected");
        return;
      }
      const superseded = sockets.get(deviceId);
      sockets.set(deviceId, ws);
      if (superseded) {
        superseded.close(CLOSE_SUPERSEDED, "superseded");
      }
      broadcastPresence();
      ws.on("message", (data) => {
        const envelope = decodeEnvelope(
          data.toString("utf8"),
          DeviceEnvelopeSchema,
        );
        if (envelope === null) return;
        received.push({
          from: deviceId,
          to: envelope.to,
          frame: envelope.frame,
        });
        const target = sockets.get(envelope.to);
        if (target === undefined || target.readyState !== WebSocket.OPEN) {
          ws.send(
            encodeEnvelope({ t: "nack", to: envelope.to, reason: "offline" }),
          );
          return;
        }
        const outbound = encodeEnvelope({
          t: "relay",
          from: deviceId,
          frame: envelope.frame,
        });
        if (!relayTextWithinLimit(outbound)) {
          ws.send(
            encodeEnvelope({ t: "nack", to: envelope.to, reason: "too-large" }),
          );
          return;
        }
        forwarded += 1;
        target.send(outbound);
      });
      ws.on("close", () => {
        if (sockets.get(deviceId) === ws) {
          sockets.delete(deviceId);
          broadcastPresence();
        }
      });
    });

    wss.on("listening", () => {
      const { port } = wss.address();
      resolve({
        port,
        relayUrl: `http://127.0.0.1:${port}`,
        received,
        receivedCount: () => received.length,
        forwardedCount: () => forwarded,
        // Count device->DO sends whose sender was the named device, for
        // asserting a device stayed silent (offline gate, post-stop).
        sendsFrom: (deviceId) =>
          received.filter((entry) => entry.from === deviceId).length,
        // Whether the named sender ever addressed a send to `to`.
        sentTo: (from, to) =>
          received.some((entry) => entry.from === from && entry.to === to),
        // Push an arbitrary server message (a forged deliver, or raw
        // text) straight to a connected device, the seam a hostile-relay
        // test drives.
        injectTo(deviceId, envelopeOrText) {
          const ws = sockets.get(deviceId);
          if (ws === undefined || ws.readyState !== WebSocket.OPEN) return;
          ws.send(
            typeof envelopeOrText === "string"
              ? envelopeOrText
              : encodeEnvelope(envelopeOrText),
          );
        },
        // Server-initiated close for one device's socket, the seam the
        // revoked/superseded/reconnect tests drive.
        dropSocket(deviceId, code, reason = "") {
          const ws = sockets.get(deviceId);
          if (ws) ws.close(code, reason);
        },
        close: () =>
          new Promise((done) => {
            for (const ws of sockets.values()) ws.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}

// ---- Real relay connections ----

// Shared handler state referenced by registerTestHandlers. Reset by the
// tests that use it.
let hangResolvers = [];

function registerTestHandlers(server) {
  server.handle("test:echo", async (_ctx, raw) => raw);
  server.handle("test:void", async () => undefined);
  server.handle("test:fail", async () => {
    throw new Error("boom");
  });
  server.handle(
    "test:hang",
    () => new Promise((resolve) => hangResolvers.push(resolve)),
  );
  // Returns a result too large for one relay envelope, so the size guard
  // must downgrade it to an ok:false instead of swallowing it (C8).
  server.handle("test:bigResult", async () => "x".repeat(1_100_000));
}

async function bootDevice(stub, deviceId, opts = {}, track) {
  let mints = 0;
  const connection = createRelayConnection({
    onChange: opts.onChange,
    onPeerPush: opts.onPeerPush,
  });
  // Register the connection's teardown immediately, so a boot that fails
  // its wait still gets cleaned up and cannot leak the event loop.
  if (track) track(() => connection.stop());
  if (opts.registerHandlers) registerTestHandlers(connection.server);
  await connection.refresh(async () => ({
    relayUrl: stub.relayUrl,
    accountId: opts.accountId ?? "acct",
    mintTicket: async () => {
      mints += 1;
      return `t:${deviceId}:${mints}`;
    },
    deviceId,
    appVersion: opts.appVersion ?? "1.0.0",
  }));
  await waitFor(
    () => connection.status().socket.phase === "connected",
    `${deviceId} to connect`,
  );
  return { connection, mints: () => mints };
}

// A raw stub-side device socket, for driving hand-built envelopes.
function rawDevice(stub, deviceId) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${stub.port}/connect?ticket=${encodeURIComponent(`t:${deviceId}:1`)}`,
  );
  const inbound = [];
  const waiters = [];
  ws.on("message", (data) => {
    const parsed = JSON.parse(data.toString("utf8"));
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else inbound.push(parsed);
  });
  const next = () =>
    new Promise((resolve) => {
      const first = inbound.shift();
      if (first) resolve(first);
      else waiters.push(resolve);
    });
  // The next forwarded deliver, skipping presence and nack envelopes.
  const nextRelay = async () => {
    const msg = await next();
    return msg.t === "relay" ? msg : nextRelay();
  };
  return {
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    send: (envelope) => ws.send(encodeEnvelope(envelope)),
    next,
    nextRelay,
    close: () => ws.close(),
  };
}

const passed = [];
async function check(name, fn) {
  // A cleanup stack so setup (booting a device, opening a stub) that
  // fails before the assertions still tears everything down, with no
  // event-loop leak and no one failure masking another.
  const cleanups = [];
  const track = (cleanup) => {
    cleanups.push(cleanup);
    return cleanup;
  };
  try {
    await fn(track);
  } finally {
    for (const cleanup of cleanups.toReversed()) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- cleanups run serially by design
        await cleanup();
      } catch {
        // A cleanup failure must not mask the test outcome.
      }
    }
  }
  passed.push(name);
  console.log(`  ok  ${name}`);
}

async function main() {
  console.log("relay-link transport proof\n");

  await check(
    "hello/welcome: connectPeer completes the sm handshake and learns the peer's appVersion",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(
        stub,
        "B",
        { appVersion: "2.2.2", registerHandlers: true },
        track,
      );
      void b;
      const peer = await a.connection.connectPeer("B");
      assert.equal(peer.remoteDeviceId, "B");
      assert.equal(peer.remoteAppVersion, "2.2.2");
    },
  );

  await check(
    "dispatch: an invoke on the peer's echo channel round-trips with id correlation",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      const peer = await a.connection.connectPeer("B");
      const result = await peer.transport.invoke("test:echo", { hi: 1 });
      assert.deepEqual(result, { hi: 1 });
      // The res's id matched the req's, or the invoke could not have
      // resolved with this result. Two concurrent invokes prove the
      // correlation is per id, not first-come.
      const [first, second] = await Promise.all([
        peer.transport.invoke("test:echo", "one"),
        peer.transport.invoke("test:echo", "two"),
      ]);
      assert.equal(first, "one");
      assert.equal(second, "two");
    },
  );

  await check(
    "framing: void input and void result round-trip as absent fields",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      const peer = await a.connection.connectPeer("B");
      const result = await peer.transport.invoke("test:void", undefined);
      assert.equal(result, undefined);
      const req = stub.received.find(
        (entry) =>
          smOf(entry)?.t === "req" && smOf(entry).channel === "test:void",
      );
      assert.ok(req, "the void req never reached the stub");
      assert.equal("input" in req.frame.sm, false);
      const res = stub.received.find(
        (entry) =>
          entry.from === "B" &&
          smOf(entry)?.t === "res" &&
          smOf(entry).id === req.frame.sm.id,
      );
      assert.ok(res, "the void res never reached the stub");
      assert.equal("result" in res.frame.sm, false);
    },
  );

  await check(
    "broadcast: broadcastAll reaches a helloed peer as a push, and only after the hello",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      // Nobody has helloed B yet, so a broadcast goes nowhere and no
      // envelope leaves B at all.
      const before = stub.receivedCount();
      b.connection.server.broadcastAll("test:ping", { n: 1 });
      await delay(150);
      assert.equal(
        stub.receivedCount(),
        before,
        "a broadcast was sent with no helloed peers",
      );
      const peer = await a.connection.connectPeer("B");
      const pushed = new Promise((resolve) => {
        peer.transport.subscribe("test:ping", resolve);
      });
      b.connection.server.broadcastAll("test:ping", { n: 5 });
      assert.deepEqual(await pushed, { n: 5 });
    },
  );

  await check(
    "error path: a throwing handler answers ok:false with the message only",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      const peer = await a.connection.connectPeer("B");
      await assert.rejects(
        () => peer.transport.invoke("test:fail", undefined),
        (error) => error instanceof Error && error.message === "boom",
      );
      const res = stub.received.find(
        (entry) =>
          entry.from === "B" &&
          smOf(entry)?.t === "res" &&
          smOf(entry).ok === false &&
          smOf(entry).message === "boom",
      );
      assert.ok(res, "the err res never reached the stub");
      // The inner sm frame carries only the message form, no result.
      assert.deepEqual(Object.keys(res.frame.sm).toSorted(), [
        "id",
        "message",
        "ok",
        "t",
      ]);
    },
  );

  await check(
    "size guard: an oversize outbound invoke fails typed WITHOUT hitting the wire",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      const peer = await a.connection.connectPeer("B");
      const before = stub.receivedCount();
      await assert.rejects(
        () => peer.transport.invoke("test:echo", "x".repeat(1_100_000)),
        (error) => error instanceof RelayMessageTooLargeError,
      );
      assert.equal(
        stub.receivedCount(),
        before,
        "the oversize frame reached the stub",
      );
    },
  );

  await check(
    "offline nack: connecting to a deviceId with no socket rejects with the offline error",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      await assert.rejects(
        () => a.connection.connectPeer("ghost"),
        (error) => error instanceof RelayPeerOfflineError,
      );
    },
  );

  await check(
    "presence: a departing peer fires the close path and rejects its in-flight calls",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      hangResolvers = [];
      let closed = false;
      const peer = await a.connection.connectPeer("B", {
        onClose: () => {
          closed = true;
        },
      });
      const inFlight = peer.transport.invoke("test:hang", undefined);
      await waitFor(() => hangResolvers.length === 1, "the hang dispatch");
      await b.connection.stop();
      await assert.rejects(
        () => inFlight,
        (error) => error instanceof RelayPeerOfflineError,
      );
      await waitFor(() => closed, "the peer close callback");
    },
  );

  await check(
    "reconnect: a dropped socket redials with a fresh ticket and serves again",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      assert.equal(a.mints(), 1);
      stub.dropSocket("A", 1001, "going away");
      await waitFor(
        () => a.connection.status().socket.phase === "backoff",
        "the backoff phase",
      );
      // The first backoff rung is 1s, so the redial (with its fresh
      // ticket mint) lands shortly after.
      await waitFor(
        () => a.connection.status().socket.phase === "connected",
        "the redial",
      );
      assert.equal(a.mints(), 2, "the redial did not mint a fresh ticket");
      const peer = await a.connection.connectPeer("B");
      const result = await peer.transport.invoke("test:echo", "back");
      assert.equal(result, "back");
    },
  );

  await check(
    "blocked: 4102 revoked blocks with no redial, 4103 superseded blocks with its own message",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      stub.dropSocket("A", CLOSE_DEVICE_REVOKED, "device revoked");
      await waitFor(
        () => a.connection.status().socket.phase === "blocked",
        "the blocked phase",
      );
      const minted = a.mints();
      // Longer than the first backoff rung: a redial would have minted
      // by now.
      await delay(1_300);
      assert.equal(a.connection.status().socket.phase, "blocked");
      assert.equal(a.mints(), minted, "a blocked supervisor redialed");
      assert.match(a.connection.status().socket.message, /revoked/);
      // A fresh device for the superseded arm, booted inside the tracked
      // scope so a failure here still closes the stub.
      const c = await bootDevice(stub, "C", {}, track);
      stub.dropSocket("C", CLOSE_SUPERSEDED, "superseded");
      await waitFor(
        () => c.connection.status().socket.phase === "blocked",
        "the superseded block",
      );
      assert.match(c.connection.status().socket.message, /another instance/);
    },
  );

  await check(
    "token ignored: a hello carrying a garbage token still gets a welcome",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const b = await bootDevice(
        stub,
        "B",
        { appVersion: "3.3.3", registerHandlers: true },
        track,
      );
      void b;
      const raw = rawDevice(stub, "C");
      track(() => raw.close());
      await raw.opened;
      // First inbound message is the presence roster.
      const presence = await raw.next();
      assert.equal(presence.t, "presence");
      raw.send({
        t: "relay",
        to: "B",
        frame: {
          epoch: 1,
          sm: {
            t: "hello",
            token: "garbage",
            deviceId: "C",
            appVersion: "9",
          },
        },
      });
      const deliver = await raw.nextRelay();
      assert.equal(deliver.from, "B");
      assert.equal(
        deliver.frame.epoch,
        1,
        "the welcome did not echo the epoch",
      );
      assert.equal(deliver.frame.sm.t, "welcome");
      assert.equal(deliver.frame.sm.appVersion, "3.3.3");
    },
  );

  await check(
    "in-flight cap: the 33rd concurrent request to one peer is refused",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      hangResolvers = [];
      const peer = await a.connection.connectPeer("B");
      const held = [];
      for (let i = 0; i < 32; i += 1) {
        held.push(peer.transport.invoke("test:hang", undefined));
      }
      await waitFor(() => hangResolvers.length === 32, "the held dispatches");
      await assert.rejects(
        () => peer.transport.invoke("test:hang", undefined),
        /too many in-flight/,
      );
      // Release the held requests so shutdown is quick and clean.
      for (const resolve of hangResolvers) resolve("done");
      await Promise.all(held);
    },
  );

  await check(
    "in-flight cap survives a re-hello after a presence flap: neither a hostile presence drop-then-readd nor a re-connectPeer resets the per-peer cap",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      hangResolvers = [];
      const peer1 = await a.connection.connectPeer("B");
      const held = [];
      for (let i = 0; i < 32; i += 1) {
        // The old pairing is torn down on the re-connect, rejecting these;
        // the HOST's dispatches keep running (test:hang ignores the abort
        // signal) and hold the cap.
        held.push(
          peer1.transport.invoke("test:hang", undefined).catch(() => {}),
        );
      }
      await waitFor(() => hangResolvers.length === 32, "the held dispatches");
      // A hostile relay flaps A's presence as seen by B: it forges a
      // roster that drops A (which runs dropHostSession on B, aborting the
      // still-hanging dispatches) then one that re-adds A. If dropHostSession
      // zeroed the in-flight count this would reset B's cap for A, so the
      // forged flap is the exact attack the fix defends against. The 32
      // hanging dispatches still count because they never settle on abort.
      stub.injectTo("B", { t: "presence", online: ["B"] });
      await delay(100);
      stub.injectTo("B", { t: "presence", online: ["A", "B"] });
      await delay(100);
      // A fresh connectPeer re-hellos with a new epoch. The host's
      // in-flight count must survive both the presence flap and the session
      // swap, so the next request is still refused rather than admitted at a
      // reset cap.
      const peer2 = await a.connection.connectPeer("B");
      await assert.rejects(
        () => peer2.transport.invoke("test:hang", undefined),
        /too many in-flight/,
      );
      for (const resolve of hangResolvers) resolve("done");
      await Promise.all(held);
    },
  );

  await check(
    "off-roster hello: a hello whose from is not in the presence roster is refused",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      // Forge a deliver to B from a device that is not in B's roster (a
      // hostile relay can set any `from`). B must not allocate a session
      // or answer a welcome for it.
      stub.injectTo("B", {
        t: "relay",
        from: "ghost",
        frame: {
          epoch: 1,
          sm: { t: "hello", token: "", deviceId: "ghost", appVersion: "9" },
        },
      });
      await delay(200);
      assert.equal(
        stub.sentTo("B", "ghost"),
        false,
        "B answered an off-roster hello",
      );
    },
  );

  await check(
    "oversize response: an oversize handler result yields ok:false, not a hang",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      const peer = await a.connection.connectPeer("B");
      // The handler returns a result too large for one envelope. Without
      // the downgrade the caller would hang forever (no per-call
      // timeout); it must get a normal rejection instead.
      await assert.rejects(
        () => peer.transport.invoke("test:bigResult", undefined),
        (error) => error instanceof Error && /too large/.test(error.message),
      );
    },
  );

  await check(
    "stale epoch: a res from a prior pairing is dropped after a re-hello, not mis-resolved",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      // B is a hand-driven host so the test controls exactly which epoch
      // each res carries.
      const rawB = rawDevice(stub, "B");
      track(() => rawB.close());
      await rawB.opened;

      // First pairing: A dials B (epoch E1), rawB welcomes it.
      const peer1Promise = a.connection.connectPeer("B");
      const hello1 = await rawB.nextRelay();
      const epoch1 = hello1.frame.epoch;
      assert.equal(hello1.frame.sm.t, "hello");
      rawB.send({
        t: "relay",
        to: "A",
        frame: {
          epoch: epoch1,
          sm: { t: "welcome", deviceId: "B", appVersion: "9" },
        },
      });
      const peer1 = await peer1Promise;
      // A req on the first pairing that rawB never answers.
      peer1.transport.invoke("test:echo", "first").catch(() => {});
      const req1 = await rawB.nextRelay();
      const req1Id = req1.frame.sm.id;

      // Second pairing: a re-connectPeer re-hellos with a new epoch. The
      // client's req-id counter resets, so the new call reuses id 1 too.
      const peer2Promise = a.connection.connectPeer("B");
      const hello2 = await rawB.nextRelay();
      const epoch2 = hello2.frame.epoch;
      assert.notEqual(epoch2, epoch1, "the re-hello reused the old epoch");
      rawB.send({
        t: "relay",
        to: "A",
        frame: {
          epoch: epoch2,
          sm: { t: "welcome", deviceId: "B", appVersion: "9" },
        },
      });
      const peer2 = await peer2Promise;
      const invoke2 = peer2.transport.invoke("test:echo", "second");
      const req2 = await rawB.nextRelay();
      const req2Id = req2.frame.sm.id;

      // A STALE res from the first pairing (old epoch, same id) must be
      // dropped, not matched against the fresh call.
      rawB.send({
        t: "relay",
        to: "A",
        frame: {
          epoch: epoch1,
          sm: { t: "res", id: req2Id, ok: true, result: "stale" },
        },
      });
      await delay(100);
      // The correct res resolves the fresh call.
      rawB.send({
        t: "relay",
        to: "A",
        frame: {
          epoch: epoch2,
          sm: { t: "res", id: req2Id, ok: true, result: "fresh" },
        },
      });
      const result = await invoke2;
      assert.equal(result, "fresh", "a stale-epoch res was mis-resolved");
      assert.equal(req1Id, req2Id, "the req-id counter did not reset");
    },
  );

  await check(
    "stop during in-flight: a handler that finishes after stop runs no answer into a dead socket",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      hangResolvers = [];
      const peer = await a.connection.connectPeer("B");
      const inflight = peer.transport
        .invoke("test:hang", undefined)
        .then(() => "resolved")
        .catch(() => "rejected");
      await waitFor(() => hangResolvers.length === 1, "the hang dispatch");
      const sendsBefore = stub.sendsFrom("B");
      // Stop B while its handler still runs. Teardown is synchronous, so
      // the completing handler must not answer into the dead socket.
      await b.connection.stop();
      for (const resolve of hangResolvers) resolve("late");
      await delay(200);
      assert.equal(stub.sendsFrom("B"), sendsBefore, "B answered after stop");
      assert.equal(
        await inflight,
        "rejected",
        "the caller was not disconnected",
      );
    },
  );

  await check(
    "malformed inbound: garbage frames are dropped without killing the process",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      // Non-JSON text, an unparseable envelope, and a valid envelope with
      // an unparseable inner frame. All must be dropped, not fatal.
      stub.injectTo("A", "this is not json at all");
      stub.injectTo("A", { t: "totally-unknown" });
      stub.injectTo("A", {
        t: "relay",
        from: "B",
        frame: { epoch: 1, sm: { t: "bogus" } },
      });
      await delay(150);
      // The link is still live: a real dial and invoke still work.
      const peer = await a.connection.connectPeer("B");
      const result = await peer.transport.invoke("test:echo", "alive");
      assert.equal(result, "alive");
    },
  );

  console.log(`\nrelay-link proof OK (${passed.length} assertions)`);
}

main().catch((error) => {
  console.error(`\nrelay-link proof FAILED: ${error?.message ?? error}`);
  process.exitCode = 1;
});
