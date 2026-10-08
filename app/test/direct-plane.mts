// Durable proof for the direct data plane (the ONLY data
// plane): the device hub is orchestration and data
// flows over DIRECT websockets between devices, brokered by short-lived
// single-use connect tickets, with no hub fallback behind a failed
// dial.
//
// Boots the stub Durable Object (test/lib/hubStub.mts) with two
// REAL hub connections (A the dialing client, B the host) plus a
// REAL direct ws listener (host/socket/server.ts with a
// WsServerTicketAuth) on an ephemeral loopback port, and drives the
// real connectInfo server (host/direct/connectInfo.ts, wired as the
// hub connection's one answer) and the REAL shared composition
// (shared/hub/directPlane.ts: the dialer over the connectInfo ask, the
// bridge cache over the dialer), through the shared fixtures in
// test/lib/directBoot.mts. Asserts:
//
//   - connectInfo over the device hub answers available:true with fully
//     dialable candidates (kind, complete URL, one smpt_ ticket EACH)
//     while the listener is up and available:false when it is not,
//     mints for the hub-stamped caller only, and mints nothing for an
//     ask forged from outside the live roster or with a malformed
//     input.
//   - a direct dial completes the handshake, pins the welcome
//     identity, and invokes flow over the direct socket while the stub
//     hub's forwardedCount stays flat (the whole point).
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
//     candidate cannot defeat a reachable one, a peer that never
//     answers the ask cannot hang the bridge cache (the attempt
//     rejects typed), and a blocked verdict is terminal for the whole
//     attempt once no candidate wins.
//   - a dial costs the device hub exactly one ask and one answer,
//     nothing before or after.
//   - presence scopes the data plane: a peer leaving a LIVE roster
//     loses its direct sessions host-side and client-side, while our
//     own hub link going down leaves them alone.
//   - the session cache is direct or nothing (slice C): a working
//     listener yields a direct session reported via
//     directPeerVersions, a dead socket drops the cache, and a FAILED
//     dial rejects with the typed unreachable outcome with no hub
//     session created for data.
//     (The hub wire answering nothing but connectInfo is pinned in
//     hub-link.mts.)
//   - pushes from the host reach a direct-connected client through the
//     shared peerPush path while the hub stub forwards nothing.
//
// SLICE B (tunnel endpoints) adds:
//
//   - the host advertises a tunnel-kind candidate with its own
//     ticket exactly while the tunnel reports healthy, omits it
//     otherwise, and mints ONLY the kinds the caller declared it can
//     dial (dialableKinds in the connectInfo input).
//   - candidate hellos are SERIALIZED: with two reachable candidates
//     the slower one never sends a hello, so the winner's session
//     survives (no host-side supersede) and the loser's ticket is
//     never spent.
//   - the host NAMES its refusals: a ticket it read and rejected
//     closes CLOSE_AUTH_FAILED (blocked, terminal, the keeper parks),
//     while a client benched by the failed-auth window closes
//     CLOSE_AUTH_LOCKED_OUT (unblocked, transient, the keeper ladders)
//     even on a single candidate holding a VALID ticket, the shape a
//     tunnel-only peer has.
//   - the listener keys lockout on CF-Connecting-IP for
//     loopback (tunnel-borne) connections, so one hostile client
//     cannot bench every tunnel dial behind the shared 127.0.0.1.
//   - the kind-to-scheme invariant: a tunnel-kind ws:// candidate is
//     refused at the schema and skipped by the dialer, its ticket
//     unspent.
//   - the web path's dialableKinds reaches the HOST, which mints only
//     dialable kinds. A peer with nothing for this platform answers
//     available:false and the attempt rejects as unreachable. A peer
//     that serves no direct listener (the REAL browser binding) yields
//     the typed NoDialableCandidateError off the link's no-listener
//     answer, a terminal verdict the keeper parks on (see SUPERVISION
//     below), while a peer whose server merely threw stays transient.
//   - the roster sweeps cover mid-dial entries (a session completing
//     after its peer left the roster is closed and never reported,
//     quit closes an in-flight dial's socket), and the peer's command
//     access rides the connectInfo answer into the bridge's snapshot,
//     then follows the host's switch live on one direct session.
//
// SUPERVISION makes sessions desired state, the presence
// roster the input, and the keeper (shared/hub/directKeeper.ts) the
// ONLY dial trigger:
//
//   - presence alone establishes the session: the roster naming a peer
//     is followed by an established direct session with NO invoke and
//     no user action anywhere, and an invoke with no session rejects
//     at once WITHOUT dialing (no hub traffic), so a renderer retry
//     loop cannot pace dials.
//   - a dead direct socket is redialed by the keeper on the shared
//     backoff ladder with no ensure/invoke involved.
//   - the keeper's retry discipline against a stub dial and a fake
//     clock: eager dial on roster entry, the exact shared ladder on
//     transient failures (capped, forever), stable reset, roster exit
//     cancels the schedule, hub-down reconciles to empty without
//     touching sessions, and TERMINAL verdicts (blocked ticket, no
//     listener, version) PARK with no timer -- the
//     lockout-protection rule -- until the peer's offline-to-online
//     transition redials it fresh.
//   - the cloudflared deciders (argv/env secret discipline, the
//     capped ladder through the supervisor's shared lookup) and the
//     runner's lifecycle (no-binary, unconfigured cached for the
//     process lifetime, probe-gated advertising with a deadline,
//     crash restart reusing the cached provision only after a
//     probe-passed child, re-provision on port change / a never-ready
//     child, stable reset, reconcile no-op that preserves backoff, a
//     denied provision parking with no timed retry, and the layer's
//     close pre-empting an in-flight provision) against a stub
//     spawner, stub deps and a TestClock, with the connector token
//     never in any status object.
//
// The listener's own hardening (framing, the Origin gate, frame and
// in-flight caps, the generation guard) is pinned by
// test/socket-host.mts, which the battery runs alongside.
//
// Run: pnpm test direct-plane.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Logger from "effect/Logger";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { WebSocket as WsClient, WebSocketServer } from "ws";
import { it } from "vitest";
import { CommandRefusedError } from "@shigomori/contracts/errors";
import {
  CLOSE_AUTH_FAILED,
  CLOSE_AUTH_LOCKED_OUT,
  type ServerFrame,
} from "@shared/ipc/socket/frames";
import {
  type ConnectDeviceOptions,
  openDevice,
  RemoteConnectError,
} from "@shared/ipc/socket/wsClientTransport";
import {
  DirectCandidateSchema,
  type DirectCandidateKind,
  type DirectConnectInfo,
  DirectConnectInfoSchema,
} from "@shigomori/contracts/modules/direct";
import type { HubPeerPush, HubStatus } from "@shigomori/contracts/modules/hub";
import { createChannelMux } from "@shared/ipc/socket/channels";
import { type HubHandlers, makeHubHandlers } from "@shared/hub/bridgeHandlers";
import {
  createDirectDialer,
  type DirectDialerDeps,
  isTerminalDialError,
  NoDialableCandidateError,
} from "@shared/hub/directDial";
import { createDirectKeeper } from "@shared/hub/directKeeper";
import {
  applyDirectPresence,
  type DirectPresenceDeps,
} from "@shared/hub/directPresence";
import {
  BACKOFF_LADDER_MS,
  backoffDelayMs,
  STABLE_CONNECTION_MS,
  type SupervisorStatus,
} from "@shared/remote/supervisor";
import {
  cloudflaredArgs,
  cloudflaredEnv,
  resolveCloudflaredBinary,
  Tunnel,
  TunnelProvisionError,
  TUNNEL_BACKOFF_LADDER_MS,
  TUNNEL_PROBE_DEADLINE_FRESH_MS,
  TUNNEL_PROBE_DEADLINE_MS,
  TUNNEL_PROBE_SLOW_MS,
  TUNNEL_PROBE_WARN_MS,
  TUNNEL_PROBE_DELAYS_MS,
  TUNNEL_PROBE_DELAYS_REUSED_MS,
  TUNNEL_STABLE_MS,
  type TunnelProvision,
} from "@host/direct/cloudflared";
import * as Tunnels from "@host/direct/cloudflared";
import {
  type ConnectTicketStore,
  createConnectTicketStore,
  DIRECT_TICKET_PREFIX,
} from "@host/direct/tickets";
import { makeConnectInfo } from "@host/direct/connectInfo";
import {
  AnswerFrameSchema,
  AskFrameSchema,
  CONNECT_INFO_ASK,
  HubAskRefusedError,
} from "@shared/hub/link";
import { handshakeProof, newHandshakeNonce } from "@shared/ipc/socket/proof";
import {
  TunnelProvisionDeniedError,
  TunnelUnconfiguredError,
} from "@shared/account/service";
import { createHubConnection as createWebConnection } from "../web/hub/connection.ts";
import {
  boundPort,
  entryAt,
  testClock,
  lastOf,
  notYetSet,
  startLoopbackServer,
  type Track,
  waitFor,
} from "./lib/checkKit.mts";
import {
  bootBrokeredPair as bootPair,
  type DirectListenerOpts,
  makeDirectBridge,
  mintTicket,
  mintTickets,
  startDirectListener as startListenerFixture,
} from "./lib/directBoot.mts";
import { bootDevice } from "./lib/hubBoot.mts";
import { delay } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";
import { startStubHub } from "./lib/hubStub.mts";

// A blackholed candidate (TEST-NET-3, never routed): a dial to it
// hangs or dies on its own, never reaching any listener.
const BLACKHOLE = "203.0.113.1";

// The shared listener fixture (test/lib/directBoot.mts) with this
// check's data-plane test handlers mounted. Handler counters prove
// refusals never ran a body.
async function startDirectListener(
  track: Track,
  opts: DirectListenerOpts = {},
) {
  let mutateRuns = 0;
  const listener = await startListenerFixture(track, {
    ...opts,
    registerHandlers: (binding) => {
      binding.handle("test:echo", async (_ctx, raw) => raw, {
        gated: false,
      });
      binding.handle(
        "test:whoami",
        async (ctx) => ctx.callerDeviceId ?? "none",
        { gated: false },
      );
      binding.handle(
        "test:mutate",
        async () => {
          mutateRuns += 1;
          return "mutated";
        },
        { gated: true },
      );
    },
  });
  return { ...listener, mutateRuns: () => mutateRuns };
}

// One direct dial against the listener under test. The defaults are
// the happy path (A dialing B with the identity pin), and each caller
// overrides only what its scenario varies.
function dialWith(
  port: number,
  ticket: string,
  overrides: Partial<ConnectDeviceOptions> = {},
) {
  return openDevice({
    url: `ws://127.0.0.1:${port}`,
    ticket,
    appVersion: "1.0.0",
    localDeviceId: "A",
    expectedDeviceId: "B",
    onClose: () => {},
    helloTimeoutMs: 800,
    ...overrides,
  }).authenticate();
}

