// Durable proof for the relay transport (shared/relay/link.ts driven
// through host/relay/connection.ts). Boots a STUB Durable Object (a
// node ws server implementing relayObject.ts's envelope behavior:
// deliver forwarding, full-roster presence on join and leave, offline
// and too-large nacks, supersede on a duplicate deviceId) and drives
// TWO real relay connections against it as devices A and B.
//
// The relay is ORCHESTRATION ONLY (v2 step 10, slice C): its host role
// serves exactly the broker surface (direct:connectInfo) plus the
// intrinsic frames (hello/welcome, bye, presence), and refuses every
// other channel with the no-handler shape. There is nothing else to
// register (the binding exposes one broker slot, not a ServerTransport)
// and the client side exposes one pinned brokerInvoke (no channel
// argument), so the refusal scenario drives a raw hand-built req at
// the wire. The dispatch scenarios all ride the broker channel,
// multiplexed by an input mode. Also asserted: the sm-level
// hello/welcome over the relay, req/res id correlation, the void-field
// framing invariant, error serialization (message only), the local
// outbound size guard at the shrunken control-frame budget, offline
// nacks, presence-driven peer teardown, supervisor redial with a fresh
// ticket per attempt, the blocked verdicts for the revoked and
// superseded close codes, the ignored hello token, the per-peer
// in-flight cap surviving a hostile presence flap and a re-hello, an
// off-roster hello refused, an oversize RESPONSE downgraded to
// ok:false rather than a hang, a stale-epoch res dropped after a
// re-hello, bye tearing the host session down (epoch-guarded), stop()
// during in-flight work running no further handler, and malformed
// inbound frames dropped without killing the process.
//
// Every sm frame the relay carries is wrapped as { epoch, sm } (see the
// SESSION EPOCH note in shared/relay/link.ts), so the stub forwards that
// wrapper verbatim and the assertions read the inner frame at
// entry.frame.sm.
//
// Runs under scripts/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. See package.json "relaylink:check".
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import {
  CLOSE_DEVICE_REVOKED,
  CLOSE_SUPERSEDED,
  encodeEnvelope,
} from "@shared/relay/protocol";
import { directContract } from "@shared/ipc/modules/direct";
import {
  MAX_RELAY_IN_FLIGHT_PER_PEER,
  RelayLinkDownError,
  RelayMessageTooLargeError,
  RelayPeerOfflineError,
} from "@shared/relay/link";
import { makeProof } from "./lib/checkKit.mjs";
import {
  bootDevice as bootRelayDevice,
  delay,
  waitFor,
} from "./lib/relayBoot.mjs";
import { startStubRelay } from "./lib/relayStub.mjs";

// The one channel the relay wire serves, from the contract so the
// check tracks the link's own allowlist source.
const BROKER_CHANNEL = directContract.calls.connectInfo.channel;

// Larger than MAX_RELAY_MESSAGE_BYTES (64 KiB), for the size-guard and
// oversize-response scenarios.
const OVERSIZE = "x".repeat(70_000);

// The inner sm frame of a recorded device envelope, unwrapped from the
// epoch wrapper the relay carries.
const smOf = (entry) => entry?.frame?.sm;

// ---- The stub Durable Object ----
// Lives in scripts/lib/relayStub.mjs, shared with the direct, sync and
// forward checks.

// ---- Real relay connections ----

// Shared handler state referenced by the broker test handler. Reset by
// the tests that use it.
let hangResolvers = [];

// The broker slot is the only dispatch the link has, so every
// dispatch-mechanics scenario (echo, error, hang, oversize result)
// multiplexes through the one handler on an input mode. Registered raw
// into the slot (no schema), exactly like the old per-channel test
// handlers: the link's dispatch keys on the channel NAME alone.
async function brokerTestHandler(_ctx, raw) {
  const mode = raw !== undefined && raw !== null ? raw.mode : undefined;
  if (mode === "fail") throw new Error("boom");
  if (mode === "hang") {
    return new Promise((resolve) => hangResolvers.push(resolve));
  }
  if (mode === "big") return OVERSIZE;
  // Echo (undefined included, for the void framing scenario).
  return raw;
}

