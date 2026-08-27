// Durable proof for the direct data plane (v2 step 10, slice A): the
// relay becomes control plane and data flows over DIRECT websockets
// between devices, brokered by short-lived single-use connect tickets.
//
// Boots the stub Durable Object (scripts/lib/relayStub.mjs) with two
// REAL relay connections (A the dialing client, B the host) plus a
// REAL ticket-mode ws listener instance (host/socket/server.ts with a
// WsServerTicketAuth) on an ephemeral loopback port, and drives the
// real broker (direct:connectInfo through the shared registrar), the
// real dialer (shared/relay/directDial.ts) and the real bridge routing
// (shared/relay/bridgeHandlers.ts). Asserts:
//
//   - connectInfo over the relay answers available:true with one
//     smpt_ ticket PER candidate address, the bound port and the
//     candidates while the listener is up, available:false when it is
//     not, available:false without an authenticated callerDeviceId,
//     and available:false for a caller outside the live roster.
//   - a direct dial completes the handshake, pins the welcome
//     identity, and invokes flow over the direct socket while the stub
//     relay's forwardedCount stays flat (the whole point).
//   - tickets are single use, expire, are bound to the peer they were
//     minted for, and are bookkept PER PEER: one peer's mint replaces
//     only its own pending set, and the global backstop refuses
//     instead of evicting another peer's tickets.
//   - the direct wire's grant gate: mutating channels refused with the
//     typed code pre-grant, served post-grant, revoked live without a
//     reconnect, and ctx.callerDeviceId carries the authed peer.
//   - a superseded socket is KILLED: nothing it delivers after the
//     supersede executes a handler.
//   - the dialer races candidates concurrently under ONE overall
//     deadline: a junk candidate cannot defeat a reachable one, a
//     wedged connectInfo cannot hang the bridge cache, and a blocked
//     verdict is terminal for the whole attempt.
//   - a client peer's close sends bye, so the host stops fanning
//     broadcasts at the departed peer through the relay.
//   - presence scopes the data plane: a peer leaving a LIVE roster
//     loses its direct sessions host-side and client-side, while our
//     own relay link going down leaves them alone.
//   - openPeer routes direct-first with relay fallback, reports direct
//     sessions via directPeerIds, drops the cache when the direct
//     socket closes, and re-establishes on the next invoke.
//   - pushes from the host reach a direct-connected client through the
//     same peerPush path the relay feeds.
//
// The legacy LAN listener's unchanged behavior is pinned by
// scripts/check-socket-host.mjs, which the battery runs alongside.
//
// Runs under scripts/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. See package.json "direct:check".
import assert from "node:assert/strict";
import {
  CLOSE_AUTH_FAILED,
  CommandRefusedError,
} from "@shared/ipc/socket/frames";
import {
  connectDevice,
  RemoteConnectError,
} from "@shared/ipc/socket/wsClientTransport";
import { registerContract } from "@shared/ipc/registerContract";
import { directContract } from "@shared/ipc/modules/direct";
import { createDirectDialer } from "@shared/relay/directDial";
import { applyDirectPresence } from "@shared/relay/directPresence";
import { makeRelayHandlers } from "@shared/relay/bridgeHandlers";
import { createWsServerBinding } from "@host/socket/server";
import {
  createConnectTicketStore,
  DIRECT_TICKET_PREFIX,
} from "@host/direct/tickets";
import { makeDirectHandlers } from "@host/ipc/modules/direct";
import { makeProof } from "./lib/checkKit.mjs";
import { bootDevice, delay, waitFor } from "./lib/relayBoot.mjs";
import { startStubRelay } from "./lib/relayStub.mjs";

// A blackholed candidate (TEST-NET-3, never routed): a dial to it
// hangs or dies on its own, never reaching any listener.
const BLACKHOLE = "203.0.113.1";