// A dialer over a FAKE ask answering a fixed candidate list, for
// scenarios that need per-candidate URLs (different ports, stubs) the
// real server's one-listener-port shape cannot express. `answer` may be
// a function, which may throw to play a rejected ask.
function fakeAskDialer(
  answer: DirectConnectInfo | (() => DirectConnectInfo),
  opts: Pick<DirectDialerDeps, "dialableKinds" | "deadlineMs"> = {},
) {
  const dialer = createDirectDialer({
    askConnectInfo: async () =>
      typeof answer === "function" ? answer() : answer,
    localDeviceId: "A",
    localAppVersion: "1.0.0",
    dialableKinds: opts.dialableKinds,
    // The production socket (main injects ws), so the errno path the
    // seam exists for is what the proof runs.
    openSocket: (url) => new WsClient(url),
    deadlineMs: opts.deadlineMs ?? 4000,
  });
  return { dialer };
}

// The keeper on a TestClock over a stub dial, the scaffolding the two
// supervision scenarios below share: they differ only in what a failed
// dial rejects with (transient vs terminal), which is the whole point
// of running both. Dials fail until succeed() flips them, so a
// scenario can walk a failure streak into an established session
// without rebuilding the keeper.
function stubKeeper(rejectWith: unknown) {
  const clock = testClock();
  const dials: Array<{ deviceId: string; at: number }> = [];
  let dialSucceeds = false;
  const keeper = createDirectKeeper({
    context: clock.context,
    dial: (deviceId) => {
      dials.push({ deviceId, at: clock.now() });
      return dialSucceeds ? Promise.resolve() : Promise.reject(rejectWith);
    },
  });
  return {
    keeper,
    clock,
    dials,
    succeed: () => {
      dialSucceeds = true;
    },
  };
}

// One invoke on B over the bridge's direct session, the call most
// scenarios below make.
function invokeB(bridge: HubHandlers, channel: string, input?: unknown) {
  return bridge.invokePeer({ deviceId: "B", channel, input }, undefined);
}

