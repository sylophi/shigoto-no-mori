// Durable proof for the direct data plane (v2 step 10 slice A, made
// the ONLY data plane by slice C): the relay is orchestration and data
// flows over DIRECT websockets between devices, brokered by
// short-lived single-use connect tickets, with no relay fallback
// behind a failed dial.
//
// Boots the stub Durable Object (scripts/lib/relayStub.mjs) with two
// REAL relay connections (A the dialing client, B the host) plus a
// REAL ticket-mode ws listener instance (host/socket/server.ts with a
// WsServerTicketAuth) on an ephemeral loopback port, and drives the
// real broker (direct:connectInfo wired into the binding's one slot)
// and the REAL shared composition (shared/relay/directPlane.ts: the
// dialer over the broker leg, the bridge cache over the dialer),
// through the shared fixtures in scripts/lib/directBoot.mjs. Asserts:
//
//   - connectInfo over the relay answers available:true with fully
//     dialable candidates (kind, complete URL, one smpt_ ticket EACH)
//     while the listener is up, available:false when it is not,
//     available:false without an authenticated callerDeviceId, and
//     available:false for a caller outside the live roster.
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
//   - the dialer opens candidates concurrently under ONE overall
//     deadline (hellos serialized, see slice B below): a junk
//     candidate cannot defeat a reachable one, a wedged connectInfo
//     cannot hang the bridge cache (the attempt rejects typed and the
//     failure memo short-circuits the next one), and a blocked verdict
//     whose hello was sent is terminal for the whole attempt.
//   - a winning dial closes its throwaway broker session with bye, so
//     the host's relay-side session dies at once instead of lingering
//     until presence notices.
//   - presence scopes the data plane: a peer leaving a LIVE roster
//     loses its direct sessions host-side and client-side, while our
//     own relay link going down leaves them alone.
//   - openPeer is direct or nothing (slice C): a working listener
//     yields a direct session reported via directPeerVersions, a dead
//     socket drops the cache, and a FAILED dial rejects with the typed
//     unreachable outcome with no relay session created for data.
//     (The relay wire refusing every non-broker channel is pinned in
//     check-relay-link.mjs. Here there is nothing left to register on
//     the wire, so no second proof exists to write.)
//   - pushes from the host reach a direct-connected client through the
//     shared peerPush path while the relay stub forwards nothing.
//
// SLICE B (tunnel endpoints) adds:
//
//   - the broker advertises a tunnel-kind candidate with its own
//     ticket exactly while the tunnel reports healthy, omits it
//     otherwise, and mints ONLY the kinds the caller declared it can
//     dial (dialableKinds in the connectInfo input).
//   - candidate hellos are SERIALIZED: with two reachable candidates
//     the slower one never sends a hello, so the winner's session
//     survives (no host-side supersede) and the loser's ticket is
//     never spent.
//   - a blocked verdict aborts the race only when that candidate's
//     hello was actually sent: a connection-time CLOSE_AUTH_FAILED
//     (the host's lockout shape) retires one candidate, not the race.
//   - the ticket-mode listener keys lockout on CF-Connecting-IP for
//     loopback (tunnel-borne) connections, so one hostile client
//     cannot bench every tunnel dial behind the shared 127.0.0.1.
//   - the kind-to-scheme invariant: a tunnel-kind ws:// candidate is
//     refused at the schema and skipped by the dialer, its ticket
//     unspent.
//   - the web path's dialableKinds reaches the HOST, which mints only
//     dialable kinds. A peer with nothing for this platform answers
//     available:false and the attempt rejects as unreachable, and an
//     OLD host's undialable answer yields the typed
//     NoDialableCandidateError, memoized under the ONE short-TTL
//     failure memo and cleared early by the peer's offline-to-online
//     transition.
//   - the roster sweeps cover mid-dial entries (a session completing
//     after its peer left the roster is closed and never reported,
//     quit closes an in-flight dial's socket), a dropped direct socket
//     recovers on the next dial-on-subscribe ensure, and the
//     remoteAccess:commandAccess preflight flips live with the grant
//     on one direct session.
//   - the cloudflared deciders (argv/env secret discipline, the
//     capped ladder through the supervisor's shared lookup) and the
//     runner's lifecycle (no-binary, unconfigured cached for the
//     process lifetime, probe-gated advertising with a deadline,
//     crash restart reusing the cached provision only after a
//     probe-passed child, re-provision on port change / a never-ready
//     child, stable reset, reconcile no-op that preserves backoff, a
//     denied provision parking with no timed retry, and the
//     pre-empting stop whose terminal latch also swallows queued
//     reconciles) against stub deps and a fake clock, with the
//     connector token never in any status object.
//
// The legacy LAN listener's unchanged behavior is pinned by
// scripts/check-socket-host.mjs, which the battery runs alongside.
//
// Runs under scripts/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. See package.json "direct:check".
import assert from "node:assert/strict";
import { createServer, connect as netConnect } from "node:net";
import { WebSocket as WsClient, WebSocketServer } from "ws";
import {
  CLOSE_AUTH_FAILED,
  CommandRefusedError,
} from "@shared/ipc/socket/frames";
import {
  connectDevice,
  RemoteConnectError,
} from "@shared/ipc/socket/wsClientTransport";
import { DirectCandidateSchema } from "@shared/ipc/modules/direct";
import { remoteAccessContract } from "@shared/ipc/modules/remoteAccess";
import { registerContract } from "@shared/ipc/registerContract";
import { makeRelayHandlers } from "@shared/relay/bridgeHandlers";
import {
  createDirectDialer,
  NoDialableCandidateError,
} from "@shared/relay/directDial";
import { applyDirectPresence } from "@shared/relay/directPresence";
import { remoteAccessHandlers } from "@host/ipc/modules/remoteAccess";
import { backoffDelayMs } from "@shared/remote/supervisor";
import {
  cloudflaredArgs,
  cloudflaredEnv,
  createCloudflaredRunner,
  TUNNEL_BACKOFF_LADDER_MS,
  TUNNEL_PROBE_DEADLINE_MS,
  TUNNEL_PROBE_DELAYS_MS,
  TUNNEL_STABLE_MS,
} from "@host/direct/cloudflared";
import {
  createConnectTicketStore,
  DIRECT_TICKET_PREFIX,
} from "@host/direct/tickets";
import { makeDirectHandlers } from "@host/ipc/modules/direct";
import {
  TunnelProvisionDeniedError,
  TunnelUnconfiguredError,
} from "@shared/account/service";
import { fakeClock, makeProof } from "./lib/checkKit.mjs";
import {
  bootBrokeredPair as bootPair,
  makeDirectBridge,
  startDirectListener as startListenerFixture,
} from "./lib/directBoot.mjs";
import { bootDevice, delay, waitFor } from "./lib/relayBoot.mjs";
import { startStubRelay } from "./lib/relayStub.mjs";

// A blackholed candidate (TEST-NET-3, never routed): a dial to it
// hangs or dies on its own, never reaching any listener.
const BLACKHOLE = "203.0.113.1";