// A REAL ticket-mode listener for device "B" on an ephemeral loopback
// port, with its ticket store, a toggleable grant set, and data-plane
// test handlers. Handler counters prove refusals never ran a body.
async function startDirectListener(track, opts = {}) {
  const tickets = createConnectTicketStore(opts.ticketOpts);
  const granted = new Set();
  let mutateRuns = 0;
  const binding = createWsServerBinding({
    verifyTicket: (ticket, deviceId) => tickets.consume(ticket, deviceId),
    isCommandGranted: (peerDeviceId) => granted.has(peerDeviceId),
  });
  binding.handle("test:echo", async (_ctx, raw) => raw, { mutating: false });
  binding.handle("test:whoami", async (ctx) => ctx.callerDeviceId ?? "none", {
    mutating: false,
  });
  binding.handle(
    "test:mutate",
    async () => {
      mutateRuns += 1;
      return "mutated";
    },
    { mutating: true },
  );
  const port = await binding.start({
    port: 0,
    bindAddress: "127.0.0.1",
    // Ticket mode has no static token, the injected verifier is the
    // auth.
    token: "",
    deviceId: opts.deviceId ?? "B",
    appVersion: "2.0.0",
    helloTimeoutMs: 1000,
  });
  track(() => binding.stop());
  return {
    binding,
    tickets,
    granted,
    port,
    mutateRuns: () => mutateRuns,
    listenerPort: () => {
      const status = binding.status();
      return status.listening ? status.port : null;
    },
  };
}

// Boots the relay pair: B registers the REAL direct broker through the
// shared registrar (plus a relay-side echo for the fallback path), A
// is the dialing client.
async function bootPair(stub, track, listener, opts = {}) {
  const host = await bootDevice(
    stub,
    "B",
    {
      registerHandlers: (server) => {
        registerContract(
          directContract,
          makeDirectHandlers({
            listenerPort: listener.listenerPort,
            mintTickets: (peerDeviceId, count) =>
              listener.tickets.mint(peerDeviceId, count),
            isPeerOnline: opts.isPeerOnline ?? (() => true),
            // Deterministic candidates: the listener binds loopback,
            // so real interface enumeration would offer unreachable
            // LAN addresses.
            candidateAddresses:
              opts.candidateAddresses ?? (() => ["127.0.0.1"]),
          }),
          server,
          { validateOutputs: true },
        );
        server.handle("test:echo", async (_ctx, raw) => raw, {
          mutating: false,
        });
      },
    },
    track,
  );
  const client = await bootDevice(stub, "A", opts.clientOpts ?? {}, track);
  return { host, client };
}

// One direct dial against the listener under test. The defaults are
// the happy path (A dialing B with the identity pin), and each caller
// overrides only what its scenario varies.
function dialWith(port, ticket, overrides = {}) {
  return connectDevice({
    url: `ws://127.0.0.1:${port}`,
    token: ticket,
    appVersion: "1.0.0",
    localDeviceId: "A",
    expectedDeviceId: "B",
    onClose: () => {},
    helloTimeoutMs: 800,
    ...overrides,
  });
}

function dialerFor(client, opts = {}) {
  return createDirectDialer({
    connectRelayPeer: (deviceId) => client.connection.connectPeer(deviceId),
    localDeviceId: "A",
    localAppVersion: "1.0.0",
    onAnyPush: opts.onAnyPush,
    deadlineMs: opts.deadlineMs ?? 3000,
  }).connectDirect;
}

const { check, done, fail } = makeProof("direct-plane proof");