// A loopback TCP proxy that delays the ACCEPTED connection before
// piping it to the target, so a candidate's socket opens late by a
// controlled amount (a slow route stand-in).
async function delayProxy(track: Track, targetPort: number, delayMs: number) {
  const proxy = await startLoopbackServer((socket, hold) => {
    const timer = setTimeout(() => {
      const upstream = hold(netConnect(targetPort, "127.0.0.1"));
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      upstream.on("connect", () => {
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
    }, delayMs);
    socket.on("close", () => clearTimeout(timer));
  });
  track(proxy.close);
  return proxy.port;
}

// A stub host opens the handshake the way a real listener does. Without
// the challenge the client never sends its hello, so a stub
// that waits for one would just stall until the deadline.
function sendChallenge(socket: WsClient) {
  socket.send(JSON.stringify({ t: "challenge", nonce: newHandshakeNonce() }));
}

// The store never takes a raw ticket back (the dialer proves
// possession instead), so this keeps the checks below reading the way
// they read before that change. A loopback dial with no
// CF-Connecting-IP arrives as a "lan" candidate, which is what the
// default matches.
async function consumeTicket(
  store: ConnectTicketStore,
  ticket: string,
  peer: string,
  kind: DirectCandidateKind = "lan",
) {
  const matched = await store.consumeProven(
    peer,
    kind,
    async (candidate) => candidate === ticket,
  );
  return matched !== null;
}

// One raw direct dial through the `ws` client (which, unlike the
// browser-global WebSocket, can set headers), for the lockout-identity
// scenario. Resolves with the close code and whether a welcome landed.
function rawHeaderDial(
  port: number,
  ticket: string,
  cfConnectingIp: string,
): Promise<{ code: number; welcomed: boolean }> {
  return new Promise((resolve) => {
    const socket = new WsClient(`ws://127.0.0.1:${port}`, {
      headers: { "cf-connecting-ip": cfConnectingIp },
    });
    let welcomed = false;
    socket.on("message", (data) => {
      const frame: ServerFrame = JSON.parse(String(data));
      if (frame.t === "challenge") {
        // The ticket never goes on the wire: answer the host's nonce
        // with an HMAC of both, exactly as the real client does.
        const nonce = newHandshakeNonce();
        void handshakeProof(ticket, "client", frame.nonce, nonce).then(
          (proof) => {
            socket.send(
              JSON.stringify({
                t: "hello",
                deviceId: "A",
                appVersion: "1.0.0",
                nonce,
                proof,
                deflate: false,
              }),
            );
          },
        );
        return;
      }
      if (frame.t === "welcome") {
        welcomed = true;
        socket.close();
      }
    });
    socket.on("error", () => {});
    socket.on("close", (code) => resolve({ code, welcomed }));
  });
}

// The bridge cache (shared/hub/bridgeHandlers.ts) driven directly
// with a controllable dialer whose one dial resolves only on release,
// so the mid-dial sweep scenarios can provably land a sweep between
// dial start and completion.
function heldDial() {
  let release: () => void = notYetSet;
  let closed = 0;
  let changes = 0;
  const handlers = makeHubHandlers({
    status: () => ({
      socket: { phase: "connected", remoteDeviceId: "", remoteAppVersion: "" },
      onlineDeviceIds: [],
      peerAppVersions: {},
      peerAcceptsCommands: {},
    }),
    connectDirect: () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            transport: {
              invoke: async () => null,
              subscribe: () => () => {},
            },
            channels: createChannelMux({ send: () => {} }),
            close: () => {
              closed += 1;
            },
            probe: () => {},
            remoteDeviceId: "B",
            remoteAppVersion: "9",
            acceptsCommands: false,
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

it("brokering: connectInfo over the device hub carries fully dialable candidates with one ticket each while the listener is up, and available:false when it is down", async () => {
  const stub = await startStubHub(trackTest);
  const listener = await startDirectListener(trackTest);
  const { client } = await bootPair(stub, trackTest, listener, {
    candidateAddresses: () => ["127.0.0.1", "192.0.2.9"],
  });
  const ask = () =>
    client.connection.askConnectInfo(
      "B",
      { dialableKinds: ["lan", "tunnel"] },
      3000,
    );
  const info = Schema.decodeUnknownSync(DirectConnectInfoSchema)(await ask());
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
  // Listener down: the host answers unavailable, never a stale
  // candidate.
  await listener.binding.stop();
  assert.deepEqual(await ask(), { available: false });
});

it("brokering serves the roster only: an ask forged from outside the host's live roster and an ask with a malformed input mint nothing, and a real ask mints for the hub-stamped caller", async () => {
  const stub = await startStubHub(trackTest);
  const listener = await startDirectListener(trackTest);
  const minted: string[] = [];
  const { client } = await bootPair(stub, trackTest, listener, {
    onMinted: (tickets) => minted.push(...tickets),
  });
  // A hostile hub can forge any `from`. The host answers nothing to
  // a device its roster does not name, and mints nothing for it.
  stub.injectTo("B", {
    t: "relay",
    from: "ghost",
    frame: {
      ask: CONNECT_INFO_ASK,
      id: 1,
      input: { dialableKinds: ["lan"] },
    },
  });
  await delay(100);
  assert.equal(stub.sentTo("B", "ghost"), false);
  assert.equal(minted.length, 0, "a ticket was minted for a forged sender");
  // The input is parsed before anything is minted.
  await assert.rejects(
    () => client.connection.askConnectInfo("B", { dialableKinds: "lan" }, 3000),
    (error) => error instanceof HubAskRefusedError,
  );
  assert.equal(minted.length, 0, "a malformed ask minted a ticket");
  const info = Schema.decodeUnknownSync(DirectConnectInfoSchema)(
    await client.connection.askConnectInfo(
      "B",
      { dialableKinds: ["lan"] },
      3000,
    ),
  );
  assert.equal(info.available, true);
  assert.equal(minted.length, 1);
  // Bound to the caller the hub stamped, not to anything the ask
  // could claim.
  assert.equal(
    await consumeTicket(listener.tickets, entryAt(minted, 0), "A"),
    true,
    "the ticket was not bound to the asking device",
  );
});

it("direct dial: the handshake completes with the pinned identity and invokes flow while the device hub's forwardedCount stays flat", async () => {
  const stub = await startStubHub(trackTest);
  const listener = await startDirectListener(trackTest);
  const { client } = await bootPair(stub, trackTest, listener);
  const { bridge } = makeDirectBridge(client);
  trackTest(() => bridge.closeDirectPeers());
  await bridge.dialPeer("B");
  // The welcome pinned the dialed identity and confirmed the
  // host's version, surfaced through the one per-peer data fact.
  assert.deepEqual(bridge.directPeerVersions(), { B: "2.0.0" });
  // The direct wire carries the authed caller identity to
  // handlers.
  assert.equal(await invokeB(bridge, "test:whoami"), "A");
  const baseline = stub.forwardedCount();
  for (let i = 0; i < 5; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- sequential invokes measure the device hub stays flat
    const result = await invokeB(bridge, "test:echo", { i });
    assert.deepEqual(result, { i });
  }
  assert.equal(
    stub.forwardedCount(),
    baseline,
    "direct invokes still rode the device hub",
  );
});

it("concurrent race: a junk candidate enumerating first no longer defeats a reachable one, and per-candidate tickets keep every candidate authable", async () => {
  const stub = await startStubHub(trackTest);
  const listener = await startDirectListener(trackTest);
  // The junk candidate FIRST, exactly the ordering that made the
  // sequential walk fail deterministically on multi-interface
  // machines. Both candidates dial at once, so the reachable one
  // wins without waiting out the blackhole.
  const { client } = await bootPair(stub, trackTest, listener, {
    candidateAddresses: () => [BLACKHOLE, "127.0.0.1"],
  });
  const { bridge } = makeDirectBridge(client, { deadlineMs: 4000 });
  trackTest(() => bridge.closeDirectPeers());
  const startedAt = Date.now();
  await bridge.dialPeer("B");
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < 2000,
    `the reachable candidate waited on the junk one (${elapsed}ms)`,
  );
  assert.equal(await invokeB(bridge, "test:echo", "raced"), "raced");
});

it("blocked verdict is terminal but does not end the race: an auth-refused candidate still rejects the attempt as blocked once the remaining candidates have had their turn, never as a transient timeout", async () => {
  const stub = await startStubHub(trackTest);
  // The advertised port belongs to a DIFFERENT device's listener
  // with its own ticket store, so the loopback candidate fails
  // auth (blocked). The blackhole candidate would otherwise hold
  // the race until the deadline.
  const wrongListener = await startDirectListener(trackTest, {
    deviceId: "X",
  });
  const brokerListener = {
    tickets: createConnectTicketStore(),
    listenerPort: () => wrongListener.port,
  };
  const { client } = await bootPair(stub, trackTest, brokerListener, {
    candidateAddresses: () => ["127.0.0.1", BLACKHOLE],
  });
  const { bridge } = makeDirectBridge(client, { deadlineMs: 1500 });
  await assert.rejects(
    () => bridge.dialPeer("B"),
    (error) =>
      error instanceof RemoteConnectError &&
      error.blocked &&
      error.code === CLOSE_AUTH_FAILED,
    "an auth-refused candidate did not reject the attempt as blocked",
  );
});

it("a refusing candidate cannot deny the dial: a far end that refuses has proved nothing (on a LAN address it may be a squatter), so a candidate that opens later still wins", async () => {
  const listener = await startDirectListener(trackTest);
  // A different device's listener stands in for the squatter: it
  // holds none of our tickets, so it refuses the hello it is sent.
  const squatter = await startDirectListener(trackTest, { deviceId: "X" });
  // The real listener sits behind a delay, so the squatter opens,
  // takes the first hello and refuses it before the real one is up.
  const slowPort = await delayProxy(trackTest, listener.port, 250);
  const ticket = mintTicket(listener.tickets, "A");
  const { dialer } = fakeAskDialer({
    available: true,
    acceptsCommands: false,
    candidates: [
      {
        kind: "lan",
        url: `ws://127.0.0.1:${squatter.port}`,
        ticket: "smpt_never_minted",
      },
      { kind: "lan", url: `ws://127.0.0.1:${slowPort}`, ticket },
    ],
  });
  const connection = await dialer.connectDirect("B");
  trackTest(() => connection.close());
  assert.equal(connection.remoteDeviceId, "B");
});

it("serialized hellos: with two reachable candidates the slow one never hellos, the winner's session survives (no supersede) and the loser's ticket stays unspent", async () => {
  const listener = await startDirectListener(trackTest);
  // The SAME listener behind a delayed route and a direct one. The
  // slow candidate's socket opens well after the fast one won: if
  // its hello were sent anyway (the old concurrent-hello shape),
  // the host's per-device supersede would kill the winner's fresh
  // session and the invoke below would reject.
  const slowPort = await delayProxy(trackTest, listener.port, 250);
  const [slowTicket, fastTicket] = mintTickets(listener.tickets, "A", 2);
  assert.ok(
    slowTicket !== undefined && fastTicket !== undefined,
    "expected two minted tickets",
  );
  const { dialer } = fakeAskDialer({
    available: true,
    acceptsCommands: false,
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
  trackTest(() => connection.close());
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
    await consumeTicket(listener.tickets, slowTicket, "A"),
    true,
    "the abandoned candidate spent its ticket",
  );
  assert.equal(await consumeTicket(listener.tickets, fastTicket, "A"), false);
});

it("the host names its lockout on the wire: a client inside the failed-auth window is refused CLOSE_AUTH_LOCKED_OUT, so a single-candidate dial rejects unblocked and the keeper LADDERS instead of parking", async () => {
  const listener = await startDirectListener(trackTest);
  // Bench 127.0.0.1 the way a real client does: five refused
  // tickets. (The dialer cannot set CF-Connecting-IP, so it keys on
  // the loopback address, which is exactly the identity these
  // failures burn.)
  for (let i = 0; i < 5; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- lockout counts sequential failures
    await assert.rejects(
      () => dialWith(listener.port, "smpt_wrong"),
      (error) =>
        error instanceof RemoteConnectError && error.code === CLOSE_AUTH_FAILED,
    );
  }
  // ONE candidate, a VALID ticket, and a benched IP: the shape a
  // tunnel-only peer has. Only the close code can tell this lockout
  // from a refused ticket.
  const ticket = mintTicket(listener.tickets, "A");
  const { dialer } = fakeAskDialer({
    available: true,
    acceptsCommands: false,
    candidates: [
      { kind: "lan", url: `ws://127.0.0.1:${listener.port}`, ticket },
    ],
  });
  let verdict: unknown;
  await assert.rejects(
    () => dialer.connectDirect("B"),
    (error) => {
      verdict = error;
      return error instanceof RemoteConnectError;
    },
  );
  assert.ok(verdict instanceof RemoteConnectError);
  assert.equal(
    verdict.code,
    CLOSE_AUTH_LOCKED_OUT,
    "the host conflated its temporary lockout with a refused ticket",
  );
  assert.equal(
    verdict.blocked,
    false,
    "a temporary lockout was classified as a blocked credential",
  );
  assert.equal(isTerminalDialError(verdict), false);
  // The whole point: the ladder, so the peer comes back on its own
  // when the window expires. A park would outlive the lockout with
  // no roster transition to unpark on.
  const { keeper, clock, dials } = stubKeeper(verdict);
  keeper.reconcile(["B"]);
  await clock.settle();
  assert.equal(dials.length, 1);
  await clock.advance(BACKOFF_LADDER_MS[0]);
  assert.equal(
    dials.length,
    2,
    "a lockout parked the peer instead of retrying it",
  );
  keeper.stop();
});

it("a genuine ticket refusal still PARKS: a ticket the host read and rejected closes CLOSE_AUTH_FAILED, is blocked and terminal, and the keeper schedules nothing", async () => {
  // The other side of the same line. Same single-candidate shape,
  // same connection-time close code family, opposite verdict --
  // and the ONLY thing separating them is what the host put on the
  // wire, which is the argument for the distinct code.
  const listener = await startDirectListener(trackTest);
  const { dialer } = fakeAskDialer({
    available: true,
    acceptsCommands: false,
    candidates: [
      {
        kind: "lan",
        url: `ws://127.0.0.1:${listener.port}`,
        ticket: "smpt_never_minted",
      },
    ],
  });
  let verdict: unknown;
  await assert.rejects(
    () => dialer.connectDirect("B"),
    (error) => {
      verdict = error;
      return error instanceof RemoteConnectError;
    },
  );
  assert.ok(verdict instanceof RemoteConnectError);
  assert.equal(verdict.code, CLOSE_AUTH_FAILED);
  assert.equal(verdict.blocked, true, "a refused ticket was not blocked");
  assert.equal(isTerminalDialError(verdict), true);
  const { keeper, clock, dials } = stubKeeper(verdict);
  keeper.reconcile(["B"]);
  await clock.settle();
  assert.equal(dials.length, 1);
  await clock.advance(lastOf(BACKOFF_LADDER_MS) * 100);
  assert.equal(
    dials.length,
    1,
    "a refused ticket retried on a timer, feeding the host's lockout",
  );
  keeper.stop();
});

it("candidate boundary: a tunnel-kind ws:// candidate is refused by the schema and never dialed, its ticket unspent", async () => {
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
      Schema.is(DirectCandidateSchema)(candidate),
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
      Schema.is(DirectCandidateSchema)(candidate),
      true,
      `schema refused ${candidate.kind} ${candidate.url}`,
    );
  }
  // Dialer level: a malformed candidate pointing at a REAL
  // listener fails the answer's parse, so the dial fails and the
  // ticket is never presented, even though the URL is reachable.
  const listener = await startDirectListener(trackTest);
  const ticket = mintTicket(listener.tickets, "A");
  const { dialer } = fakeAskDialer(
    {
      available: true,
      acceptsCommands: false,
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
    "a tunnel-kind ws:// candidate was dialed",
  );
  assert.equal(
    await consumeTicket(listener.tickets, ticket, "A"),
    true,
    "the refused candidate's ticket was spent",
  );
});

it("the ticket never travels: a machine that answers at an advertised LAN address captures nothing it can spend, and the hello it did capture is worthless against the real listener", async () => {
  const listener = await startDirectListener(trackTest);
  const ticket = mintTicket(listener.tickets, "A");
  // The impostor: whoever holds that private address on the network
  // the dialer happens to be on. It challenges like a real host so
  // the client will talk to it at all, then keeps what it is told.
  const heard: string[] = [];
  const impostor = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  impostor.on("connection", (socket) => {
    sendChallenge(socket);
    socket.on("message", (data) => {
      heard.push(String(data));
    });
  });
  await new Promise((resolve) => impostor.on("listening", resolve));
  trackTest(
    () => new Promise<void>((resolve) => impostor.close(() => resolve())),
  );

  // The victim dials the impostor with a live ticket.
  await assert.rejects(
    () =>
      dialWith(boundPort(impostor), ticket, {
        helloTimeoutMs: 600,
        expectedDeviceId: "B",
      }),
    "the client accepted a host that never proved it holds the ticket",
  );
  const captured = heard.at(-1);
  assert.ok(captured !== undefined, "the impostor saw no hello at all");
  const hello: Record<string, unknown> = JSON.parse(captured);
  assert.equal(hello.t, "hello");
  assert.equal(
    hello.token,
    undefined,
    "the connect ticket was sent to whoever answered first",
  );
  assert.equal(
    captured.includes(ticket),
    false,
    "the connect ticket appeared on the wire",
  );

  // What the impostor did capture, replayed verbatim at the real
  // listener, authenticates nothing: the proof answers a nonce that
  // listener never issued.
  const replay = await new Promise<{ code: number; welcomed: boolean }>(
    (resolve) => {
      const socket = new WsClient(`ws://127.0.0.1:${listener.port}`);
      let welcomed = false;
      socket.on("message", (data) => {
        const frame: ServerFrame = JSON.parse(String(data));
        if (frame.t === "challenge") socket.send(captured);
        if (frame.t === "welcome") {
          welcomed = true;
          socket.close();
        }
      });
      socket.on("error", () => {});
      socket.on("close", (code) => resolve({ code, welcomed }));
    },
  );
  assert.equal(
    replay.welcomed,
    false,
    "a captured hello was replayed into a session",
  );
  assert.equal(replay.code, CLOSE_AUTH_FAILED);
  // The ticket was never spent by any of that, so the honest dial
  // it belongs to still works.
  assert.equal(
    await consumeTicket(listener.tickets, ticket, "A"),
    true,
    "the impostor burned a ticket it never held",
  );
});

it("tickets are bound to the path they were minted for: a LAN ticket presented on a tunnel-borne connection is refused", async () => {
  const listener = await startDirectListener(trackTest);
  // Minted for a LAN candidate, then presented on a connection that
  // arrives the way the cloudflared connector delivers one
  // (loopback carrying CF-Connecting-IP). A machine squatting the
  // advertised LAN address is off the host's own network, so the
  // tunnel is its only route to the real listener: refusing the
  // cross-path redemption is what denies it the relay.
  const lanTicket = mintTicket(listener.tickets, "A", "lan");
  const crossPath = await rawHeaderDial(
    listener.port,
    lanTicket,
    "203.0.113.9",
  );
  assert.equal(
    crossPath.welcomed,
    false,
    "a LAN ticket authed through the tunnel path",
  );
  assert.equal(crossPath.code, CLOSE_AUTH_FAILED);
  // Refused, not consumed: the honest LAN dial it was minted for is
  // untouched by someone else's failed attempt.
  assert.equal(
    await consumeTicket(listener.tickets, lanTicket, "A", "lan"),
    true,
    "a cross-path attempt spent the ticket it failed to redeem",
  );
});

it("loopback lockout identity: the ticket listener keys lockout on CF-Connecting-IP for loopback connections, so one hostile identity cannot bench another's dial", async () => {
  const listener = await startDirectListener(trackTest);
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
  // VALID ticket (never presented, so it stays live). Minted
  // "tunnel" because that is what a loopback connection carrying
  // CF-Connecting-IP arrives as, which is the whole point of this
  // scenario: these dials stand in for the cloudflared connector.
  const lockedTicket = mintTicket(listener.tickets, "A", "tunnel");
  const locked = await rawHeaderDial(
    listener.port,
    lockedTicket,
    "198.51.100.7",
  );
  assert.equal(locked.welcomed, false, "a locked-out identity authed");
  // A DISTINCT code from the five bad-ticket refusals above. The
  // host is the only side that can tell "your credential is wrong"
  // from "you are benched for 30s", and this dial is the proof it
  // must: the ticket here is VALID and was never even read.
  assert.equal(
    locked.code,
    CLOSE_AUTH_LOCKED_OUT,
    "the lockout refusal was indistinguishable from a bad ticket",
  );
  assert.equal(
    await consumeTicket(listener.tickets, lockedTicket, "A", "tunnel"),
    true,
    "the lockout refusal spent the valid ticket it never read",
  );
  // A DIFFERENT identity over the same loopback path dials fine:
  // under remoteAddress keying both would share one 127.0.0.1
  // bucket and this dial would be benched too.
  const freshTicket = mintTicket(listener.tickets, "A", "tunnel");
  const other = await rawHeaderDial(listener.port, freshTicket, "198.51.100.8");
  assert.equal(
    other.welcomed,
    true,
    "an innocent identity was benched by another identity's lockout",
  );
});

it("deadline: a peer that never answers the ask cannot hang the bridge cache, whose attempt rejects typed within the budget, an invoke joins the in-flight dial's fate, and with nothing cached an invoke refuses at once instead of dialing", async () => {
  const stub = await startStubHub(trackTest);
  // B is a raw socket on the stub that NEVER answers (a wedged
  // peer).
  const wedged = new WsClient(
    `ws://127.0.0.1:${stub.port}/connect?ticket=t:B:1`,
  );
  trackTest(() => wedged.close());
  await new Promise((resolve) => wedged.once("open", resolve));
  const client = await bootDevice(stub, "A", {}, trackTest);
  const { bridge } = makeDirectBridge(client, { deadlineMs: 400 });
  const startedAt = Date.now();
  // Direct or nothing: the unanswered ask means the peer is
  // unreachable for data. An invoke arriving while the dial is in
  // flight joins it (the seamless boot race) and shares its typed
  // deadline rejection instead of hanging every consumer.
  const dialing = bridge.dialPeer("B");
  await assert.rejects(
    async () => invokeB(bridge, "test:echo", "hung peer"),
    /did not answer within/,
  );
  await assert.rejects(() => dialing, /did not answer within/);
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < 3000,
    `the unanswered ask was not bounded by the deadline (${elapsed}ms)`,
  );
  assert.deepEqual(bridge.directPeerVersions(), {});
  // The failed dial dropped its cache entry (no poisoning), and a
  // bare invoke against the empty slot refuses at once WITHOUT
  // dialing: the keeper is the only dial trigger, so no user
  // action or renderer retry loop can pace attempts against a
  // wedged peer.
  const baseline = stub.receivedCount();
  const retryStartedAt = Date.now();
  await assert.rejects(
    async () => invokeB(bridge, "test:echo", "retry"),
    /no direct connection to B/,
  );
  assert.ok(
    Date.now() - retryStartedAt < 200,
    "the sessionless invoke did not refuse at once",
  );
  assert.equal(
    stub.receivedCount(),
    baseline,
    "a sessionless invoke started a dial (hub traffic seen)",
  );
});

it("ticket single-use and expiry: a replayed ticket and an expired ticket are refused with the auth-failure code", async () => {
  const listener = await startDirectListener(trackTest, {
    ticketOpts: { ttlMs: 80 },
  });
  const ticket = mintTicket(listener.tickets, "A");
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
  const stale = mintTicket(listener.tickets, "A");
  await delay(150);
  await assert.rejects(
    () => dialWith(listener.port, stale),
    (error) =>
      error instanceof RemoteConnectError && error.code === CLOSE_AUTH_FAILED,
    "an expired ticket authenticated",
  );
});

it("per-peer ticket bookkeeping: one peer's mint replaces only its own set, siblings in a set stay independently consumable, and the backstop refuses instead of evicting", async () => {
  const store = createConnectTicketStore();
  // Siblings of one candidate-set are independent: consuming one
  // must not spend the others (the old single-ticket design burned
  // the whole dial on the first candidate that reached the host).
  const a = mintTickets(store, "A", 3);
  assert.equal(a.length, 3);
  assert.equal(await consumeTicket(store, entryAt(a, 0), "A"), true);
  assert.equal(await consumeTicket(store, entryAt(a, 1), "A"), true);
  // Another peer's mint leaves A's remaining ticket alone.
  const b = mintTickets(store, "B", 2);
  assert.equal(await consumeTicket(store, entryAt(a, 2), "A"), true);
  assert.equal(await consumeTicket(store, entryAt(b, 0), "B"), true);
  // A's own re-mint REPLACES its previous set: only the freshest
  // dial holds live tickets.
  const a1 = mintTickets(store, "A", 2);
  const a2 = mintTickets(store, "A", 2);
  assert.equal(
    await consumeTicket(store, entryAt(a1, 0), "A"),
    false,
    "a replaced ticket authed",
  );
  assert.equal(await consumeTicket(store, entryAt(a2, 0), "A"), true);
  // The global backstop refuses the overflowing mint outright and
  // never evicts another peer's pending tickets (an eviction would
  // feed the per-IP lockout against the innocent peer's dial).
  const keeper = mintTickets(store, "keeper", 2);
  for (let i = 0; i < 200; i += 1) mintTickets(store, `peer-${i}`, 1);
  assert.equal(
    store.mint(
      "overflow",
      Array.from({ length: 60 }, () => "lan"),
    ),
    null,
  );
  assert.equal(await consumeTicket(store, entryAt(keeper, 0), "keeper"), true);
});

it("identity binding: a ticket minted for one device refuses another, and a wrong expected welcome identity fails the handshake", async () => {
  const listener = await startDirectListener(trackTest);
  // The ticket is bound to A, the hello claims C. No identity pin:
  // the refusal under test is the listener's, not the client's.
  const wrongPeer = mintTicket(listener.tickets, "A");
  await assert.rejects(
    () =>
      dialWith(listener.port, wrongPeer, {
        localDeviceId: "C",
        expectedDeviceId: undefined,
      }),
    (error) =>
      error instanceof RemoteConnectError && error.code === CLOSE_AUTH_FAILED,
    "a ticket bound to another device authenticated",
  );
  // The welcome names B. A dial pinned to another identity must
  // fail and close rather than cache the wrong machine.
  const ticket = mintTicket(listener.tickets, "A");
  await assert.rejects(
    () => dialWith(listener.port, ticket, { expectedDeviceId: "X" }),
    (error) =>
      error instanceof RemoteConnectError &&
      error.blocked &&
      /unexpected device/.test(error.message),
    "a welcome from the wrong device passed the identity pin",
  );
});

it("grant gate on the direct wire: mutating refused with the typed error pre-grant and the handler never runs, served post-grant, revoked live on the same socket", async () => {
  const listener = await startDirectListener(trackTest);
  const connection = await dialWith(
    listener.port,
    mintTicket(listener.tickets, "A"),
  );
  trackTest(() => connection.close());
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
  // Reads are served with the switch off.
  assert.equal(await connection.transport.invoke("test:echo", "read"), "read");
  // Grant: the SAME socket serves the mutation, no reconnect.
  listener.setAccepts(true);
  assert.equal(
    await connection.transport.invoke("test:mutate", undefined),
    "mutated",
  );
  assert.equal(listener.mutateRuns(), 1);
  // Revoke: takes effect live at the next dispatch.
  listener.setAccepts(false);
  await assert.rejects(
    () => connection.transport.invoke("test:mutate", undefined),
    (error) => error instanceof CommandRefusedError,
    "a revoke did not take effect without a reconnect",
  );
  assert.equal(listener.mutateRuns(), 1);
});

it("supersede kills the old socket dead: nothing it delivers after the supersede executes a handler", async () => {
  const listener = await startDirectListener(trackTest);
  listener.setAccepts(true);
  const first = await dialWith(
    listener.port,
    mintTicket(listener.tickets, "A"),
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
    mintTicket(listener.tickets, "A"),
  );
  trackTest(() => second.close());
  await assert.rejects(
    () => first.transport.invoke("test:mutate", undefined),
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
});

it("one round trip: a winning dial costs the device hub exactly one ask and one answer, and data then flows direct with the hub quiet", async () => {
  const stub = await startStubHub(trackTest);
  const listener = await startDirectListener(trackTest);
  const { client } = await bootPair(stub, trackTest, listener);
  const { bridge } = makeDirectBridge(client);
  trackTest(() => bridge.closeDirectPeers());
  const before = stub.receivedCount();
  await bridge.dialPeer("B");
  const exchange = stub.received.slice(before);
  assert.deepEqual(
    exchange.map((entry) => `${entry.from}>${entry.to}`),
    ["A>B", "B>A"],
    "the dial was not one ask and one answer",
  );
  const [ask, answer] = exchange;
  assert.ok(
    ask !== undefined && answer !== undefined,
    "the ask and its answer were not both received",
  );
  assert.equal(AskFrameSchema.parse(ask.frame).ask, CONNECT_INFO_ASK);
  assert.equal(AnswerFrameSchema.parse(answer.frame).ok, true);
  const baseline = stub.forwardedCount();
  assert.equal(await invokeB(bridge, "test:echo", "direct"), "direct");
  await delay(150);
  assert.equal(
    stub.forwardedCount(),
    baseline,
    "post-dial traffic still rode the device hub",
  );
});

it("presence scopes the data plane: a peer leaving a LIVE roster loses its direct sessions on both sides, our own hub link going down leaves them alone, and a stopped or revoked socket closes them all", async () => {
  const CONNECTED: SupervisorStatus = {
    phase: "connected",
    remoteDeviceId: "",
    remoteAppVersion: "",
  };
  const stub = await startStubHub(trackTest);
  const listener = await startDirectListener(trackTest);
  const { client } = await bootPair(stub, trackTest, listener);
  const { bridge } = makeDirectBridge(client);
  trackTest(() => bridge.closeDirectPeers());
  const reconcileCalls: string[][] = [];
  const presenceDeps: DirectPresenceDeps = {
    closeHostPeersNotIn: (online) => listener.binding.closePeersNotIn(online),
    dropClientPeersNotIn: (online) => bridge.dropDirectPeersNotIn(online),
    reconcilePeers: (online) => reconcileCalls.push([...online]),
  };
  await bridge.dialPeer("B");
  assert.deepEqual(await invokeB(bridge, "test:echo", "up"), "up");
  assert.deepEqual(Object.keys(bridge.directPeerVersions()), ["B"]);
  // Our own hub link down (no live roster): the working direct
  // session must survive an device-hub outage, but the keeper
  // reconciles to EMPTY (its schedule is useless without the
  // connectInfo ask) so the post-reconnect roster reads as all-new
  // peers and redials whatever the outage cost, parked peers
  // included.
  applyDirectPresence(
    { phase: "backoff", attempt: 1, delayMs: 1 },
    [],
    presenceDeps,
  );
  assert.deepEqual(
    reconcileCalls.at(-1),
    [],
    "a hub-down reconcile did not empty the keeper's desired set",
  );
  assert.deepEqual(Object.keys(bridge.directPeerVersions()), ["B"]);
  assert.deepEqual(await invokeB(bridge, "test:echo", "outage"), "outage");
  // A live roster still naming the peer: nothing closes, and the
  // keeper receives the roster as its desired set.
  applyDirectPresence(CONNECTED, ["A", "B"], presenceDeps);
  assert.deepEqual(Object.keys(bridge.directPeerVersions()), ["B"]);
  assert.deepEqual(reconcileCalls.at(-1), ["A", "B"]);
  // The peer leaves the live roster: the cached client session
  // drops at once.
  applyDirectPresence(CONNECTED, ["A"], presenceDeps);
  assert.deepEqual(bridge.directPeerVersions(), {});
  // Host side: an inbound authed direct socket dies when ITS
  // deviceId leaves the roster, and survives while present.
  let hostSideClosed = false;
  const inbound = await dialWith(
    listener.port,
    mintTicket(listener.tickets, "A"),
    { onClose: () => (hostSideClosed = true) },
  );
  applyDirectPresence(CONNECTED, ["A"], presenceDeps);
  assert.equal(
    await inbound.transport.invoke("test:echo", "still here"),
    "still here",
  );
  applyDirectPresence(CONNECTED, [], presenceDeps);
  await waitFor(
    () => hostSideClosed,
    "the off-roster peer's host-side socket to close",
  );
  // A stopped socket (sign-out, account switch) is not an outage:
  // this device has no account, so every session closes on both
  // sides even though the stale link may still report a roster,
  // and the keeper's desired set empties.
  await bridge.dialPeer("B");
  assert.deepEqual(Object.keys(bridge.directPeerVersions()), ["B"]);
  let inboundClosed = false;
  const inbound2 = await dialWith(
    listener.port,
    mintTicket(listener.tickets, "A"),
    { onClose: () => (inboundClosed = true) },
  );
  assert.equal(
    await inbound2.transport.invoke("test:echo", "before stop"),
    "before stop",
  );
  applyDirectPresence({ phase: "stopped" }, ["A", "B"], presenceDeps);
  assert.deepEqual(bridge.directPeerVersions(), {});
  assert.deepEqual(reconcileCalls.at(-1), []);
  await waitFor(
    () => inboundClosed,
    "a stopped socket to close the host-side sockets",
  );
  // A revoked block is the same verdict from the hub's side.
  await bridge.dialPeer("B");
  assert.deepEqual(Object.keys(bridge.directPeerVersions()), ["B"]);
  applyDirectPresence(
    { phase: "blocked", reason: "revoked", message: "removed" },
    ["B"],
    presenceDeps,
  );
  assert.deepEqual(bridge.directPeerVersions(), {});
  // Any other block is an outage: the sessions ride it out.
  await bridge.dialPeer("B");
  applyDirectPresence(
    { phase: "blocked", reason: "refused", message: "401" },
    [],
    presenceDeps,
  );
  assert.deepEqual(Object.keys(bridge.directPeerVersions()), ["B"]);
});

it("mid-dial sweeps: a peer leaving the roster while its dial is in flight has the completed session closed on arrival and never reported, and the quit sweep closes an in-flight dial's socket too", async () => {
  // Roster sweep: the peer leaves (revocation included) while its
  // dial is still in flight. The completing session must not be
  // installed for a device the control plane stopped vouching for.
  const sweep = heldDial();
  const ensure = sweep.handlers.dialPeer("B");
  sweep.handlers.dropDirectPeersNotIn([]);
  sweep.release();
  await ensure;
  assert.equal(
    sweep.closed(),
    1,
    "the session completing after the roster sweep was not closed",
  );
  assert.deepEqual(sweep.handlers.directPeerVersions(), {});
  assert.equal(sweep.changes(), 0, "an orphan session fired onDirectChange");
  // Quit sweep: closeDirectPeers with a dial still in flight must
  // close the resulting socket instead of leaking it past quit.
  const quit = heldDial();
  const quitEnsure = quit.handlers.dialPeer("B");
  quit.handlers.closeDirectPeers();
  quit.release();
  await quitEnsure;
  assert.equal(
    quit.closed(),
    1,
    "the quit sweep left the in-flight dial's socket open",
  );
  assert.deepEqual(quit.handlers.directPeerVersions(), {});
});

it("supervised and eager: presence alone establishes the session (no invoke anywhere), a host-side drop is redialed by the keeper on the shared ladder, and quit's stop() latches the schedule", async () => {
  const stub = await startStubHub(trackTest);
  const listener = await startDirectListener(trackTest);
  // The plane's presence path wired to the client connection
  // exactly as production wires it (late-bound plus one catch-up
  // call), with the keeper on a TestClock so the ladder is
  // advanced by hand instead of slept out.
  let onPlaneChange: (() => void) | null = null;
  const { client } = await bootPair(stub, trackTest, listener, {
    clientOnChange: () => onPlaneChange?.(),
  });
  const clock = testClock();
  const { plane, bridge } = makeDirectBridge(client, {
    keeper: { context: clock.context },
  });
  trackTest(() => bridge.closeDirectPeers());
  onPlaneChange = () => plane.handleConnectionChange();
  plane.handleConnectionChange();
  // Presence alone: the roster names B, so the keeper dials it
  // with no invoke and no ensure in sight.
  await waitFor(
    () => bridge.directPeerVersions().B !== undefined,
    "the keeper to establish the session off presence alone",
  );
  assert.deepEqual(bridge.directPeerVersions(), { B: "2.0.0" });
  // The established direct socket dies out from under the client
  // (the host closes it), and the cache drops the session.
  listener.binding.closePeersNotIn([]);
  await waitFor(
    () => Object.keys(bridge.directPeerVersions()).length === 0,
    "the dropped session to leave the cache",
  );
  // Nothing redials before the ladder's first rung...
  await clock.settle();
  assert.deepEqual(bridge.directPeerVersions(), {});
  // ...and the keeper redials at it, with no ensure/invoke: the
  // drop was a self-close, so supervision owns the recovery.
  await clock.advance(BACKOFF_LADDER_MS[0]);
  await waitFor(
    () => bridge.directPeerVersions().B !== undefined,
    "the keeper to redial the dropped session",
  );
  assert.deepEqual(
    await invokeB(bridge, "test:echo", "recovered"),
    "recovered",
  );
  // Quit: stop() is BOTH halves in the order that matters (latch,
  // then close every cached session), so the cache empties on the
  // call and nothing a drop or a pending timer does afterwards can
  // dial a fresh session into the teardown.
  plane.stop();
  assert.deepEqual(bridge.directPeerVersions(), {});
  listener.binding.closePeersNotIn([]);
  await clock.advance(lastOf(BACKOFF_LADDER_MS) * 4);
  await delay(50);
  assert.deepEqual(
    bridge.directPeerVersions(),
    {},
    "a latched keeper still redialed after stop()",
  );
});

it("command access on the answer and live: the connectInfo answer's switch lands in the bridge's snapshot, the host's flips reach it as pushes over the SAME direct session, and a redial's answer carries the switch as it stands", async () => {
  const stub = await startStubHub(trackTest);
  const listener = await startDirectListener(trackTest);
  const { client } = await bootPair(stub, trackTest, listener);
  const snapshots: HubStatus[] = [];
  const { plane, bridge } = makeDirectBridge(client, {
    onStatusChange: (status) => snapshots.push(status),
  });
  trackTest(() => plane.stop());
  await bridge.dialPeer("B");
  // Off at dial time: the answer said so, before any call.
  assert.deepEqual(bridge.directPeerAccess(), { B: false });
  assert.deepEqual(plane.status().peerAcceptsCommands, { B: false });
  // On: the host's push moves the snapshot, and fans it out.
  const fannedBefore = snapshots.length;
  listener.setAccepts(true);
  await waitFor(
    () => bridge.directPeerAccess().B === true,
    "the switch-on push to reach the bridge",
  );
  assert.ok(
    snapshots
      .slice(fannedBefore)
      .some((status) => status.peerAcceptsCommands.B === true),
    "the flip never fanned a fresh status out",
  );
  // The gate agrees with what the snapshot says.
  assert.equal(await invokeB(bridge, "test:mutate"), "mutated");
  // Off again, live on the same socket, and the gate refuses.
  listener.setAccepts(false);
  await waitFor(
    () => bridge.directPeerAccess().B === false,
    "the switch-off push to reach the bridge",
  );
  await assert.rejects(
    async () => invokeB(bridge, "test:mutate"),
    (error) => error instanceof CommandRefusedError,
  );
  // A fresh dial reads the switch off its answer again.
  listener.setAccepts(true);
  bridge.closeDirectPeers();
  assert.deepEqual(bridge.directPeerAccess(), {});
  await bridge.dialPeer("B");
  assert.deepEqual(bridge.directPeerAccess(), { B: true });
});

it("routing: the cache is direct or nothing, directPeerVersions reports the direct session, and a closed direct socket drops the cache, refuses sessionless invokes and rejects typed on the next dial", async () => {
  const stub = await startStubHub(trackTest);
  const listener = await startDirectListener(trackTest);
  const { client } = await bootPair(stub, trackTest, listener);
  // The plane fans a status snapshot out on every direct open and
  // close (the same statusChanged fan-out a device hub transition
  // fires), so the counter reads that seam.
  let directChanges = 0;
  const { bridge } = makeDirectBridge(client, {
    onStatusChange: () => {
      directChanges += 1;
    },
  });
  trackTest(() => bridge.closeDirectPeers());
  // Direct available: the keeper-shaped dial establishes the
  // session, and invokes ride it leaving the device hub flat.
  await bridge.dialPeer("B");
  assert.deepEqual(await invokeB(bridge, "test:echo", { n: 1 }), { n: 1 });
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
  assert.deepEqual(await invokeB(bridge, "test:echo", { n: 2 }), { n: 2 });
  assert.equal(
    stub.forwardedCount(),
    baseline,
    "a cached direct session still rode the device hub",
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
  // A sessionless invoke refuses at once and dials nothing: the
  // keeper owns dialing, so use cannot be a trigger.
  await assert.rejects(
    async () => invokeB(bridge, "test:echo", { n: 3 }),
    /no direct connection to B/,
  );
  // The keeper's next dial re-decides: the host answers
  // unavailable now and there is nothing to fall back to, so the
  // attempt rejects with the typed unreachable outcome and the
  // cache stays empty.
  await assert.rejects(() => bridge.dialPeer("B"), /offers no direct listener/);
  assert.deepEqual(bridge.directPeerVersions(), {});
});

it("unreachable is typed: a failed direct dial rejects the invoke with the dial error and creates no hub data session", async () => {
  const stub = await startStubHub(trackTest);
  const listener = await startDirectListener(trackTest);
  // Free the port, then keep ADVERTISING it: the host hands out
  // tickets and a port nobody listens on, so the dial itself fails
  // and the failure is the outcome (direct or nothing).
  const deadPort = listener.port;
  await listener.binding.stop();
  listener.listenerPort = () => deadPort;
  const { client } = await bootPair(stub, trackTest, listener);
  const { bridge } = makeDirectBridge(client, { deadlineMs: 1500 });
  const before = stub.receivedCount();
  // An invoke racing the in-flight dial shares its typed fate.
  const dialing = bridge.dialPeer("B");
  await assert.rejects(
    async () => invokeB(bridge, "test:echo", "unreachable"),
    // Typed pin: a dead advertised port fails the candidate's
    // socket, so the dial error is the connect error itself, not
    // some incidental throw.
    (error) => error instanceof RemoteConnectError,
  );
  await assert.rejects(
    () => dialing,
    (error) =>
      error instanceof RemoteConnectError &&
      // The exhaustion message names the candidate and, through
      // the ws socket main injects, the errno itself, which is
      // what makes a failed dial diagnosable on the account page.
      /lan ws:\/\/.*ECONNREFUSED/.test(error.message),
  );
  assert.deepEqual(bridge.directPeerVersions(), {});
  // Nothing rode the device hub for the data: the one ask and its
  // answer, and after them nothing from A reaches B through it.
  assert.equal(stub.receivedCount() - before, 2);
  const baseline = stub.receivedCount();
  await delay(200);
  assert.equal(
    stub.receivedCount(),
    baseline,
    "something kept riding the device hub after the failed dial",
  );
});

it("pushes: a host broadcast reaches a direct-connected client through the shared peerPush path, tagged with the peer's deviceId", async () => {
  const stub = await startStubHub(trackTest);
  const listener = await startDirectListener(trackTest);
  const { client } = await bootPair(stub, trackTest, listener);
  const pushes: HubPeerPush[] = [];
  const { bridge } = makeDirectBridge(client, {
    onPeerPush: (push) => pushes.push(push),
  });
  trackTest(() => bridge.closeDirectPeers());
  // A keeper-shaped dial and nothing else: the session comes up
  // with no invoke, then the host's fan-out reaches it over the
  // direct socket.
  await bridge.dialPeer("B");
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
    "the push rode the device hub instead of the direct socket",
  );
});

it("tunnel advertising: connectInfo carries a tunnel-kind candidate with its own ticket exactly while the tunnel reports healthy, and omits it otherwise", async () => {
  let tunnel: string | null = null;
  const minted: string[][] = [];
  const connectInfo = makeConnectInfo({
    listenerPort: () => 42017,
    mintTickets: (_peer, kinds) => {
      const tickets = kinds.map((_kind, i) => `smpt_${minted.length}_${i}`);
      minted.push(tickets);
      return tickets;
    },
    candidateAddresses: () => ["127.0.0.1", "fd00::1"],
    tunnelUrl: () => tunnel,
    acceptsCommands: () => false,
  });
  const all = { dialableKinds: ["lan", "tunnel"] };
  // Unhealthy tunnel: lan candidates only, with IPv6 literals
  // bracketed into dialable URLs.
  const without = connectInfo("A", all);
  assert.equal(without.available, true);
  // Beside the candidates, the host's command-access switch.
  assert.equal(without.acceptsCommands, false);
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
  const withTunnel = connectInfo("A", all);
  assert.equal(withTunnel.available, true);
  assert.deepEqual(withTunnel.candidates.at(-1), {
    kind: "tunnel",
    url: tunnel,
    ticket: minted[1]?.at(-1),
  });
  assert.deepEqual(
    withTunnel.candidates.map(({ ticket }) => ticket),
    minted[1],
    "the candidate tickets drifted from the minted set",
  );
  // A tunnel with NO interface addresses still advertises: data
  // is direct or nothing, so a host reachable only through its
  // tunnel must stay dialable.
  const only = makeConnectInfo({
    listenerPort: () => 42017,
    mintTickets: (_peer, kinds) => kinds.map((_kind, i) => `smpt_only_${i}`),
    candidateAddresses: () => [],
    tunnelUrl: () => tunnel,
    acceptsCommands: () => false,
  })("A", all);
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
  const tunnelOnly = connectInfo("A", { dialableKinds: ["tunnel"] });
  assert.equal(tunnelOnly.available, true);
  assert.deepEqual(
    tunnelOnly.candidates.map(({ kind }) => kind),
    ["tunnel"],
  );
  assert.equal(minted.length, before + 1);
  assert.equal(minted.at(-1)?.length, 1, "a lan ticket was minted anyway");
  const lanOnly = connectInfo("A", { dialableKinds: ["lan"] });
  assert.equal(lanOnly.available, true);
  assert.deepEqual(
    lanOnly.candidates.map(({ kind }) => kind),
    ["lan", "lan"],
  );
  tunnel = null;
  const nothing = connectInfo("A", { dialableKinds: ["tunnel"] });
  const mintsSoFar = minted.length;
  assert.deepEqual(nothing, { available: false });
  assert.equal(
    minted.length,
    mintsSoFar,
    "a ticket was minted for an undialable caller",
  );
});

it("dialableKinds (the web path): the declared capability reaches the host over the wire, which mints only the tunnel ticket, and a tunnel-less peer is the plain unreachable outcome", async () => {
  const stub = await startStubHub(trackTest);
  const listener = await startDirectListener(trackTest);
  // A well-formed but unroutable tunnel hostname: a check cannot
  // stand up a real wss endpoint (the no-port invariant pins the
  // tunnel to 443), so this scenario pins the BROKER half (what
  // was minted) and the failure outcome, while the race mechanics
  // are pinned by the lan scenarios above through the same code
  // path.
  const minted: string[][] = [];
  const { client } = await bootPair(stub, trackTest, listener, {
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
  // The dial cannot succeed (unroutable hostname), so the attempt
  // rejects as unreachable: direct or nothing. Typed pin: the
  // failed candidate socket surfaces as the connect error.
  await assert.rejects(
    () => bridge.dialPeer("B"),
    (error) => error instanceof RemoteConnectError,
  );
  assert.deepEqual(bridge.directPeerVersions(), {});
  // The host saw the caller's capability and minted ONE ticket
  // (the tunnel's), never a lan ticket to burn and abandon.
  assert.equal(minted.length, 1, "expected exactly one mint");
  assert.equal(
    minted[0]?.length,
    1,
    "the host minted lan tickets for a tunnel-only caller",
  );
  // A tunnel-less host answers a tunnel-only caller
  // available:false and mints nothing: the plain unreachable
  // outcome, distinguishable from the structural verdicts below.
  const bare = await startDirectListener(trackTest);
  const bareMinted: string[][] = [];
  const stub2 = await startStubHub(trackTest);
  const pair2 = await bootPair(stub2, trackTest, bare, {
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
    () => bareBridge.dialPeer("B"),
    /offers no direct listener/,
    "a kind-filtered empty answer was not the plain unavailable outcome",
  );
  assert.equal(bareMinted.length, 0, "an undialable caller minted tickets");
});

it("the terminal classification covers exactly the verdicts a redial cannot change", async () => {
  // The park-vs-retry line the keeper consumes: a blocked verdict
  // (ticket presented and refused, wrong identity) and no listener
  // park. Everything transient
  // (unreachable, deadline, no listener yet) retries on the
  // ladder. Misclassifying a transient as terminal would strand a
  // peer whose tunnel was merely still starting, and the reverse
  // would feed the host's failed-auth lockout.
  assert.equal(isTerminalDialError(new NoDialableCandidateError("B")), true);
  assert.equal(
    isTerminalDialError(
      new RemoteConnectError("ticket refused", CLOSE_AUTH_FAILED, true),
    ),
    true,
  );
  assert.equal(
    isTerminalDialError(
      new RemoteConnectError("connect refused pre-hello", null, false),
    ),
    false,
  );
  assert.equal(
    isTerminalDialError(new Error("peer B offers no direct listener")),
    false,
  );
  assert.equal(
    isTerminalDialError(new HubAskRefusedError("boom", undefined)),
    false,
  );
});

it("a listener-less peer is a TERMINAL verdict: the browser binding's no-listener answer yields NoDialableCandidateError and PARKS, while a peer whose server merely threw stays on the ladder", async () => {
  const stub = await startStubHub(trackTest);
  // B is the REAL browser binding (web/hub/connection.ts), which
  // supplies no connectInfo server, so every ask comes back as the
  // no-listener refusal. The real binding rather than a stub,
  // because the thing under test is exactly what that binding puts
  // on the wire when a desktop dials a browser tab. C is a node
  // peer whose server THREW (mid-boot, a transient failure of one
  // call). Both fail the same dial, and telling them apart is the
  // point: eager supervision would otherwise redial every open
  // browser tab in the roster at the ladder's cap forever.
  await bootDevice(
    stub,
    "B",
    { createConnection: createWebConnection, label: "web B" },
    trackTest,
  );
  await bootDevice(
    stub,
    "C",
    {
      serveConnectInfo: () => {
        throw new Error("listener still starting");
      },
    },
    trackTest,
  );
  const a = await bootDevice(stub, "A", {}, trackTest);
  await waitFor(
    () =>
      a.connection.status().onlineDeviceIds.includes("B") &&
      a.connection.status().onlineDeviceIds.includes("C"),
    "the roster to name both peers",
  );
  const { bridge } = makeDirectBridge(a, { deadlineMs: 3000 });
  let verdict: unknown;
  await assert.rejects(
    () => bridge.dialPeer("B"),
    (error) => {
      verdict = error;
      return error instanceof NoDialableCandidateError;
    },
    "a listener-less peer did not yield the structural terminal verdict",
  );
  assert.ok(verdict instanceof NoDialableCandidateError);
  // The message says which shape it was, since the keeper hands it
  // to the UI as the peer's unavailable reason.
  assert.match(verdict.message, /serves no direct listener/);
  assert.equal(isTerminalDialError(verdict), true);
  // The discriminator is the no-listener CODE, never "the ask was
  // refused": a server that threw is one bad call, so it keeps its
  // place on the ladder.
  await assert.rejects(
    () => bridge.dialPeer("C"),
    (error) => {
      assert.equal(
        isTerminalDialError(error),
        false,
        "a thrown connectInfo server was misread as structural and parked",
      );
      return true;
    },
  );
  // Parked with no timer, and the roster round trip is the only
  // thing that redials it -- the right lifecycle for a tab that
  // may later become a host.
  const { keeper, clock, dials } = stubKeeper(verdict);
  keeper.reconcile(["B"]);
  await clock.settle();
  assert.equal(dials.length, 1);
  await clock.advance(lastOf(BACKOFF_LADDER_MS) * 100);
  assert.equal(dials.length, 1, "a listener-less peer redialed on the ladder");
  keeper.reconcile([]);
  keeper.reconcile(["B"]);
  await clock.settle();
  assert.equal(dials.length, 2, "the roster round trip did not redial");
  keeper.stop();
});

it("keeper discipline: eager dial on roster entry, the exact shared ladder on transient failures (capped, forever), roster exit cancels, and a stable session's drop resets the ladder", async () => {
  const { keeper, clock, dials, succeed } = stubKeeper(
    new Error("listener down"),
  );
  // Eager: the peer entering the roster dials at once, and a
  // steady roster re-fed dials nothing new.
  keeper.reconcile(["B"]);
  await clock.settle();
  assert.equal(dials.length, 1);
  assert.deepEqual(dials[0], { deviceId: "B", at: 0 });
  keeper.reconcile(["B"]);
  await clock.settle();
  assert.equal(dials.length, 1, "a steady roster re-dialed");
  // Transient failures walk the EXACT shared ladder and cap at its
  // top forever (the forever-retry rule).
  const expected = [
    ...BACKOFF_LADDER_MS,
    ...Array<number>(3).fill(lastOf(BACKOFF_LADDER_MS)),
  ];
  for (const [i, delayMs] of expected.entries()) {
    const before: number = dials.length;
    // oxlint-disable-next-line no-await-in-loop -- the ladder is sequential by nature
    await clock.advance(delayMs - 1);
    assert.equal(dials.length, before, `rung ${i} fired early`);
    // oxlint-disable-next-line no-await-in-loop -- the ladder is sequential by nature
    await clock.advance(1);
    assert.equal(dials.length, before + 1, `rung ${i} never fired`);
  }
  // The keeper's last failure is the no-session explanation the
  // bridge folds into its refusal.
  assert.equal(keeper.unavailableReason("B"), "listener down");
  // Roster exit cancels the schedule outright.
  keeper.reconcile([]);
  await clock.advance(lastOf(BACKOFF_LADDER_MS) * 4);
  const settled = dials.length;
  assert.equal(settled, 1 + expected.length, "a swept peer kept dialing");
  // Re-entry starts fresh at the bottom rung: dial now, and a
  // failure waits ladder[0], not the inherited cap.
  keeper.reconcile(["B"]);
  await clock.settle();
  assert.equal(dials.length, settled + 1);
  await clock.advance(BACKOFF_LADDER_MS[0]);
  assert.equal(dials.length, settled + 2, "re-entry inherited the old ladder");
  // A session that connects and stays up past the stable threshold
  // resets the ladder: its drop redials at the bottom rung.
  succeed();
  await clock.advance(entryAt(BACKOFF_LADDER_MS, 1));
  const connectedAt = dials.length;
  assert.equal(connectedAt, settled + 3);
  assert.equal(keeper.unavailableReason("B"), null);
  await clock.advance(STABLE_CONNECTION_MS);
  keeper.peerDropped("B");
  await clock.advance(BACKOFF_LADDER_MS[0]);
  assert.equal(
    dials.length,
    connectedAt + 1,
    "a stable drop did not redial at the bottom rung",
  );
  // An UNSTABLE drop keeps climbing instead: rung 1 next, so a
  // connect-then-die flapper cannot hammer at the bottom.
  keeper.peerDropped("B");
  await clock.advance(BACKOFF_LADDER_MS[0]);
  assert.equal(
    dials.length,
    connectedAt + 1,
    "an unstable drop redialed at the bottom rung",
  );
  await clock.advance(entryAt(BACKOFF_LADDER_MS, 1) - BACKOFF_LADDER_MS[0]);
  assert.equal(
    dials.length,
    connectedAt + 2,
    "the unstable drop never redialed",
  );
  keeper.stop();
});

it("keeper parks on terminal verdicts with NO timer (the lockout-protection rule), and the peer's roster round trip is what redials it", async () => {
  const { keeper, clock, dials, succeed } = stubKeeper(
    new RemoteConnectError("ticket refused", CLOSE_AUTH_FAILED, true),
  );
  keeper.reconcile(["B"]);
  await clock.settle();
  assert.equal(dials.length, 1);
  // Parked: no amount of time redials a blocked verdict, so eager
  // supervision can never feed the host's failed-auth lockout a
  // second refused ticket on a timer.
  await clock.advance(lastOf(BACKOFF_LADDER_MS) * 100);
  assert.equal(dials.length, 1, "a parked peer redialed on a timer");
  assert.equal(keeper.unavailableReason("B"), "ticket refused");
  // A steady roster does not unpark either...
  keeper.reconcile(["B"]);
  await clock.advance(lastOf(BACKOFF_LADDER_MS));
  assert.equal(dials.length, 1, "a steady roster unparked a blocked peer");
  // ...but the peer's offline-to-online transition does (its app
  // restarted, or our own link came back: both reset the roster
  // diff), and the fresh dial may now succeed.
  succeed();
  keeper.reconcile([]);
  keeper.reconcile(["B"]);
  await clock.settle();
  assert.equal(dials.length, 2, "the roster round trip did not redial");
  assert.equal(keeper.unavailableReason("B"), null);
  keeper.stop();
});

const resolveBinary = (
  configured: string | undefined,
  bundled: string | null,
) =>
  Effect.runPromise(
    resolveCloudflaredBinary(configured, bundled).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );

it("cloudflared deciders are pure and disciplined: the tunnel ladder caps through the supervisor's shared lookup, and the token rides env only, never argv", async () => {
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
  // --no-autoupdate is load-bearing: the shipped copy must never
  // replace its own (signed) binary.
  // --ha-connections trims the edge keepalives to one connection.
  // It is a `tunnel` flag, so it must sit before `run`.
  assert.deepEqual(args, [
    "tunnel",
    "--no-autoupdate",
    "--ha-connections",
    "1",
    "run",
  ]);
  assert.ok(
    args.every((arg) => !arg.includes(token)),
    "the token leaked into argv",
  );
  assert.deepEqual(cloudflaredEnv(token), { TUNNEL_TOKEN: token });
  // Resolution order: the configured override, then the copy the
  // app ships, then PATH. A stand-in that answers --version plays
  // both the override and the bundled copy.
  const fake = join(tmpdir(), `sm-fake-cloudflared-${process.pid}`);
  writeFileSync(fake, "#!/bin/sh\necho fake 0.0.0\n", { mode: 0o755 });
  trackTest(() => rmSync(fake, { force: true }));
  assert.equal(await resolveBinary(undefined, fake), fake);
  assert.equal(
    await resolveBinary(fake, "/nonexistent/cloudflared"),
    fake,
    "the configured override must beat the bundled copy",
  );
  assert.notEqual(
    await resolveBinary(undefined, "/nonexistent/cloudflared"),
    "/nonexistent/cloudflared",
    "a missing bundled copy must fall through, never be returned",
  );
});

// A cloudflared child the stub spawner started: what it was given, and
// `exit` to play it dying. `killed` is its scope closing while it ran.
type StubTunnelChild = {
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined> | undefined;
  killed: boolean;
  exit: () => void;
};

const onTunnel = <A, E>(
  f: (tunnel: Tunnel["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* f(yield* Tunnel);
  });

// Lets the supervision fiber act on what just happened: a few turns of
// the event loop.
const settleTunnel = () =>
  [1, 2, 3, 4, 5, 6, 7, 8].reduce<Promise<void>>(
    (turns) =>
      turns.then(() => new Promise((resolve) => setImmediate(resolve))),
    Promise.resolve(),
  );

// The Tunnel over a stub spawner and a TestClock, with the provision
// and the probe the scenario plays.
async function tunnelHarness(deps: {
  readonly resolveBinary?: () => string | null;
  readonly provision: (port: number) => Promise<TunnelProvision>;
  readonly probe?: (hostname: string) => boolean;
  readonly onChange?: () => void;
}) {
  const spawned: StubTunnelChild[] = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.die("a piped command");
      }
      const exit = yield* Deferred.make<number>();
      const child: StubTunnelChild = {
        args: command.args,
        env: command.options.env,
        killed: false,
        exit: () => Effect.runSync(Deferred.succeed(exit, 1)),
      };
      spawned.push(child);
      yield* Effect.addFinalizer(() =>
        Deferred.isDone(exit).pipe(
          Effect.map((done) => {
            if (!done) child.killed = true;
          }),
        ),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1000 + spawned.length),
        exitCode: Deferred.await(exit).pipe(
          Effect.map(ChildProcessSpawner.ExitCode),
        ),
        isRunning: Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const runtime = ManagedRuntime.make(
    Tunnels.layer({
      resolveBinary: Effect.sync(() =>
        (deps.resolveBinary ?? (() => "/stub/cloudflared"))(),
      ),
      provision: (port) =>
        Effect.tryPromise({
          try: () => deps.provision(port),
          catch: (cause) => new TunnelProvisionError({ cause }),
        }),
      probe: (hostname) =>
        Effect.sync(() => (deps.probe ? deps.probe(hostname) : true)),
      onChange: deps.onChange,
    }).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
      Layer.provide(NodeServices.layer),
      Layer.provide(Logger.layer([])),
      Layer.provideMerge(TestClock.layer()),
    ),
  );
  let disposed = false;
  const dispose = async () => {
    disposed = true;
    await runtime.dispose();
  };
  trackTest(() => (disposed ? undefined : runtime.dispose()));
  await runtime.context();
  return {
    spawned,
    reconcile: async (wanted: { port: number } | null) => {
      await runtime.runPromise(onTunnel((tunnel) => tunnel.reconcile(wanted)));
      await settleTunnel();
    },
    status: () => runtime.runSync(onTunnel((tunnel) => tunnel.status)),
    tunnelUrl: () => runtime.runSync(onTunnel((tunnel) => tunnel.tunnelUrl)),
    advance: async (ms: number) => {
      await runtime.runPromise(TestClock.adjust(ms));
      await settleTunnel();
    },
    dispose,
  };
}

it("cloudflared runner: no-binary and unconfigured are typed terminal states, and the unconfigured verdict is cached for the process lifetime", async () => {
  // Missing binary: reported, and provisioning never even runs.
  let binaryPath: string | null = null;
  let provisions = 0;
  const noBinary = await tunnelHarness({
    resolveBinary: () => binaryPath,
    provision: async () => {
      provisions += 1;
      return { hostname: "h.example.test", connectorToken: "t" };
    },
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
  // a retry, so time passing changes nothing.
  let unconfiguredCalls = 0;
  const unconfigured = await tunnelHarness({
    provision: async () => {
      unconfiguredCalls += 1;
      throw new TunnelUnconfiguredError();
    },
  });
  await unconfigured.reconcile({ port: 40100 });
  assert.equal(unconfigured.status().state, "unconfigured");
  await unconfigured.advance(10 * 60_000);
  assert.equal(
    unconfiguredCalls,
    1,
    "an unconfigured worker was retried on a timer",
  );
  assert.equal(unconfigured.spawned.length, 0, "spawned while unconfigured");
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
});

it("cloudflared runner: the readiness probe gates advertising (a failed attempt retries on the probe ladder), a post-ready crash restarts from the cached provision on the capped backoff, a port change re-provisions, a stop kills the child cleanly, and the token never reaches a status object", async () => {
  const token = "connector-token-must-not-leak";
  const provisionPorts: number[] = [];
  const probeAnswers = [false, true];
  let statusChanges = 0;
  let snapshot: (() => unknown) | null = null;
  const runner = await tunnelHarness({
    provision: async (port) => {
      provisionPorts.push(port);
      return {
        hostname: "sm-feedfacecafe.sm.example.test",
        connectorToken: token,
      };
    },
    probe: (hostname) => {
      assert.equal(hostname, "sm-feedfacecafe.sm.example.test");
      return probeAnswers.shift() ?? true;
    },
    onChange: () => {
      statusChanges += 1;
      // The secret must never surface on ANY observable snapshot.
      assert.ok(
        !JSON.stringify(snapshot?.()).includes(token),
        "the connector token leaked into a status object",
      );
    },
  });
  snapshot = runner.status;
  const { spawned } = runner;
  await runner.reconcile({ port: 40100 });
  assert.deepEqual(provisionPorts, [40100]);
  assert.equal(spawned.length, 1);
  // The token rides the child's env, never its argv.
  assert.equal(entryAt(spawned, 0).env?.["TUNNEL_TOKEN"], token);
  assert.ok(entryAt(spawned, 0).args.every((arg) => !arg.includes(token)));
  // Probing: starting, NOT advertised yet.
  assert.equal(runner.status().state, "starting");
  assert.equal(runner.tunnelUrl(), null);
  // First probe attempt answers not-routable: still starting, the
  // chain retries on the next rung instead of advertising.
  await runner.advance(TUNNEL_PROBE_DELAYS_REUSED_MS[0]);
  assert.equal(runner.status().state, "starting");
  assert.equal(runner.tunnelUrl(), null);
  await runner.advance(entryAt(TUNNEL_PROBE_DELAYS_REUSED_MS, 1));
  assert.equal(runner.status().state, "up");
  assert.equal(runner.tunnelUrl(), "wss://sm-feedfacecafe.sm.example.test");
  assert.ok(statusChanges > 0);
  // Reconciling the unchanged port over a live child is a no-op.
  await runner.reconcile({ port: 40100 });
  assert.equal(spawned.length, 1);
  assert.deepEqual(provisionPorts, [40100]);
  // The child dies: not advertised anymore, a restart scheduled on
  // the ladder.
  entryAt(spawned, 0).exit();
  await runner.advance(0);
  assert.equal(runner.status().state, "error");
  assert.equal(runner.tunnelUrl(), null);
  // A same-port reconcile while the retry is scheduled is a no-op
  // too: it must neither provision nor reset the ladder.
  await runner.reconcile({ port: 40100 });
  assert.equal(runner.status().state, "error");
  assert.deepEqual(provisionPorts, [40100]);
  await runner.advance(TUNNEL_BACKOFF_LADDER_MS[0]);
  assert.equal(spawned.length, 2, "no respawn after the backoff delay");
  // The crash restart reused the cached provision (the dead child
  // HAD passed the probe): no Worker round trip for an unchanged
  // port.
  assert.deepEqual(
    provisionPorts,
    [40100],
    "a post-ready crash restart re-provisioned an unchanged port",
  );
  await runner.advance(TUNNEL_PROBE_DELAYS_REUSED_MS[0]);
  assert.equal(runner.status().state, "up");
  // A listener restart on a NEW ephemeral port kills the old child
  // and re-provisions against the new port.
  await runner.reconcile({ port: 40200 });
  assert.equal(spawned[1]?.killed, true);
  assert.equal(spawned.length, 3);
  assert.deepEqual(provisionPorts, [40100, 40200]);
  // reconcile(null) (sign-out, account switch, directConnections
  // off, the listener going down all land here): the child is
  // killed, nothing restarts later.
  await runner.reconcile(null);
  assert.equal(spawned[2]?.killed, true);
  assert.equal(runner.status().state, "off");
  assert.equal(runner.tunnelUrl(), null);
  await runner.advance(10 * 60_000);
  assert.equal(spawned.length, 3, "a stopped runner respawned");
});

it("cloudflared runner: a never-ready child's restart re-provisions (its token may be dead), a probed-ready child's crash reuses the cache, a stable run resets the ladder, and a not-yet-routable child of a FRESH record is kept and probed on until the long deadline, while a reused tunnel that never routes is killed and re-provisioned at the short one", async () => {
  let provisions = 0;
  let routable = false;
  const runner = await tunnelHarness({
    provision: async () => {
      provisions += 1;
      return {
        hostname: "sm-feedfacecafe.sm.example.test",
        connectorToken: "stub-token",
      };
    },
    probe: () => routable,
  });
  const { spawned } = runner;
  await runner.reconcile({ port: 40100 });
  assert.equal(provisions, 1);
  // The child dies BEFORE any probe passed: the cached provision
  // is not trusted (the token may be dead), so the restart pays a
  // fresh Worker round trip.
  lastOf(spawned).exit();
  await runner.advance(0);
  await runner.advance(TUNNEL_BACKOFF_LADDER_MS[0]);
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
  await runner.advance(TUNNEL_PROBE_DELAYS_REUSED_MS[0]);
  assert.equal(runner.status().state, "up");
  await runner.advance(TUNNEL_STABLE_MS);
  lastOf(spawned).exit();
  await runner.advance(0);
  await runner.advance(TUNNEL_BACKOFF_LADDER_MS[0]);
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

  // A child that is not routable for a long time (a fresh hostname
  // waiting on DNS): the probe chain keeps walking its capped rung
  // for as long as the child lives. It is never killed, nothing is
  // re-provisioned, the status stays "starting", and the moment a
  // probe passes the tunnel is advertised on the same child.
  let lateProvisions = 0;
  let lateRoutable = false;
  const notYetRoutable = await tunnelHarness({
    provision: async () => {
      lateProvisions += 1;
      return {
        hostname: "h.example.test",
        connectorToken: "t",
        dnsCreated: true,
      };
    },
    probe: () => lateRoutable,
  });
  await notYetRoutable.reconcile({ port: 40100 });
  assert.equal(notYetRoutable.spawned.length, 1);
  // Walk well past the warning threshold: the capped rung up to it,
  // the slow rung after, where the child is still alive and probed.
  const step = lastOf(TUNNEL_PROBE_DELAYS_MS);
  for (let walked = 0; walked <= TUNNEL_PROBE_WARN_MS; walked += step) {
    // oxlint-disable-next-line no-await-in-loop -- the probe chain advances serially by design
    await notYetRoutable.advance(step);
  }
  for (let i = 0; i < 3; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- see above
    await notYetRoutable.advance(TUNNEL_PROBE_SLOW_MS);
  }
  assert.equal(notYetRoutable.status().state, "starting");
  assert.equal(notYetRoutable.tunnelUrl(), null);
  assert.equal(
    notYetRoutable.spawned[0]?.killed,
    false,
    "a not-yet-routable child was killed",
  );
  assert.equal(
    notYetRoutable.spawned.length,
    1,
    "a not-yet-routable child was respawned",
  );
  assert.equal(
    lateProvisions,
    1,
    "a not-yet-routable child was re-provisioned",
  );
  // DNS catches up: the next (slow-rung) probe advertises the same
  // child.
  lateRoutable = true;
  await notYetRoutable.advance(TUNNEL_PROBE_SLOW_MS);
  assert.equal(notYetRoutable.status().state, "up");
  assert.equal(notYetRoutable.tunnelUrl(), "wss://h.example.test");
  assert.equal(notYetRoutable.spawned.length, 1);
  await notYetRoutable.dispose();

  // A reused tunnel that NEVER becomes routable (a deleted record,
  // a stale ingress): past the short deadline it is killed and the
  // restart re-provisions, since it never reached readiness.
  let deadProvisions = 0;
  const neverRoutable = await tunnelHarness({
    provision: async () => {
      deadProvisions += 1;
      return { hostname: "h.example.test", connectorToken: "t" };
    },
    probe: () => false,
  });
  await neverRoutable.reconcile({ port: 40100 });
  // A second at a time, so the walk stops at the kill and not past
  // the restart one rung later.
  for (
    let walked = 0;
    walked <= TUNNEL_PROBE_DEADLINE_MS + step &&
    neverRoutable.status().state === "starting";
    walked += 1_000
  ) {
    // oxlint-disable-next-line no-await-in-loop -- see above
    await neverRoutable.advance(1_000);
  }
  assert.ok(
    TUNNEL_PROBE_DEADLINE_FRESH_MS > TUNNEL_PROBE_DEADLINE_MS,
    "a fresh record must get the longer deadline",
  );
  assert.equal(neverRoutable.status().state, "error");
  assert.equal(
    neverRoutable.spawned[0]?.killed,
    true,
    "not killed at the deadline",
  );
  await neverRoutable.advance(lastOf(TUNNEL_BACKOFF_LADDER_MS));
  assert.equal(
    neverRoutable.spawned.length,
    2,
    "no respawn after the deadline",
  );
  assert.equal(deadProvisions, 2, "the deadline restart reused the provision");
});

it("cloudflared runner: a denied provision (401/404) parks with NO scheduled retry, and the next reconcile trigger is its recovery path", async () => {
  let provisions = 0;
  let denied = true;
  const runner = await tunnelHarness({
    provision: async () => {
      provisions += 1;
      if (denied) {
        throw new TunnelProvisionDeniedError("device revoked", 401);
      }
      return { hostname: "h.example.test", connectorToken: "t" };
    },
  });
  await runner.reconcile({ port: 40100 });
  assert.equal(runner.status().state, "error");
  assert.equal(provisions, 1);
  // Parked: time passing schedules NOTHING (a timed retry would
  // re-present the same refused request forever).
  await runner.advance(30 * 60_000);
  assert.equal(provisions, 1, "a denied provision retried on a timer");
  assert.equal(runner.spawned.length, 0);
  // The next reconcile trigger re-enters even on the same port:
  // that is exactly when the inputs (a re-sign-in, a Worker
  // redeploy) can have changed.
  denied = false;
  await runner.reconcile({ port: 40100 });
  assert.equal(provisions, 2, "the reconcile trigger did not re-enter");
  assert.equal(runner.spawned.length, 1);
  assert.equal(runner.status().state, "starting");
  await runner.reconcile(null);
});

it("cloudflared runner: closing the layer pre-empts an in-flight provision, so nothing spawns during the quit", async () => {
  let releaseProvision: (provisioned: TunnelProvision) => void = notYetSet;
  const hung = await tunnelHarness({
    provision: () =>
      new Promise((resolve) => {
        releaseProvision = resolve;
      }),
  });
  await hung.reconcile({ port: 40100 });
  await hung.dispose();
  releaseProvision({ hostname: "h.example.test", connectorToken: "t" });
  await settleTunnel();
  assert.equal(
    hung.spawned.length,
    0,
    "a provision that outran the quit spawned",
  );
});