// The shared listener fixture (scripts/lib/directBoot.mjs) with this
// check's data-plane test handlers mounted. Handler counters prove
// refusals never ran a body.
async function startDirectListener(track, opts = {}) {
  let mutateRuns = 0;
  const listener = await startListenerFixture(track, {
    ...opts,
    registerHandlers: (binding) => {
      binding.handle("test:echo", async (_ctx, raw) => raw, {
        mutating: false,
      });
      binding.handle(
        "test:whoami",
        async (ctx) => ctx.callerDeviceId ?? "none",
        { mutating: false },
      );
      binding.handle(
        "test:mutate",
        async () => {
          mutateRuns += 1;
          return "mutated";
        },
        { mutating: true },
      );
    },
  });
  return { ...listener, mutateRuns: () => mutateRuns };
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

// A dialer over a FAKE broker answering a fixed candidate list, for
// scenarios that need per-candidate URLs (different ports, stubs) the
// real broker's one-listener-port shape cannot express, or a stand-in
// for an OLD host that ignores the dialableKinds input. Counts broker
// round trips so memo scenarios can pin who paid what.
function fakeBrokerDialer(answer, opts = {}) {
  let brokerCalls = 0;
  const dialer = createDirectDialer({
    connectBroker: async () => {
      brokerCalls += 1;
      return {
        brokerInvoke: async () =>
          typeof answer === "function" ? answer() : answer,
        close() {},
        remoteDeviceId: "B",
        remoteAppVersion: "9",
      };
    },
    localDeviceId: "A",
    localAppVersion: "1.0.0",
    dialableKinds: opts.dialableKinds,
    deadlineMs: opts.deadlineMs ?? 4000,
    failureTtlMs: opts.failureTtlMs,
  });
  return { dialer, brokerCalls: () => brokerCalls };
}

// A loopback TCP proxy that delays the ACCEPTED connection before
// piping it to the target, so a candidate's socket opens late by a
// controlled amount (a slow route stand-in).
function delayProxy(track, targetPort, delayMs) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      const timer = setTimeout(() => {
        const upstream = netConnect(targetPort, "127.0.0.1");
        sockets.add(upstream);
        upstream.on("close", () => sockets.delete(upstream));
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
        upstream.on("connect", () => {
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
      }, delayMs);
      socket.on("close", () => clearTimeout(timer));
    });
    server.listen(0, "127.0.0.1", () => {
      track(
        () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      );
      resolve(server.address().port);
    });
  });
}

// One raw ticket-mode dial through the `ws` client (which, unlike the
// browser-global WebSocket, can set headers), for the lockout-identity
// scenario. Resolves with the close code and whether a welcome landed.
function rawHeaderDial(port, ticket, cfConnectingIp) {
  return new Promise((resolve) => {
    const socket = new WsClient(`ws://127.0.0.1:${port}`, {
      headers: { "cf-connecting-ip": cfConnectingIp },
    });
    let welcomed = false;
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          t: "hello",
          token: ticket,
          deviceId: "A",
          appVersion: "1.0.0",
        }),
      );
    });
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.t === "welcome") {
        welcomed = true;
        socket.close();
      }
    });
    socket.on("error", () => {});
    socket.on("close", (code) => resolve({ code, welcomed }));
  });
}

// The bridge cache (shared/relay/bridgeHandlers.ts) driven directly
// with a controllable dialer whose one dial resolves only on release,
// so the mid-dial sweep scenarios can provably land a sweep between
// dial start and completion.
function heldDial() {
  let release;
  let closed = 0;
  let changes = 0;
  const handlers = makeRelayHandlers({
    status: () => ({
      socket: { phase: "connected" },
      onlineDeviceIds: [],
      peerAppVersions: {},
    }),
    connectDirect: () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            transport: {
              invoke: async () => null,
              subscribe: () => () => {},
            },
            close: () => {
              closed += 1;
            },
            remoteDeviceId: "B",
            remoteAppVersion: "9",
          });
      }),
    onDirectChange: () => {
      changes += 1;
    },
  });
  return {
    handlers,
    release: () => release(),
    closed: () => closed,
    changes: () => changes,
  };
}

const { check, done, fail } = makeProof("direct-plane proof");