async function main() {
  console.log("direct data plane proof\n");

  await check(
    "brokering: connectInfo over the relay carries one ticket per candidate, the port and the addresses while the listener is up, and available:false when it is down",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const listener = await startDirectListener(track);
      const { client } = await bootPair(stub, track, listener, {
        candidateAddresses: () => ["127.0.0.1", "192.0.2.9"],
      });
      const peer = await client.connection.connectPeer("B");
      const info = await peer.transport.invoke("direct:connectInfo", undefined);
      assert.equal(info.available, true);
      assert.equal(info.port, listener.port);
      assert.deepEqual(info.addresses, ["127.0.0.1", "192.0.2.9"]);
      assert.equal(
        info.tickets.length,
        info.addresses.length,
        "not one ticket per candidate",
      );
      for (const ticket of info.tickets) {
        assert.ok(
          typeof ticket === "string" && ticket.startsWith(DIRECT_TICKET_PREFIX),
          "a ticket does not carry the smpt_ prefix",
        );
      }
      assert.equal(new Set(info.tickets).size, info.tickets.length);
      // Listener down: the broker answers unavailable, never a stale
      // port.
      await listener.binding.stop();
      const down = await peer.transport.invoke("direct:connectInfo", undefined);
      assert.deepEqual(down, { available: false });
    },
  );

  await check(
    "brokering fails closed: no authenticated callerDeviceId, or a caller outside the live roster, means available:false and no ticket is minted",
    async () => {
      let minted = 0;
      let online = false;
      const handlers = makeDirectHandlers({
        listenerPort: () => 42017,
        mintTickets: (_peer, count) => {
          minted += count;
          return Array.from({ length: count }, (_, i) => `smpt_${i}`);
        },
        isPeerOnline: () => online,
        candidateAddresses: () => ["127.0.0.1"],
      });
      // The context a non-peer wire supplies: no callerDeviceId (the
      // Electron wire, the legacy LAN socket and loopbacks never set
      // one).
      const anonymous = {
        signal: new AbortController().signal,
        notifier: () => () => {},
      };
      assert.deepEqual(handlers.connectInfo(undefined, anonymous), {
        available: false,
      });
      // An authenticated caller that fell off the control plane (a
      // revoked device minting over its still-open direct socket) is
      // refused too: presence scopes the data plane.
      const authed = { ...anonymous, callerDeviceId: "A" };
      assert.deepEqual(handlers.connectInfo(undefined, authed), {
        available: false,
      });
      assert.equal(minted, 0, "a ticket was minted for a refused caller");
      online = true;
      assert.equal(handlers.connectInfo(undefined, authed).available, true);
      assert.equal(minted, 1);
    },
  );

  await check(
    "direct dial: the handshake completes with the pinned identity and invokes flow while the relay's forwardedCount stays flat",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const listener = await startDirectListener(track);
      const { client } = await bootPair(stub, track, listener);
      const dial = dialerFor(client);
      const connection = await dial("B");
      track(() => connection.close());
      assert.equal(connection.remoteDeviceId, "B");
      assert.equal(connection.remoteAppVersion, "2.0.0");
      // The direct wire carries the authed caller identity to
      // handlers.
      assert.equal(
        await connection.transport.invoke("test:whoami", undefined),
        "A",
      );
      const baseline = stub.forwardedCount();
      for (let i = 0; i < 5; i += 1) {
        // oxlint-disable-next-line no-await-in-loop -- sequential invokes measure the relay stays flat
        const result = await connection.transport.invoke("test:echo", { i });
        assert.deepEqual(result, { i });
      }
      assert.equal(
        stub.forwardedCount(),
        baseline,
        "direct invokes still rode the relay",
      );
    },
  );

  await check(
    "concurrent race: a junk candidate enumerating first no longer defeats a reachable one, and per-candidate tickets keep every candidate authable",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const listener = await startDirectListener(track);
      // The junk candidate FIRST, exactly the ordering that made the
      // sequential walk fail deterministically on multi-interface
      // machines. Both candidates dial at once, so the reachable one
      // wins without waiting out the blackhole.
      const { client } = await bootPair(stub, track, listener, {
        candidateAddresses: () => [BLACKHOLE, "127.0.0.1"],
      });
      const dial = dialerFor(client, { deadlineMs: 4000 });
      const startedAt = Date.now();
      const connection = await dial("B");
      track(() => connection.close());
      const elapsed = Date.now() - startedAt;
      assert.ok(
        elapsed < 2000,
        `the reachable candidate waited on the junk one (${elapsed}ms)`,
      );
      assert.equal(
        await connection.transport.invoke("test:echo", "raced"),
        "raced",
      );
    },
  );

  await check(
    "blocked verdict is terminal: an auth-refused candidate rejects the whole attempt instead of waiting out the remaining candidates",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      // The advertised port belongs to a DIFFERENT device's listener
      // with its own ticket store, so the loopback candidate fails
      // auth (blocked). The blackhole candidate would otherwise hold
      // the race until the deadline.
      const wrongListener = await startDirectListener(track, {
        deviceId: "X",
      });
      const brokerListener = {
        tickets: createConnectTicketStore(),
        listenerPort: () => wrongListener.port,
      };
      const { client } = await bootPair(stub, track, brokerListener, {
        candidateAddresses: () => ["127.0.0.1", BLACKHOLE],
      });
      const dial = dialerFor(client, { deadlineMs: 5000 });
      const startedAt = Date.now();
      await assert.rejects(
        () => dial("B"),
        (error) =>
          error instanceof RemoteConnectError &&
          error.blocked &&
          error.code === CLOSE_AUTH_FAILED,
        "an auth-refused candidate did not reject the attempt as blocked",
      );
      const elapsed = Date.now() - startedAt;
      assert.ok(
        elapsed < 2500,
        `the blocked verdict waited on the blackhole candidate (${elapsed}ms)`,
      );
    },
  );

  await check(
    "deadline: a wedged connectInfo cannot hang the bridge cache, which settles, falls back to the relay and still serves the invoke",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      // B serves a connectInfo that NEVER answers (a wedged peer), and
      // the relay-side echo the fallback lands on.
      const host = await bootDevice(
        stub,
        "B",
        {
          registerHandlers: (server) => {
            server.handle("direct:connectInfo", () => new Promise(() => {}), {
              mutating: false,
            });
            server.handle("test:echo", async (_ctx, raw) => raw, {
              mutating: false,
            });
          },
        },
        track,
      );
      const client = await bootDevice(stub, "A", {}, track);
      const bridge = makeRelayHandlers({
        status: () => client.connection.status(),
        connectPeer: (deviceId, opts) =>
          client.connection.connectPeer(deviceId, opts),
        connectDirect: dialerFor(client, { deadlineMs: 400 }),
      });
      const startedAt = Date.now();
      assert.deepEqual(
        await bridge.invokePeer({
          deviceId: "B",
          channel: "test:echo",
          input: "hung broker",
        }),
        "hung broker",
      );
      const elapsed = Date.now() - startedAt;
      assert.ok(
        elapsed < 3000,
        `the wedged connectInfo was not bounded by the deadline (${elapsed}ms)`,
      );
      assert.deepEqual(bridge.directPeerIds(), []);
      // The cached promise settled on the relay session: the next
      // invoke reuses it without a new dial.
      assert.deepEqual(
        await bridge.invokePeer({
          deviceId: "B",
          channel: "test:echo",
          input: "cached",
        }),
        "cached",
      );
      void host;
    },
  );

  await check(
    "ticket single-use and expiry: a replayed ticket and an expired ticket are refused with the auth-failure code",
    async (track) => {
      const listener = await startDirectListener(track, {
        ticketOpts: { ttlMs: 80 },
      });
      const [ticket] = listener.tickets.mint("A", 1);
      const first = await dialWith(listener.port, ticket);
      first.close();
      // Replay: the ticket was consumed on first presentation.
      await assert.rejects(
        () => dialWith(listener.port, ticket),
        (error) =>
          error instanceof RemoteConnectError &&
          error.code === CLOSE_AUTH_FAILED &&
          error.blocked,
        "a replayed ticket authenticated",
      );
      // Expiry: a fresh ticket past its TTL is refused too.
      const [stale] = listener.tickets.mint("A", 1);
      await delay(150);
      await assert.rejects(
        () => dialWith(listener.port, stale),
        (error) =>
          error instanceof RemoteConnectError &&
          error.code === CLOSE_AUTH_FAILED,
        "an expired ticket authenticated",
      );
    },
  );

  await check(
    "per-peer ticket bookkeeping: one peer's mint replaces only its own set, siblings in a set stay independently consumable, and the backstop refuses instead of evicting",
    async () => {
      const store = createConnectTicketStore();
      // Siblings of one candidate-set are independent: consuming one
      // must not spend the others (the old single-ticket design burned
      // the whole dial on the first candidate that reached the host).
      const a = store.mint("A", 3);
      assert.equal(a.length, 3);
      assert.equal(store.consume(a[0], "A"), true);
      assert.equal(store.consume(a[1], "A"), true);
      // Another peer's mint leaves A's remaining ticket alone.
      const b = store.mint("B", 2);
      assert.equal(store.consume(a[2], "A"), true);
      assert.equal(store.consume(b[0], "B"), true);
      // A's own re-mint REPLACES its previous set: only the freshest
      // dial holds live tickets.
      const a1 = store.mint("A", 2);
      const a2 = store.mint("A", 2);
      assert.equal(
        store.consume(a1[0], "A"),
        false,
        "a replaced ticket authed",
      );
      assert.equal(store.consume(a2[0], "A"), true);
      // The global backstop refuses the overflowing mint outright and
      // never evicts another peer's pending tickets (an eviction would
      // feed the per-IP lockout against the innocent peer's dial).
      const keeper = store.mint("keeper", 2);
      for (let i = 0; i < 200; i += 1) store.mint(`peer-${i}`, 1);
      assert.equal(store.mint("overflow", 60), null);
      assert.equal(store.consume(keeper[0], "keeper"), true);
    },
  );

  await check(
    "identity binding: a ticket minted for one device refuses another, and a wrong expected welcome identity fails the handshake",
    async (track) => {
      const listener = await startDirectListener(track);
      // The ticket is bound to A, the hello claims C. No identity pin:
      // the refusal under test is the listener's, not the client's.
      const [wrongPeer] = listener.tickets.mint("A", 1);
      await assert.rejects(
        () =>
          dialWith(listener.port, wrongPeer, {
            localDeviceId: "C",
            expectedDeviceId: undefined,
          }),
        (error) =>
          error instanceof RemoteConnectError &&
          error.code === CLOSE_AUTH_FAILED,
        "a ticket bound to another device authenticated",
      );
      // The welcome names B. A dial pinned to another identity must
      // fail and close rather than cache the wrong machine.
      const [ticket] = listener.tickets.mint("A", 1);
      await assert.rejects(
        () => dialWith(listener.port, ticket, { expectedDeviceId: "X" }),
        (error) =>
          error instanceof RemoteConnectError &&
          error.blocked &&
          /unexpected device/.test(error.message),
        "a welcome from the wrong device passed the identity pin",
      );
    },
  );

  await check(
    "grant gate on the direct wire: mutating refused with the typed error pre-grant and the handler never runs, served post-grant, revoked live on the same socket",
    async (track) => {
      const listener = await startDirectListener(track);
      const connection = await dialWith(
        listener.port,
        listener.tickets.mint("A", 1)[0],
      );
      track(() => connection.close());
      await assert.rejects(
        () => connection.transport.invoke("test:mutate", undefined),
        (error) =>
          error instanceof CommandRefusedError &&
          /not permitted to run commands/.test(error.message),
        "an ungranted mutating call was not refused with the typed error",
      );
      assert.equal(
        listener.mutateRuns(),
        0,
        "a mutating handler ran for an ungranted peer",
      );
      // Reads are served pre-grant on this wire, like the relay.
      assert.equal(
        await connection.transport.invoke("test:echo", "read"),
        "read",
      );
      // Grant: the SAME socket serves the mutation, no reconnect.
      listener.granted.add("A");
      assert.equal(
        await connection.transport.invoke("test:mutate", undefined),
        "mutated",
      );
      assert.equal(listener.mutateRuns(), 1);
      // Revoke: takes effect live at the next dispatch.
      listener.granted.delete("A");
      await assert.rejects(
        () => connection.transport.invoke("test:mutate", undefined),
        (error) => error instanceof CommandRefusedError,
        "a revoke did not take effect without a reconnect",
      );
      assert.equal(listener.mutateRuns(), 1);
    },
  );

  await check(
    "supersede kills the old socket dead: nothing it delivers after the supersede executes a handler",
    async (track) => {
      const listener = await startDirectListener(track);
      listener.granted.add("A");
      const first = await dialWith(
        listener.port,
        listener.tickets.mint("A", 1)[0],
      );
      assert.equal(
        await first.transport.invoke("test:mutate", undefined),
        "mutated",
      );
      assert.equal(listener.mutateRuns(), 1);
      // The same device dials again: the old socket is superseded AND
      // killed (dead flag set, signal aborted), so a mutating req it
      // delivers during the close grace window must execute nothing --
      // without the kill it would run twice.
      const second = await dialWith(
        listener.port,
        listener.tickets.mint("A", 1)[0],
      );
      track(() => second.close());
      await assert.rejects(
        () => first.transport.invoke("test:mutate", undefined),
        undefined,
        "an invoke on the superseded socket resolved",
      );
      // Let any frame that raced the close drain before counting.
      await delay(120);
      assert.equal(
        listener.mutateRuns(),
        1,
        "the superseded socket still executed a mutating handler",
      );
      assert.equal(
        await second.transport.invoke("test:mutate", undefined),
        "mutated",
      );
      assert.equal(listener.mutateRuns(), 2);
    },
  );

  await check(
    "bye: a closed client peer's host session dies at once, so host broadcasts stop riding the relay to the departed peer",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const host = await bootDevice(
        stub,
        "B",
        {
          registerHandlers: (server) => {
            server.handle("test:echo", async (_ctx, raw) => raw, {
              mutating: false,
            });
          },
        },
        track,
      );
      const client = await bootDevice(stub, "A", {}, track);
      const peer = await client.connection.connectPeer("B");
      // Control: with the session live, a host broadcast is forwarded
      // to A through the stub relay.
      const before = stub.forwardedCount();
      host.connection.server.broadcastAll("test:ping", { n: 1 });
      await waitFor(
        () => stub.forwardedCount() > before,
        "the pre-close broadcast to ride the relay",
      );
      // Close the client peer: the bye tears the host session down, so
      // later broadcasts have nobody to ride to.
      peer.close();
      await delay(150);
      const baseline = stub.forwardedCount();
      host.connection.server.broadcastAll("test:ping", { n: 2 });
      host.connection.server.broadcastAll("test:ping", { n: 3 });
      await delay(150);
      assert.equal(
        stub.forwardedCount(),
        baseline,
        "the host kept fanning broadcasts at a closed client peer",
      );
    },
  );

  await check(
    "presence scopes the data plane: a peer leaving a LIVE roster loses its direct sessions on both sides, and our own relay link going down leaves them alone",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const listener = await startDirectListener(track);
      const { client } = await bootPair(stub, track, listener);
      const bridge = makeRelayHandlers({
        status: () => client.connection.status(),
        connectPeer: (deviceId, opts) =>
          client.connection.connectPeer(deviceId, opts),
        connectDirect: dialerFor(client),
      });
      const presenceDeps = {
        closeHostPeersNotIn: (online) =>
          listener.binding.closePeersNotIn(online),
        dropClientPeersNotIn: (online) => bridge.dropDirectPeersNotIn(online),
      };
      assert.deepEqual(
        await bridge.invokePeer({
          deviceId: "B",
          channel: "test:echo",
          input: "up",
        }),
        "up",
      );
      assert.deepEqual(bridge.directPeerIds(), ["B"]);
      // Our own relay link down (no live roster): the working direct
      // session must survive an account-relay outage.
      applyDirectPresence(false, [], presenceDeps);
      assert.deepEqual(bridge.directPeerIds(), ["B"]);
      assert.deepEqual(
        await bridge.invokePeer({
          deviceId: "B",
          channel: "test:echo",
          input: "outage",
        }),
        "outage",
      );
      // A live roster still naming the peer: nothing closes.
      applyDirectPresence(true, ["A", "B"], presenceDeps);
      assert.deepEqual(bridge.directPeerIds(), ["B"]);
      // The peer leaves the live roster: the cached client session
      // drops at once.
      applyDirectPresence(true, ["A"], presenceDeps);
      assert.deepEqual(bridge.directPeerIds(), []);
      // Host side: an inbound authed direct socket dies when ITS
      // deviceId leaves the roster, and survives while present.
      let hostSideClosed = false;
      const inbound = await dialWith(
        listener.port,
        listener.tickets.mint("A", 1)[0],
        { onClose: () => (hostSideClosed = true) },
      );
      applyDirectPresence(true, ["A"], presenceDeps);
      assert.equal(
        await inbound.transport.invoke("test:echo", "still here"),
        "still here",
      );
      applyDirectPresence(true, [], presenceDeps);
      await waitFor(
        () => hostSideClosed,
        "the off-roster peer's host-side socket to close",
      );
    },
  );

  await check(
    "routing: openPeer is direct-first with relay fallback, directPeerIds and directPeerVersions report the direct session, and a closed direct socket drops the cache and re-establishes",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const listener = await startDirectListener(track);
      const { client } = await bootPair(stub, track, listener);
      let directChanges = 0;
      const bridge = makeRelayHandlers({
        status: () => client.connection.status(),
        connectPeer: (deviceId, opts) =>
          client.connection.connectPeer(deviceId, opts),
        connectDirect: dialerFor(client),
        onDirectChange: () => {
          directChanges += 1;
        },
      });
      // Direct available: the cached session is direct and invokes
      // leave the relay flat once established.
      assert.deepEqual(
        await bridge.invokePeer({
          deviceId: "B",
          channel: "test:echo",
          input: { n: 1 },
        }),
        { n: 1 },
      );
      assert.deepEqual(bridge.directPeerIds(), ["B"]);
      // The welcome-confirmed version surfaces for the direct session,
      // so the owner's status snapshot can feed the skew check.
      assert.deepEqual(bridge.directPeerVersions(), { B: "2.0.0" });
      assert.equal(
        directChanges,
        1,
        "opening a direct session never fired onDirectChange",
      );
      const baseline = stub.forwardedCount();
      assert.deepEqual(
        await bridge.invokePeer({
          deviceId: "B",
          channel: "test:echo",
          input: { n: 2 },
        }),
        { n: 2 },
      );
      assert.equal(
        stub.forwardedCount(),
        baseline,
        "a cached direct session still rode the relay",
      );
      // Closing the direct socket (listener teardown) drops the cache
      // and the direct marker.
      await listener.binding.stop();
      await waitFor(
        () => bridge.directPeerIds().length === 0,
        "the direct session to drop from the cache",
      );
      assert.equal(
        directChanges,
        2,
        "closing the direct session never fired onDirectChange",
      );
      // The next invoke re-decides: the broker answers unavailable
      // now, so it falls back to the relay and still succeeds.
      assert.deepEqual(
        await bridge.invokePeer({
          deviceId: "B",
          channel: "test:echo",
          input: { n: 3 },
        }),
        { n: 3 },
      );
      assert.deepEqual(bridge.directPeerIds(), []);
      assert.deepEqual(bridge.directPeerVersions(), {});
      assert.ok(
        stub.forwardedCount() > baseline,
        "the fallback invoke never rode the relay",
      );
    },
  );

  await check(
    "routing fallback on a dead dial: an unreachable direct port falls back to the relay and the invoke still succeeds",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const listener = await startDirectListener(track);
      // Free the port, then keep ADVERTISING it: the broker hands out
      // tickets and a port nobody listens on, so the dial itself must
      // fail and the bridge must fall back.
      const deadPort = listener.port;
      await listener.binding.stop();
      listener.listenerPort = () => deadPort;
      const { client } = await bootPair(stub, track, listener);
      const bridge = makeRelayHandlers({
        status: () => client.connection.status(),
        connectPeer: (deviceId, opts) =>
          client.connection.connectPeer(deviceId, opts),
        connectDirect: dialerFor(client),
      });
      assert.deepEqual(
        await bridge.invokePeer({
          deviceId: "B",
          channel: "test:echo",
          input: "fallback",
        }),
        "fallback",
      );
      assert.deepEqual(bridge.directPeerIds(), []);
    },
  );

  await check(
    "pushes: a host broadcast reaches a direct-connected client through the shared peerPush path, tagged with the peer's deviceId",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const listener = await startDirectListener(track);
      const { client } = await bootPair(stub, track, listener);
      const pushes = [];
      const bridge = makeRelayHandlers({
        status: () => client.connection.status(),
        connectPeer: (deviceId, opts) =>
          client.connection.connectPeer(deviceId, opts),
        connectDirect: dialerFor(client, {
          onAnyPush: (deviceId, channel, payload) =>
            pushes.push({ deviceId, channel, payload }),
        }),
      });
      // Dial-on-subscribe: the session comes up with no invoke, then
      // the host's fan-out reaches it over the direct socket.
      await bridge.ensurePeer({ deviceId: "B" });
      assert.deepEqual(bridge.directPeerIds(), ["B"]);
      const baseline = stub.forwardedCount();
      listener.binding.broadcastAll("test:ping", { n: 7 });
      await waitFor(() => pushes.length > 0, "the direct push");
      assert.deepEqual(pushes[0], {
        deviceId: "B",
        channel: "test:ping",
        payload: { n: 7 },
      });
      assert.equal(
        stub.forwardedCount(),
        baseline,
        "the push rode the relay instead of the direct socket",
      );
    },
  );

  done();
}

main().catch(fail);