// The shared boot (scripts/lib/relayBoot.mjs) with this check's
// registerHandlers:true shorthand mapped onto the broker slot.
function bootDevice(stub, deviceId, opts = {}, track) {
  return bootRelayDevice(
    stub,
    deviceId,
    {
      ...opts,
      brokerHandler: opts.registerHandlers ? brokerTestHandler : undefined,
    },
    track,
  );
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

const { check, done, fail } = makeProof("relay-link proof");

async function main() {
  console.log("relay-link transport proof\n");

  await check(
    "hello/welcome: connectBroker completes the sm handshake and learns the peer's appVersion",
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
      const peer = await a.connection.connectBroker("B");
      assert.equal(peer.remoteDeviceId, "B");
      assert.equal(peer.remoteAppVersion, "2.2.2");
    },
  );

  await check(
    "dispatch: an invoke on the broker channel round-trips with id correlation",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      const peer = await a.connection.connectBroker("B");
      const result = await peer.brokerInvoke({ hi: 1 });
      assert.deepEqual(result, { hi: 1 });
      // The res's id matched the req's, or the invoke could not have
      // resolved with this result. Two concurrent invokes prove the
      // correlation is per id, not first-come.
      const [first, second] = await Promise.all([
        peer.brokerInvoke({ mode: "echo", n: "one" }),
        peer.brokerInvoke({ mode: "echo", n: "two" }),
      ]);
      assert.equal(first.n, "one");
      assert.equal(second.n, "two");
    },
  );

  await check(
    "broker only: any non-broker channel is refused with the no-handler shape while the broker channel is served on the same session",
    async (track) => {
      // Nothing else CAN be registered anymore (the binding exposes
      // one broker slot, not a ServerTransport) and connectBroker's
      // session has no channel argument, so the probe is a raw
      // hand-built req: exactly what a hostile or skewed peer could
      // still aim at the wire.
      const stub = await startStubRelay();
      track(() => stub.close());
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      const raw = rawDevice(stub, "C");
      track(() => raw.close());
      await raw.opened;
      raw.send({
        t: "relay",
        to: "B",
        frame: {
          epoch: 1,
          sm: { t: "hello", token: "", deviceId: "C", appVersion: "9" },
        },
      });
      const welcome = await raw.nextRelay();
      assert.equal(welcome.frame.sm.t, "welcome");
      // A data channel req on the live session: refused with the
      // no-handler shape, exactly what a channel not served on a wire
      // has always answered.
      raw.send({
        t: "relay",
        to: "B",
        frame: {
          epoch: 1,
          sm: { t: "req", id: 1, channel: "test:mutate", input: "data" },
        },
      });
      const refused = await raw.nextRelay();
      assert.equal(refused.frame.sm.ok, false);
      assert.match(refused.frame.sm.message, /No handler registered/);
      // The broker channel on the SAME session is served, so the
      // refusal above is the channel gate, not a dead session.
      raw.send({
        t: "relay",
        to: "B",
        frame: {
          epoch: 1,
          sm: { t: "req", id: 2, channel: BROKER_CHANNEL, input: "served" },
        },
      });
      const served = await raw.nextRelay();
      assert.equal(served.frame.sm.ok, true);
      assert.equal(served.frame.sm.result, "served");
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
      const peer = await a.connection.connectBroker("B");
      const result = await peer.brokerInvoke(undefined);
      assert.equal(result, undefined);
      const req = stub.received.find(
        (entry) =>
          smOf(entry)?.t === "req" && smOf(entry).channel === BROKER_CHANNEL,
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
    "error path: a throwing handler answers ok:false with the message only",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      const peer = await a.connection.connectBroker("B");
      await assert.rejects(
        () => peer.brokerInvoke({ mode: "fail" }),
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
    "size guard: an oversize outbound invoke fails typed WITHOUT hitting the wire, at the control-frame budget",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      const peer = await a.connection.connectBroker("B");
      const before = stub.receivedCount();
      await assert.rejects(
        () => peer.brokerInvoke(OVERSIZE),
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
        () => a.connection.connectBroker("ghost"),
        (error) => error instanceof RelayPeerOfflineError,
      );
    },
  );

  await check(
    "presence: a departing peer rejects its in-flight calls typed and leaves the session dead for later invokes",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      hangResolvers = [];
      const peer = await a.connection.connectBroker("B");
      const inFlight = peer.brokerInvoke({ mode: "hang" });
      await waitFor(() => hangResolvers.length === 1, "the hang dispatch");
      await b.connection.stop();
      await assert.rejects(
        () => inFlight,
        (error) => error instanceof RelayPeerOfflineError,
      );
      // There is no close callback anymore (the one real broker session
      // lives inside the dialer's try/finally, which closes it itself),
      // so the observable teardown fact is the dead session: a later
      // invoke on it rejects typed instead of hanging.
      await assert.rejects(
        () => peer.brokerInvoke({ mode: "hang" }),
        (error) => error instanceof RelayLinkDownError,
      );
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
      const peer = await a.connection.connectBroker("B");
      const result = await peer.brokerInvoke("back");
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
    "bye: a byed session answers no-live-session to its own epoch, while a stale-epoch bye cannot kill the session a fresh hello just built",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      const raw = rawDevice(stub, "C");
      track(() => raw.close());
      await raw.opened;
      const hello = (epoch) =>
        raw.send({
          t: "relay",
          to: "B",
          frame: {
            epoch,
            sm: { t: "hello", token: "", deviceId: "C", appVersion: "9" },
          },
        });
      const req = (epoch, id) =>
        raw.send({
          t: "relay",
          to: "B",
          frame: {
            epoch,
            sm: { t: "req", id, channel: BROKER_CHANNEL, input: "ping" },
          },
        });
      // Session 1 (epoch 1): served.
      hello(1);
      assert.equal((await raw.nextRelay()).frame.sm.t, "welcome");
      req(1, 1);
      const served = await raw.nextRelay();
      assert.equal(served.frame.sm.ok, true);
      // bye tears the session down at once: the SAME epoch's next req
      // gets the terminal no-live-session answer instead of dispatch.
      raw.send({ t: "relay", to: "B", frame: { epoch: 1, sm: { t: "bye" } } });
      await delay(100);
      req(1, 2);
      const refused = await raw.nextRelay();
      assert.equal(refused.frame.sm.ok, false);
      assert.match(refused.frame.sm.message, /no live session/);
      // Session 2 (epoch 2), then a LATE bye stamped with epoch 1: the
      // epoch guard must ignore it, so the fresh session still serves.
      hello(2);
      assert.equal((await raw.nextRelay()).frame.sm.t, "welcome");
      raw.send({ t: "relay", to: "B", frame: { epoch: 1, sm: { t: "bye" } } });
      await delay(100);
      req(2, 3);
      const stillServed = await raw.nextRelay();
      assert.equal(
        stillServed.frame.sm.ok,
        true,
        "a stale-epoch bye killed the fresh session",
      );
    },
  );

  await check(
    "in-flight cap: one request past the relay-local per-peer cap is refused",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      hangResolvers = [];
      const peer = await a.connection.connectBroker("B");
      const held = [];
      for (let i = 0; i < MAX_RELAY_IN_FLIGHT_PER_PEER; i += 1) {
        held.push(peer.brokerInvoke({ mode: "hang" }));
      }
      await waitFor(
        () => hangResolvers.length === MAX_RELAY_IN_FLIGHT_PER_PEER,
        "the held dispatches",
      );
      await assert.rejects(
        () => peer.brokerInvoke({ mode: "hang" }),
        /too many in-flight/,
      );
      // Release the held requests so shutdown is quick and clean.
      for (const resolve of hangResolvers) resolve("done");
      await Promise.all(held);
    },
  );

  await check(
    "in-flight cap survives a re-hello after a presence flap: neither a hostile presence drop-then-readd nor a re-connectBroker resets the per-peer cap",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const a = await bootDevice(stub, "A", {}, track);
      const b = await bootDevice(stub, "B", { registerHandlers: true }, track);
      void b;
      hangResolvers = [];
      const peer1 = await a.connection.connectBroker("B");
      const held = [];
      for (let i = 0; i < MAX_RELAY_IN_FLIGHT_PER_PEER; i += 1) {
        // The old pairing is torn down on the re-connect, rejecting these;
        // the HOST's dispatches keep running (the hang mode ignores the
        // abort signal) and hold the cap.
        held.push(peer1.brokerInvoke({ mode: "hang" }).catch(() => {}));
      }
      await waitFor(
        () => hangResolvers.length === MAX_RELAY_IN_FLIGHT_PER_PEER,
        "the held dispatches",
      );
      // A hostile relay flaps A's presence as seen by B: it forges a
      // roster that drops A (which runs dropHostSession on B, aborting the
      // still-hanging dispatches) then one that re-adds A. If dropHostSession
      // zeroed the in-flight count this would reset B's cap for A, so the
      // forged flap is the exact attack the fix defends against. The
      // hanging dispatches still count because they never settle on abort.
      stub.injectTo("B", { t: "presence", online: ["B"] });
      await delay(100);
      stub.injectTo("B", { t: "presence", online: ["A", "B"] });
      await delay(100);
      // A fresh connectBroker re-hellos with a new epoch. The host's
      // in-flight count must survive both the presence flap and the session
      // swap, so the next request is still refused rather than admitted at a
      // reset cap.
      const peer2 = await a.connection.connectBroker("B");
      await assert.rejects(
        () => peer2.brokerInvoke({ mode: "hang" }),
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
      const peer = await a.connection.connectBroker("B");
      // The handler returns a result too large for one envelope. Without
      // the downgrade the caller would hang forever (no per-call
      // timeout); it must get a normal rejection instead.
      await assert.rejects(
        () => peer.brokerInvoke({ mode: "big" }),
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
      const peer1Promise = a.connection.connectBroker("B");
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
      peer1.brokerInvoke("first").catch(() => {});
      const req1 = await rawB.nextRelay();
      const req1Id = req1.frame.sm.id;

      // Second pairing: a re-connectBroker re-hellos with a new epoch. The
      // client's req-id counter resets, so the new call reuses id 1 too.
      const peer2Promise = a.connection.connectBroker("B");
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
      const invoke2 = peer2.brokerInvoke("second");
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
      const peer = await a.connection.connectBroker("B");
      const inflight = peer
        .brokerInvoke({ mode: "hang" })
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
      const peer = await a.connection.connectBroker("B");
      const result = await peer.brokerInvoke("alive");
      assert.equal(result, "alive");
    },
  );

  done();
}

main().catch(fail);