async function main() {
  console.log("direct data plane proof\n");

  await check(
    "brokering: connectInfo over the relay carries fully dialable candidates with one ticket each while the listener is up, and available:false when it is down",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const listener = await startDirectListener(track);
      const { client } = await bootPair(stub, track, listener, {
        candidateAddresses: () => ["127.0.0.1", "192.0.2.9"],
      });
      const peer = await client.connection.connectBroker("B");
      const info = await peer.brokerInvoke(undefined);
      assert.equal(info.available, true);
      // The host builds the complete dial URLs, so the two sides can
      // never disagree on how URL and ticket line up.
      assert.deepEqual(
        info.candidates.map(({ kind, url }) => ({ kind, url })),
        [
          { kind: "lan", url: `ws://127.0.0.1:${listener.port}` },
          { kind: "lan", url: `ws://192.0.2.9:${listener.port}` },
        ],
      );
      const tickets = info.candidates.map(({ ticket }) => ticket);
      for (const ticket of tickets) {
        assert.ok(
          typeof ticket === "string" && ticket.startsWith(DIRECT_TICKET_PREFIX),
          "a ticket does not carry the smpt_ prefix",
        );
      }
      assert.equal(new Set(tickets).size, tickets.length);
      // Listener down: the broker answers unavailable, never a stale
      // candidate.
      await listener.binding.stop();
      const down = await peer.brokerInvoke(undefined);
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
      // one). connectInfo reads nothing else off its context.
      const anonymous = {};
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
      const { bridge } = makeDirectBridge(client);
      track(() => bridge.closeDirectPeers());
      await bridge.ensurePeer({ deviceId: "B" });
      // The welcome pinned the dialed identity and confirmed the
      // host's version, surfaced through the one per-peer data fact.
      assert.deepEqual(bridge.directPeerVersions(), { B: "2.0.0" });
      // The direct wire carries the authed caller identity to
      // handlers.
      assert.equal(
        await bridge.invokePeer({
          deviceId: "B",
          channel: "test:whoami",
          input: undefined,
        }),
        "A",
      );
      const baseline = stub.forwardedCount();
      for (let i = 0; i < 5; i += 1) {
        // oxlint-disable-next-line no-await-in-loop -- sequential invokes measure the relay stays flat
        const result = await bridge.invokePeer({
          deviceId: "B",
          channel: "test:echo",
          input: { i },
        });
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
      const { bridge } = makeDirectBridge(client, { deadlineMs: 4000 });
      track(() => bridge.closeDirectPeers());
      const startedAt = Date.now();
      await bridge.ensurePeer({ deviceId: "B" });
      const elapsed = Date.now() - startedAt;
      assert.ok(
        elapsed < 2000,
        `the reachable candidate waited on the junk one (${elapsed}ms)`,
      );
      assert.equal(
        await bridge.invokePeer({
          deviceId: "B",
          channel: "test:echo",
          input: "raced",
        }),
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
      const { bridge } = makeDirectBridge(client, { deadlineMs: 5000 });
      const startedAt = Date.now();
      await assert.rejects(
        () => bridge.ensurePeer({ deviceId: "B" }),
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
    "serialized hellos: with two reachable candidates the slow one never hellos, the winner's session survives (no supersede) and the loser's ticket stays unspent",
    async (track) => {
      const listener = await startDirectListener(track);
      // The SAME listener behind a delayed route and a direct one. The
      // slow candidate's socket opens well after the fast one won: if
      // its hello were sent anyway (the old concurrent-hello shape),
      // the host's per-device supersede would kill the winner's fresh
      // session and the invoke below would reject.
      const slowPort = await delayProxy(track, listener.port, 250);
      const [slowTicket, fastTicket] = listener.tickets.mint("A", 2);
      const { dialer } = fakeBrokerDialer({
        available: true,
        candidates: [
          {
            kind: "lan",
            url: `ws://127.0.0.1:${slowPort}`,
            ticket: slowTicket,
          },
          {
            kind: "lan",
            url: `ws://127.0.0.1:${listener.port}`,
            ticket: fastTicket,
          },
        ],
      });
      const connection = await dialer.connectDirect("B");
      track(() => connection.close());
      assert.equal(connection.remoteDeviceId, "B");
      // Let the slow candidate's socket open, be abandoned, and any
      // frames drain before judging the winner's health.
      await delay(450);
      assert.equal(
        await connection.transport.invoke("test:echo", "still the winner"),
        "still the winner",
        "the slow candidate's late hello superseded the winning session",
      );
      // The loser never sent a hello, so its ticket was never
      // presented and is still consumable.
      assert.equal(
        listener.tickets.consume(slowTicket, "A"),
        true,
        "the abandoned candidate spent its ticket",
      );
      assert.equal(listener.tickets.consume(fastTicket, "A"), false);
    },
  );

  await check(
    "pre-hello blocked verdicts are not terminal: a connection-time CLOSE_AUTH_FAILED (the lockout shape) retires one candidate while a later candidate still wins the race",
    async (track) => {
      const listener = await startDirectListener(track);
      // Candidate 1 accepts the hello, then fails NON-blocked after
      // 300ms, holding the hello slot while candidate 2 arrives.
      const slowFail = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      slowFail.on("connection", (socket) => {
        socket.on("message", () => {
          setTimeout(() => socket.close(1011, "boom"), 300);
        });
      });
      await new Promise((resolve) => slowFail.on("listening", resolve));
      track(() => new Promise((resolve) => slowFail.close(() => resolve())));
      // Candidate 2 is closed with CLOSE_AUTH_FAILED at connection
      // time (never a hello turn: candidate 1 holds the slot), the
      // exact shape a locked-out identity produces. Under the old
      // rule this aborted the ENTIRE race.
      const lockout = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      lockout.on("connection", (socket) => {
        socket.close(CLOSE_AUTH_FAILED, "temporarily locked out");
      });
      await new Promise((resolve) => lockout.on("listening", resolve));
      track(() => new Promise((resolve) => lockout.close(() => resolve())));
      const lockoutPort = await delayProxy(track, lockout.address().port, 120);
      // Candidate 3 is the real listener, opening only after both
      // failures played out.
      const realPort = await delayProxy(track, listener.port, 450);
      const [ticket] = listener.tickets.mint("A", 1);
      const { dialer } = fakeBrokerDialer({
        available: true,
        candidates: [
          {
            kind: "lan",
            url: `ws://127.0.0.1:${slowFail.address().port}`,
            ticket: "smpt_junk_1",
          },
          {
            kind: "lan",
            url: `ws://127.0.0.1:${lockoutPort}`,
            ticket: "smpt_junk_2",
          },
          { kind: "lan", url: `ws://127.0.0.1:${realPort}`, ticket },
        ],
      });
      const connection = await dialer.connectDirect("B");
      track(() => connection.close());
      assert.equal(connection.remoteDeviceId, "B");
      assert.equal(
        await connection.transport.invoke("test:echo", "survived"),
        "survived",
      );
    },
  );

  await check(
    "candidate boundary: a tunnel-kind ws:// candidate is refused by the schema and never dialed, its ticket unspent",
    async (track) => {
      // Schema level: the kind-to-scheme invariant.
      const refused = [
        { kind: "tunnel", url: "ws://127.0.0.1:42017", ticket: "smpt_x" },
        {
          kind: "tunnel",
          url: "wss://sm-x.example.test:8443",
          ticket: "smpt_x",
        },
        { kind: "tunnel", url: "wss://127.0.0.1", ticket: "smpt_x" },
        { kind: "lan", url: "wss://127.0.0.1:42017", ticket: "smpt_x" },
        { kind: "lan", url: "ws://evil.example.test:42017", ticket: "smpt_x" },
        { kind: "lan", url: "ws://127.0.0.1", ticket: "smpt_x" },
        { kind: "lan", url: "not a url", ticket: "smpt_x" },
      ];
      for (const candidate of refused) {
        assert.equal(
          DirectCandidateSchema.safeParse(candidate).success,
          false,
          `schema admitted ${candidate.kind} ${candidate.url}`,
        );
      }
      const admitted = [
        { kind: "lan", url: "ws://127.0.0.1:42017", ticket: "smpt_x" },
        { kind: "lan", url: "ws://[fd00::1]:42017", ticket: "smpt_x" },
        { kind: "tunnel", url: "wss://sm-x.sm.example.test", ticket: "smpt_x" },
      ];
      for (const candidate of admitted) {
        assert.equal(
          DirectCandidateSchema.safeParse(candidate).success,
          true,
          `schema refused ${candidate.kind} ${candidate.url}`,
        );
      }
      // Dialer level: a malformed candidate from a REAL listener's
      // broker answer is skipped, so the dial fails and the ticket is
      // never presented, even though the URL itself is reachable.
      const listener = await startDirectListener(track);
      const [ticket] = listener.tickets.mint("A", 1);
      const { dialer } = fakeBrokerDialer(
        {
          available: true,
          candidates: [
            {
              kind: "tunnel",
              url: `ws://127.0.0.1:${listener.port}`,
              ticket,
            },
          ],
        },
        { deadlineMs: 1500 },
      );
      await assert.rejects(
        () => dialer.connectDirect("B"),
        undefined,
        "a tunnel-kind ws:// candidate was dialed",
      );
      assert.equal(
        listener.tickets.consume(ticket, "A"),
        true,
        "the refused candidate's ticket was spent",
      );
    },
  );

  await check(
    "loopback lockout identity: the ticket listener keys lockout on CF-Connecting-IP for loopback connections, so one hostile identity cannot bench another's dial",
    async (track) => {
      const listener = await startDirectListener(track);
      // Five bad tickets under one forwarded identity lock IT out.
      for (let i = 0; i < 5; i += 1) {
        // oxlint-disable-next-line no-await-in-loop -- lockout counts sequential failures
        const { code } = await rawHeaderDial(
          listener.port,
          "smpt_wrong",
          "198.51.100.7",
        );
        assert.equal(code, CLOSE_AUTH_FAILED);
      }
      // The locked identity is refused at connection time even with a
      // VALID ticket (never presented, so it stays live).
      const [lockedTicket] = listener.tickets.mint("A", 1);
      const locked = await rawHeaderDial(
        listener.port,
        lockedTicket,
        "198.51.100.7",
      );
      assert.equal(locked.welcomed, false, "a locked-out identity authed");
      assert.equal(locked.code, CLOSE_AUTH_FAILED);
      // A DIFFERENT identity over the same loopback path dials fine:
      // under remoteAddress keying both would share one 127.0.0.1
      // bucket and this dial would be benched too.
      const [freshTicket] = listener.tickets.mint("A", 1);
      const other = await rawHeaderDial(
        listener.port,
        freshTicket,
        "198.51.100.8",
      );
      assert.equal(
        other.welcomed,
        true,
        "an innocent identity was benched by another identity's lockout",
      );
    },
  );

  await check(
    "deadline: a wedged connectInfo cannot hang the bridge cache, whose attempt rejects typed within the budget and whose failure memo short-circuits the next one",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      // B serves a connectInfo that NEVER answers (a wedged peer),
      // wired raw into its one broker slot.
      const host = await bootDevice(
        stub,
        "B",
        { brokerHandler: () => new Promise(() => {}) },
        track,
      );
      const client = await bootDevice(stub, "A", {}, track);
      const { bridge } = makeDirectBridge(client, { deadlineMs: 400 });
      const startedAt = Date.now();
      // Direct or nothing: the wedged broker means the peer is
      // unreachable for data, so the invoke rejects with the deadline
      // error instead of hanging every consumer of this peer.
      await assert.rejects(
        () =>
          bridge.invokePeer({
            deviceId: "B",
            channel: "test:echo",
            input: "hung broker",
          }),
        /exceeded its 400ms deadline/,
      );
      const elapsed = Date.now() - startedAt;
      assert.ok(
        elapsed < 3000,
        `the wedged connectInfo was not bounded by the deadline (${elapsed}ms)`,
      );
      assert.deepEqual(bridge.directPeerVersions(), {});
      // The failed dial dropped its cache entry (no poisoning) and the
      // dialer's failure memo answers the retry at once, without a
      // second broker round trip.
      const retryStartedAt = Date.now();
      await assert.rejects(
        () =>
          bridge.invokePeer({
            deviceId: "B",
            channel: "test:echo",
            input: "retry",
          }),
        /failed recently/,
      );
      assert.ok(
        Date.now() - retryStartedAt < 200,
        "the failure memo did not short-circuit the retry",
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
    "bye: a winning dial closes its throwaway broker session with a bye the host acts on, so the relay-side session dies at once and no broker garbage lingers",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const listener = await startDirectListener(track);
      const { client } = await bootPair(stub, track, listener);
      const { bridge } = makeDirectBridge(client);
      track(() => bridge.closeDirectPeers());
      await bridge.ensurePeer({ deviceId: "B" });
      // The broker leg closed its relay session before the dial
      // resolved, and the close carried a bye so B's relay-side host
      // session died at once instead of waiting on presence.
      const bye = stub.received.find(
        (entry) =>
          entry.from === "A" &&
          entry.to === "B" &&
          entry.frame?.sm?.t === "bye",
      );
      assert.ok(bye, "the broker session close never sent a bye");
      // The relay stays quiet from here: data flows on the direct
      // socket only, so nothing else rides the stub. (The wire itself
      // refusing non-broker channels is pinned in check-relay-link.mjs,
      // and there is no registration surface left here to prove twice.)
      const baseline = stub.forwardedCount();
      assert.equal(
        await bridge.invokePeer({
          deviceId: "B",
          channel: "test:echo",
          input: "after bye",
        }),
        "after bye",
      );
      await delay(150);
      assert.equal(
        stub.forwardedCount(),
        baseline,
        "post-dial traffic still rode the relay",
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
      const { bridge } = makeDirectBridge(client);
      track(() => bridge.closeDirectPeers());
      const notePresenceCalls = [];
      const presenceDeps = {
        closeHostPeersNotIn: (online) =>
          listener.binding.closePeersNotIn(online),
        dropClientPeersNotIn: (online) => bridge.dropDirectPeersNotIn(online),
        notePresence: (online) => notePresenceCalls.push([...online]),
      };
      assert.deepEqual(
        await bridge.invokePeer({
          deviceId: "B",
          channel: "test:echo",
          input: "up",
        }),
        "up",
      );
      assert.deepEqual(Object.keys(bridge.directPeerVersions()), ["B"]);
      // Our own relay link down (no live roster): the working direct
      // session must survive an account-relay outage, but the dialer's
      // roster bookkeeping resets (an empty notePresence) so the
      // post-reconnect roster counts as fresh offline-to-online
      // transitions and clears stale failure memos.
      applyDirectPresence(false, [], presenceDeps);
      assert.deepEqual(
        notePresenceCalls.at(-1),
        [],
        "a relay-down reconcile did not reset the dialer's roster",
      );
      assert.deepEqual(Object.keys(bridge.directPeerVersions()), ["B"]);
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
      assert.deepEqual(Object.keys(bridge.directPeerVersions()), ["B"]);
      // The peer leaves the live roster: the cached client session
      // drops at once.
      applyDirectPresence(true, ["A"], presenceDeps);
      assert.deepEqual(bridge.directPeerVersions(), {});
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
    "mid-dial sweeps: a peer leaving the roster while its dial is in flight has the completed session closed on arrival and never reported, and the quit sweep closes an in-flight dial's socket too",
    async () => {
      // Roster sweep: the peer leaves (revocation included) while its
      // dial is still in flight. The completing session must not be
      // installed for a device the control plane stopped vouching for.
      const sweep = heldDial();
      const ensure = sweep.handlers.ensurePeer({ deviceId: "B" });
      sweep.handlers.dropDirectPeersNotIn([]);
      sweep.release();
      await ensure;
      assert.equal(
        sweep.closed(),
        1,
        "the session completing after the roster sweep was not closed",
      );
      assert.deepEqual(sweep.handlers.directPeerVersions(), {});
      assert.equal(
        sweep.changes(),
        0,
        "an orphan session fired onDirectChange",
      );
      // Quit sweep: closeDirectPeers with a dial still in flight must
      // close the resulting socket instead of leaking it past quit.
      const quit = heldDial();
      const quitEnsure = quit.handlers.ensurePeer({ deviceId: "B" });
      quit.handlers.closeDirectPeers();
      quit.release();
      await quitEnsure;
      assert.equal(
        quit.closed(),
        1,
        "the quit sweep left the in-flight dial's socket open",
      );
      assert.deepEqual(quit.handlers.directPeerVersions(), {});
    },
  );

  await check(
    "drop then recover: a dead direct socket drops the cache and the next dial-on-subscribe ensure re-establishes the session (no memo blocks a drop that was not a dial failure)",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const listener = await startDirectListener(track);
      const { client } = await bootPair(stub, track, listener);
      const { bridge } = makeDirectBridge(client);
      track(() => bridge.closeDirectPeers());
      await bridge.ensurePeer({ deviceId: "B" });
      assert.deepEqual(bridge.directPeerVersions(), { B: "2.0.0" });
      // The established direct socket dies out from under the client
      // (the host closes it), and the cache drops the session.
      listener.binding.closePeersNotIn([]);
      await waitFor(
        () => Object.keys(bridge.directPeerVersions()).length === 0,
        "the dropped session to leave the cache",
      );
      // The re-ensure the renderer transport fires off the drop's own
      // status snapshot (an online subscribed peer with no established
      // session) redials at once: the drop itself was never a dial
      // failure, so no failure memo stands in the way.
      await bridge.ensurePeer({ deviceId: "B" });
      assert.deepEqual(bridge.directPeerVersions(), { B: "2.0.0" });
      assert.deepEqual(
        await bridge.invokePeer({
          deviceId: "B",
          channel: "test:echo",
          input: "recovered",
        }),
        "recovered",
      );
    },
  );

  await check(
    "grant preflight on the direct wire: remoteAccess:commandAccess answers false pre-grant and true post-grant over the SAME direct session, no reconnect",
    async (track) => {
      const listener = await startListenerFixture(track, {
        registerHandlers: (binding) => {
          registerContract(
            remoteAccessContract,
            remoteAccessHandlers,
            binding,
            {
              validateOutputs: true,
            },
          );
        },
      });
      const connection = await dialWith(
        listener.port,
        listener.tickets.mint("A", 1)[0],
      );
      track(() => connection.close());
      // The preflight is a read, served ungated, and fail-closed about
      // the CALLER: no grant means granted:false, never an error.
      assert.deepEqual(
        await connection.transport.invoke(
          "remoteAccess:commandAccess",
          undefined,
        ),
        { granted: false },
      );
      listener.granted.add("A");
      assert.deepEqual(
        await connection.transport.invoke(
          "remoteAccess:commandAccess",
          undefined,
        ),
        { granted: true },
      );
      // And a revoke flips the verdict live on the same socket.
      listener.granted.delete("A");
      assert.deepEqual(
        await connection.transport.invoke(
          "remoteAccess:commandAccess",
          undefined,
        ),
        { granted: false },
      );
    },
  );

  await check(
    "routing: openPeer is direct or nothing, directPeerVersions reports the direct session, and a closed direct socket drops the cache and rejects typed on the next use",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const listener = await startDirectListener(track);
      const { client } = await bootPair(stub, track, listener);
      // The plane fans a status snapshot out on every direct open and
      // close (the same statusChanged fan-out a relay transition
      // fires), so the counter reads that seam.
      let directChanges = 0;
      const { bridge } = makeDirectBridge(client, {
        onStatusChange: () => {
          directChanges += 1;
        },
      });
      track(() => bridge.closeDirectPeers());
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
      assert.deepEqual(Object.keys(bridge.directPeerVersions()), ["B"]);
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
        () => Object.keys(bridge.directPeerVersions()).length === 0,
        "the direct session to drop from the cache",
      );
      assert.equal(
        directChanges,
        2,
        "closing the direct session never fired onDirectChange",
      );
      // The next invoke re-decides: the broker answers unavailable now
      // and there is nothing to fall back to, so the attempt rejects
      // with the typed unreachable outcome and the cache stays empty.
      await assert.rejects(
        () =>
          bridge.invokePeer({
            deviceId: "B",
            channel: "test:echo",
            input: { n: 3 },
          }),
        /offers no direct listener/,
      );
      assert.deepEqual(bridge.directPeerVersions(), {});
    },
  );

  await check(
    "unreachable is typed: a failed direct dial rejects the invoke with the dial error and creates no relay data session",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const listener = await startDirectListener(track);
      // Free the port, then keep ADVERTISING it: the broker hands out
      // tickets and a port nobody listens on, so the dial itself fails
      // and the failure is the outcome (direct or nothing).
      const deadPort = listener.port;
      await listener.binding.stop();
      listener.listenerPort = () => deadPort;
      const { client } = await bootPair(stub, track, listener);
      const { bridge } = makeDirectBridge(client, { deadlineMs: 1500 });
      await assert.rejects(
        () =>
          bridge.invokePeer({
            deviceId: "B",
            channel: "test:echo",
            input: "unreachable",
          }),
        // Typed pin: a dead advertised port fails the candidate's
        // socket, so the dial error is the connect error itself, not
        // some incidental throw.
        (error) => error instanceof RemoteConnectError,
      );
      assert.deepEqual(bridge.directPeerVersions(), {});
      // No relay session was created for the data: the throwaway
      // broker session closed with a bye, and after it nothing from A
      // rides the relay at B anymore.
      const bye = stub.received.find(
        (entry) =>
          entry.from === "A" &&
          entry.to === "B" &&
          entry.frame?.sm?.t === "bye",
      );
      assert.ok(bye, "the failed dial left its broker session open");
      const baseline = stub.receivedCount();
      await delay(200);
      assert.equal(
        stub.receivedCount(),
        baseline,
        "something kept riding the relay after the failed dial",
      );
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
      const { bridge } = makeDirectBridge(client, {
        onPeerPush: (push) => pushes.push(push),
      });
      track(() => bridge.closeDirectPeers());
      // Dial-on-subscribe: the session comes up with no invoke, then
      // the host's fan-out reaches it over the direct socket.
      await bridge.ensurePeer({ deviceId: "B" });
      assert.deepEqual(Object.keys(bridge.directPeerVersions()), ["B"]);
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

  await check(
    "tunnel advertising: connectInfo carries a tunnel-kind candidate with its own ticket exactly while the tunnel reports healthy, and omits it otherwise",
    async () => {
      let tunnel = null;
      const minted = [];
      const handlers = makeDirectHandlers({
        listenerPort: () => 42017,
        mintTickets: (_peer, count) => {
          const tickets = Array.from(
            { length: count },
            (_unused, i) => `smpt_${minted.length}_${i}`,
          );
          minted.push(tickets);
          return tickets;
        },
        isPeerOnline: () => true,
        candidateAddresses: () => ["127.0.0.1", "fd00::1"],
        tunnelUrl: () => tunnel,
      });
      const ctx = {
        signal: new AbortController().signal,
        notifier: () => () => {},
        callerDeviceId: "A",
      };
      // Unhealthy tunnel: lan candidates only, with IPv6 literals
      // bracketed into dialable URLs.
      const without = handlers.connectInfo(undefined, ctx);
      assert.equal(without.available, true);
      assert.deepEqual(
        without.candidates.map(({ kind, url }) => ({ kind, url })),
        [
          { kind: "lan", url: "ws://127.0.0.1:42017" },
          { kind: "lan", url: "ws://[fd00::1]:42017" },
        ],
      );
      // Healthy tunnel: one more candidate with a ticket of its own,
      // aligned with the minted set.
      tunnel = "wss://sm-0123456789ab.sm.example.test";
      const withTunnel = handlers.connectInfo(undefined, ctx);
      assert.deepEqual(withTunnel.candidates.at(-1), {
        kind: "tunnel",
        url: tunnel,
        ticket: minted[1].at(-1),
      });
      assert.deepEqual(
        withTunnel.candidates.map(({ ticket }) => ticket),
        minted[1],
        "the candidate tickets drifted from the minted set",
      );
      // A tunnel with NO interface addresses still advertises: data
      // is direct or nothing, so a host reachable only through its
      // tunnel must stay dialable.
      const only = makeDirectHandlers({
        listenerPort: () => 42017,
        mintTickets: (_peer, count) =>
          Array.from({ length: count }, (_unused, i) => `smpt_only_${i}`),
        isPeerOnline: () => true,
        candidateAddresses: () => [],
        tunnelUrl: () => tunnel,
      }).connectInfo(undefined, ctx);
      assert.equal(only.available, true);
      assert.deepEqual(
        only.candidates.map(({ kind, url }) => ({ kind, url })),
        [{ kind: "tunnel", url: tunnel }],
      );
      // The caller's dialableKinds gate MINTING: a tunnel-only caller
      // gets exactly the tunnel candidate and one ticket (no lan
      // tickets burned and abandoned), a lan-only caller the reverse,
      // and a tunnel-only caller against a tunnel-less host gets
      // available:false with nothing minted at all.
      const before = minted.length;
      const tunnelOnly = handlers.connectInfo(
        { dialableKinds: ["tunnel"] },
        ctx,
      );
      assert.deepEqual(
        tunnelOnly.candidates.map(({ kind }) => kind),
        ["tunnel"],
      );
      assert.equal(minted.length, before + 1);
      assert.equal(minted.at(-1).length, 1, "a lan ticket was minted anyway");
      const lanOnly = handlers.connectInfo({ dialableKinds: ["lan"] }, ctx);
      assert.deepEqual(
        lanOnly.candidates.map(({ kind }) => kind),
        ["lan", "lan"],
      );
      tunnel = null;
      const nothing = handlers.connectInfo({ dialableKinds: ["tunnel"] }, ctx);
      const mintsSoFar = minted.length;
      assert.deepEqual(nothing, { available: false });
      assert.equal(
        minted.length,
        mintsSoFar,
        "a ticket was minted for an undialable caller",
      );
    },
  );

  await check(
    "dialableKinds (the web path): the declared capability reaches the host over the wire, which mints only the tunnel ticket, and a tunnel-less peer is the plain unreachable outcome",
    async (track) => {
      const stub = await startStubRelay();
      track(() => stub.close());
      const listener = await startDirectListener(track);
      // A well-formed but unroutable tunnel hostname: a check cannot
      // stand up a real wss endpoint (the no-port invariant pins the
      // tunnel to 443), so this scenario pins the BROKER half (what
      // was minted) and the failure outcome, while the race mechanics
      // are pinned by the lan scenarios above through the same code
      // path.
      const minted = [];
      const { client } = await bootPair(stub, track, listener, {
        // A REACHABLE lan candidate the host must NOT mint for a
        // tunnel-only caller.
        candidateAddresses: () => ["127.0.0.1"],
        tunnelUrl: () => "wss://sm-check-nonexistent.invalid",
        onMinted: (tickets) => {
          minted.push(tickets);
        },
      });
      const { bridge } = makeDirectBridge(client, {
        dialableKinds: ["tunnel"],
        deadlineMs: 2500,
      });
      // The dial cannot succeed (unroutable hostname), so the invoke
      // rejects as unreachable: direct or nothing. Typed pin: the
      // failed candidate socket surfaces as the connect error.
      await assert.rejects(
        () =>
          bridge.invokePeer({
            deviceId: "B",
            channel: "test:echo",
            input: "unroutable",
          }),
        (error) => error instanceof RemoteConnectError,
      );
      assert.deepEqual(bridge.directPeerVersions(), {});
      // The host saw the caller's capability and minted ONE ticket
      // (the tunnel's), never a lan ticket to burn and abandon.
      assert.equal(minted.length, 1, "expected exactly one broker mint");
      assert.equal(
        minted[0].length,
        1,
        "the host minted lan tickets for a tunnel-only caller",
      );
      // A tunnel-less host answers a tunnel-only caller
      // available:false and mints nothing: the plain unreachable
      // outcome, distinguishable from the structural skew error below.
      const bare = await startDirectListener(track);
      const bareMinted = [];
      const stub2 = await startStubRelay();
      track(() => stub2.close());
      const pair2 = await bootPair(stub2, track, bare, {
        candidateAddresses: () => ["127.0.0.1"],
        onMinted: (tickets) => {
          bareMinted.push(tickets);
        },
      });
      const bareBridge = makeDirectBridge(pair2.client, {
        dialableKinds: ["tunnel"],
        deadlineMs: 2000,
      }).bridge;
      await assert.rejects(
        () => bareBridge.ensurePeer({ deviceId: "B" }),
        /offers no direct listener/,
        "a kind-filtered empty answer was not the plain unavailable outcome",
      );
      assert.equal(bareMinted.length, 0, "an undialable caller minted tickets");
    },
  );

  await check(
    "old-host skew and the ONE failure memo: an answer ignoring dialableKinds yields the typed NoDialableCandidateError, memoized under the same short TTL as any failure and cleared early by the peer's offline-to-online transition",
    async () => {
      // The fake broker stands in for an OLD host: it ignores the
      // input and answers lan candidates to a tunnel-only caller.
      const { dialer, brokerCalls } = fakeBrokerDialer(
        {
          available: true,
          candidates: [
            { kind: "lan", url: "ws://127.0.0.1:9", ticket: "smpt_x" },
          ],
        },
        { dialableKinds: ["tunnel"], failureTtlMs: 300, deadlineMs: 1000 },
      );
      await assert.rejects(
        () => dialer.connectDirect("B"),
        (error) => error instanceof NoDialableCandidateError,
        "an undialable candidate set did not reject with the typed error",
      );
      assert.equal(brokerCalls(), 1);
      // Within the TTL the memo short-circuits: no broker round trip.
      // ONE memo for every failure kind (there is no fallback behind a
      // dial, so an unexpiring structural memo would brick a peer whose
      // tunnel was merely still starting).
      await assert.rejects(() => dialer.connectDirect("B"), /failed recently/);
      assert.equal(brokerCalls(), 1, "the memo did not short-circuit");
      // The peer going offline and coming back clears the memo EARLY,
      // before the TTL: its offer may genuinely have changed (a tunnel
      // came up).
      dialer.notePresence([]);
      dialer.notePresence(["B"]);
      await assert.rejects(
        () => dialer.connectDirect("B"),
        (error) => error instanceof NoDialableCandidateError,
      );
      assert.equal(brokerCalls(), 2, "the presence transition did not clear");
      // And the TTL alone recovers too: past expiry the next dial pays
      // a real broker round trip instead of the memo answer.
      await delay(350);
      await assert.rejects(
        () => dialer.connectDirect("B"),
        (error) => error instanceof NoDialableCandidateError,
      );
      assert.equal(brokerCalls(), 3, "the expired memo still short-circuited");
    },
  );

  await check(
    "cloudflared deciders are pure and disciplined: the tunnel ladder caps through the supervisor's shared lookup, and the token rides env only, never argv",
    async () => {
      // The shared lookup clamps at both ends of the tunnel ladder.
      assert.equal(
        backoffDelayMs(
          TUNNEL_BACKOFF_LADDER_MS,
          TUNNEL_BACKOFF_LADDER_MS.length + 50,
        ),
        TUNNEL_BACKOFF_LADDER_MS.at(-1),
        "the ladder did not cap",
      );
      assert.equal(
        backoffDelayMs(TUNNEL_BACKOFF_LADDER_MS, -5),
        TUNNEL_BACKOFF_LADDER_MS[0],
      );
      // Secret discipline: the connector token appears in the child
      // env's TUNNEL_TOKEN and NOWHERE in argv.
      const token = "test-connector-token-value";
      const args = cloudflaredArgs();
      assert.deepEqual(args, ["tunnel", "run"]);
      assert.ok(
        args.every((arg) => !arg.includes(token)),
        "the token leaked into argv",
      );
      const env = cloudflaredEnv({ PATH: "/usr/bin" }, token);
      assert.equal(env.TUNNEL_TOKEN, token);
      assert.equal(env.PATH, "/usr/bin");
    },
  );

  await check(
    "cloudflared runner: no-binary and unconfigured are typed terminal states, and the unconfigured verdict is cached for the process lifetime",
    async () => {
      const clock = fakeClock();
      // Missing binary: reported, and provisioning never even runs.
      let binaryPath = null;
      let provisions = 0;
      const noBinary = createCloudflaredRunner({
        resolveBinary: async () => binaryPath,
        provision: async () => {
          provisions += 1;
          return { hostname: "h.example.test", connectorToken: "t" };
        },
        spawnTunnel: () => ({ onExit() {}, kill() {} }),
        probeTunnel: async () => true,
        clock,
      });
      await noBinary.reconcile({ port: 40100 });
      assert.equal(noBinary.status().state, "no-binary");
      assert.equal(noBinary.tunnelUrl(), null);
      assert.equal(provisions, 0);
      // no-binary is re-entered on reconcile (unlike unconfigured): a
      // config write may have just named a usable cloudflaredPath, so
      // the same-port reconcile re-resolves and recovers.
      binaryPath = "/stub/cloudflared";
      await noBinary.reconcile({ port: 40100 });
      assert.equal(noBinary.status().state, "starting");
      assert.equal(provisions, 1);
      await noBinary.reconcile(null);
      // Worker unconfigured: the typed error parks the runner without
      // a retry timer, so time passing changes nothing.
      let unconfiguredCalls = 0;
      const unconfigured = createCloudflaredRunner({
        resolveBinary: async () => "/stub/cloudflared",
        provision: async () => {
          unconfiguredCalls += 1;
          throw new TunnelUnconfiguredError();
        },
        spawnTunnel: () => assert.fail("spawned while unconfigured"),
        probeTunnel: async () => true,
        clock,
      });
      await unconfigured.reconcile({ port: 40100 });
      assert.equal(unconfigured.status().state, "unconfigured");
      await clock.advance(10 * 60_000);
      assert.equal(
        unconfiguredCalls,
        1,
        "an unconfigured worker was retried on a timer",
      );
      assert.equal(unconfigured.status().state, "unconfigured");
      // A deployment fact does not change with the port: even a
      // port-changing reconcile skips the provision round trip for the
      // rest of the process lifetime.
      await unconfigured.reconcile({ port: 40200 });
      assert.equal(
        unconfiguredCalls,
        1,
        "the unconfigured verdict was not cached across reconciles",
      );
      assert.equal(unconfigured.status().state, "unconfigured");
    },
  );

  await check(
    "cloudflared runner: the readiness probe gates advertising (a failed attempt retries on the probe ladder), a post-ready crash restarts from the cached provision on the capped backoff, a port change re-provisions, stop kills the child cleanly, and the token never reaches a status object",
    async () => {
      const clock = fakeClock();
      const token = "connector-token-must-not-leak";
      const spawned = [];
      const provisionPorts = [];
      const probeAnswers = [false, true];
      let statusChanges = 0;
      const runner = createCloudflaredRunner({
        resolveBinary: async () => "/stub/cloudflared",
        provision: async (port) => {
          provisionPorts.push(port);
          return {
            hostname: "sm-feedfacecafe.sm.example.test",
            connectorToken: token,
          };
        },
        spawnTunnel: (binaryPath, connectorToken) => {
          assert.equal(binaryPath, "/stub/cloudflared");
          assert.equal(connectorToken, token);
          const child = {
            killed: false,
            exit: null,
            onExit(handler) {
              this.exit = handler;
            },
            kill() {
              this.killed = true;
            },
          };
          spawned.push(child);
          return child;
        },
        probeTunnel: async (hostname) => {
          assert.equal(hostname, "sm-feedfacecafe.sm.example.test");
          return probeAnswers.length > 0 ? probeAnswers.shift() : true;
        },
        onChange: () => {
          statusChanges += 1;
          // The secret must never surface on ANY observable snapshot.
          assert.ok(
            !JSON.stringify(runner.status()).includes(token),
            "the connector token leaked into a status object",
          );
        },
        clock,
      });
      await runner.reconcile({ port: 40100 });
      assert.deepEqual(provisionPorts, [40100]);
      assert.equal(spawned.length, 1);
      // Probing: starting, NOT advertised yet.
      assert.equal(runner.status().state, "starting");
      assert.equal(runner.tunnelUrl(), null);
      // First probe attempt answers not-routable: still starting, the
      // chain retries on the next rung instead of advertising.
      await clock.advance(TUNNEL_PROBE_DELAYS_MS[0]);
      assert.equal(runner.status().state, "starting");
      assert.equal(runner.tunnelUrl(), null);
      await clock.advance(TUNNEL_PROBE_DELAYS_MS[1]);
      assert.equal(runner.status().state, "up");
      assert.equal(runner.tunnelUrl(), "wss://sm-feedfacecafe.sm.example.test");
      assert.ok(statusChanges > 0);
      // Reconciling the unchanged port over a live child is a no-op.
      await runner.reconcile({ port: 40100 });
      assert.equal(spawned.length, 1);
      assert.deepEqual(provisionPorts, [40100]);
      // The child dies: not advertised anymore, restart scheduled on
      // the ladder.
      spawned[0].exit("cloudflared exited (code 1)");
      await clock.settle();
      assert.equal(runner.status().state, "error");
      assert.equal(runner.tunnelUrl(), null);
      // A same-port reconcile while the retry is scheduled is a no-op
      // too: it must neither provision nor reset the ladder.
      await runner.reconcile({ port: 40100 });
      assert.equal(runner.status().state, "error");
      assert.deepEqual(provisionPorts, [40100]);
      await clock.advance(TUNNEL_BACKOFF_LADDER_MS[0]);
      assert.equal(spawned.length, 2, "no respawn after the backoff delay");
      // The crash restart reused the cached provision (the dead child
      // HAD passed the probe): no Worker round trip for an unchanged
      // port.
      assert.deepEqual(
        provisionPorts,
        [40100],
        "a post-ready crash restart re-provisioned an unchanged port",
      );
      await clock.advance(TUNNEL_PROBE_DELAYS_MS[0]);
      assert.equal(runner.status().state, "up");
      // A listener restart on a NEW ephemeral port kills the old child
      // and re-provisions against the new port.
      await runner.reconcile({ port: 40200 });
      assert.equal(spawned[1].killed, true);
      assert.equal(spawned.length, 3);
      assert.deepEqual(provisionPorts, [40100, 40200]);
      // reconcile(null) (sign-out, account switch, directConnections
      // off, the listener going down all land here): the child is
      // killed, nothing restarts later.
      await runner.reconcile(null);
      assert.equal(spawned[2].killed, true);
      assert.equal(runner.status().state, "off");
      assert.equal(runner.tunnelUrl(), null);
      await clock.advance(10 * 60_000);
      assert.equal(spawned.length, 3, "a stopped runner respawned");
    },
  );

  await check(
    "cloudflared runner: a never-ready child's restart re-provisions (its token may be dead), a probed-ready child's crash reuses the cache, a stable run resets the ladder, and a never-routable child fails at the probe deadline",
    async () => {
      const clock = fakeClock();
      const spawned = [];
      let provisions = 0;
      let routable = false;
      const runner = createCloudflaredRunner({
        resolveBinary: async () => "/stub/cloudflared",
        provision: async () => {
          provisions += 1;
          return {
            hostname: "sm-feedfacecafe.sm.example.test",
            connectorToken: "stub-token",
          };
        },
        spawnTunnel: () => {
          const child = {
            exit: null,
            killed: false,
            onExit(handler) {
              this.exit = handler;
            },
            kill() {
              this.killed = true;
            },
          };
          spawned.push(child);
          return child;
        },
        probeTunnel: async () => routable,
        clock,
      });
      await runner.reconcile({ port: 40100 });
      assert.equal(provisions, 1);
      // The child dies BEFORE any probe passed: the cached provision
      // is not trusted (the token may be dead), so the restart pays a
      // fresh Worker round trip.
      spawned.at(-1).exit("cloudflared exited (code 1)");
      await clock.advance(TUNNEL_BACKOFF_LADDER_MS[0]);
      assert.equal(spawned.length, 2, "no respawn after the backoff");
      assert.equal(
        provisions,
        2,
        "a never-ready child's restart reused the cached provision",
      );
      // This child passes the probe, runs stably, then crashes: the
      // restart reuses the cache (no third provision) and starts from
      // the ladder's bottom rung again.
      routable = true;
      await clock.advance(TUNNEL_PROBE_DELAYS_MS[0]);
      assert.equal(runner.status().state, "up");
      await clock.advance(TUNNEL_STABLE_MS);
      spawned.at(-1).exit("cloudflared exited (code 1)");
      await clock.advance(TUNNEL_BACKOFF_LADDER_MS[0]);
      assert.equal(
        spawned.length,
        3,
        "a stable run did not reset the ladder to the bottom rung",
      );
      assert.equal(
        provisions,
        2,
        "a probed-ready child's crash re-provisioned an unchanged port",
      );
      await runner.reconcile(null);

      // A child that never becomes routable: the probe chain walks its
      // ladder until the deadline, then kills the child and takes the
      // failure path, and the NEXT attempt re-provisions (never
      // ready).
      const deadlineClock = fakeClock();
      const deadlineSpawns = [];
      let deadlineProvisions = 0;
      const neverRoutable = createCloudflaredRunner({
        resolveBinary: async () => "/stub/cloudflared",
        provision: async () => {
          deadlineProvisions += 1;
          return { hostname: "h.example.test", connectorToken: "t" };
        },
        spawnTunnel: () => {
          const child = {
            killed: false,
            onExit() {},
            kill() {
              this.killed = true;
            },
          };
          deadlineSpawns.push(child);
          return child;
        },
        probeTunnel: async () => false,
        clock: deadlineClock,
      });
      await neverRoutable.reconcile({ port: 40100 });
      assert.equal(deadlineSpawns.length, 1);
      // Walk the probe chain past its deadline (each step covers the
      // capped rung, so the walk is bounded by the deadline itself).
      const step = TUNNEL_PROBE_DELAYS_MS.at(-1);
      for (
        let walked = 0;
        walked <= TUNNEL_PROBE_DEADLINE_MS + step &&
        neverRoutable.status().state === "starting";
        walked += step
      ) {
        // oxlint-disable-next-line no-await-in-loop -- the probe chain advances serially by design
        await deadlineClock.advance(step);
      }
      assert.equal(neverRoutable.status().state, "error");
      assert.equal(
        deadlineSpawns[0].killed,
        true,
        "the never-routable child was not killed at the probe deadline",
      );
      assert.equal(neverRoutable.tunnelUrl(), null);
      // The scheduled restart re-provisions: the child never reached
      // readiness.
      await deadlineClock.advance(TUNNEL_BACKOFF_LADDER_MS.at(-1));
      assert.equal(deadlineSpawns.length, 2, "no respawn after the deadline");
      assert.equal(deadlineProvisions, 2);
      await neverRoutable.stop();
    },
  );

  await check(
    "cloudflared runner: a denied provision (401/404) parks with NO scheduled retry, and the next reconcile trigger is its recovery path",
    async () => {
      const clock = fakeClock();
      let provisions = 0;
      let denied = true;
      const spawns = [];
      const runner = createCloudflaredRunner({
        resolveBinary: async () => "/stub/cloudflared",
        provision: async () => {
          provisions += 1;
          if (denied) {
            throw new TunnelProvisionDeniedError("device revoked", 401);
          }
          return { hostname: "h.example.test", connectorToken: "t" };
        },
        spawnTunnel: () => {
          const child = { onExit() {}, kill() {} };
          spawns.push(child);
          return child;
        },
        probeTunnel: async () => true,
        clock,
      });
      await runner.reconcile({ port: 40100 });
      assert.equal(runner.status().state, "error");
      assert.equal(provisions, 1);
      // Parked: time passing schedules NOTHING (a timed retry would
      // re-present the same refused request forever).
      await clock.advance(30 * 60_000);
      assert.equal(provisions, 1, "a denied provision retried on a timer");
      assert.equal(spawns.length, 0);
      // The next reconcile trigger re-enters even on the same port:
      // that is exactly when the inputs (a re-sign-in, a Worker
      // redeploy) can have changed.
      denied = false;
      await runner.reconcile({ port: 40100 });
      assert.equal(provisions, 2, "the reconcile trigger did not re-enter");
      assert.equal(spawns.length, 1);
      assert.equal(runner.status().state, "starting");
      await runner.reconcile(null);
    },
  );

  await check(
    "cloudflared runner: stop pre-empts an in-flight provision AND latches, so a reconcile queued behind that provision spawns nothing during quit",
    async () => {
      const clock = fakeClock();
      let releaseProvision;
      const spawns = [];
      const hung = createCloudflaredRunner({
        resolveBinary: async () => "/stub/cloudflared",
        provision: () =>
          new Promise((resolve) => {
            releaseProvision = resolve;
          }),
        spawnTunnel: () => {
          const child = { onExit() {}, kill() {} };
          spawns.push(child);
          return child;
        },
        probeTunnel: async () => true,
        clock,
      });
      const reconciling = hung.reconcile({ port: 40100 });
      await clock.settle();
      // A second reconcile queues behind the in-flight provision. Its
      // slot drains AFTER stop below: without the terminal latch it
      // would re-set wantedPort and respawn mid-quit.
      const queued = hung.reconcile({ port: 40200 });
      const stopping = hung.stop();
      assert.equal(
        hung.status().state,
        "off",
        "stop did not mark the runner off synchronously",
      );
      releaseProvision({ hostname: "h.example.test", connectorToken: "t" });
      await reconciling;
      await queued;
      await stopping;
      assert.equal(spawns.length, 0, "a queued reconcile spawned after stop");
      assert.equal(hung.status().state, "off");
      // The latch is terminal (quit is stop's only caller): even a
      // later reconcile does nothing.
      await hung.reconcile({ port: 40300 });
      assert.equal(spawns.length, 0, "a post-stop reconcile spawned");
      assert.equal(hung.status().state, "off");
    },
  );

  done();
}

main().catch(fail);
