// Durable proof for the direct data plane (the ONLY data
// plane): the device hub is orchestration and data
// flows over DIRECT websockets between devices, brokered by short-lived
// single-use connect tickets, with no hub fallback behind a failed
// dial.
//
// Boots the stub Durable Object (test/lib/hubStub.mts) with two
// REAL hub connections (the dialer and the listener) plus a
// REAL direct ws listener (host/socket/DeviceLink.ts with a
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
//   - a call over the hop interrupted where it was made (hub:invokePeer
//     as a window's host and a web tab serve it, servedInvokePeer)
//     cancels the listener's handler, which sees its signal abort.
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
//     deadline (hellos serialized, see below): a junk
//     candidate cannot defeat a reachable one, a peer that never
//     answers the ask cannot hang the bridge cache (the attempt
//     rejects typed), and a blocked verdict is terminal for the whole
//     attempt once no candidate wins.
//   - a dial costs the device hub exactly one ask and one answer,
//     nothing before or after.
//   - presence scopes the data plane: a peer leaving a LIVE roster
//     loses its direct sessions host-side and client-side, while our
//     own hub link going down leaves them alone.
//   - the session cache is direct or nothing: a working
//     listener yields a direct session reported via
//     directPeers, a dead socket drops the cache, and a FAILED
//     dial rejects with the typed unreachable outcome with no hub
//     session created for data.
//     (The hub wire answering nothing but connectInfo is pinned in
//     hub-link.mts.)
//   - pushes from the host reach a direct-connected client through the
//     shared peerPush path while the hub stub forwards nothing.
//
// The tunnel endpoints add:
//
//   - the host advertises a tunnel-kind candidate with its own
//     ticket exactly while the tunnel reports healthy, omits it
//     otherwise, and mints ONLY the kinds the caller declared it can
//     dial (dialableKinds in the connectInfo input).
//   - candidate hellos are SERIALIZED: with two reachable candidates
//     the slower one never sends a hello, so the winner's session
//     survives (no host-side supersede) and the loser's ticket is
//     never spent.
//   - the host NAMES its refusals: a ticket it read and rejected is
//     LinkRefusedError (blocked), while a
//     client benched by the failed-auth window is closed with the
//     lockout's code (unblocked, transient, the keeper ladders)
//     even on a single candidate holding a VALID ticket, the shape a
//     tunnel-only peer has.
//   - the listener keys lockout on CF-Connecting-IP for
//     loopback (tunnel-borne) connections, so one hostile client
//     cannot bench every tunnel dial behind the shared 127.0.0.1.
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
//     touching sessions, a blocked ticket on the same ladder, and a
//     peer with no listener PARKED with no timer until its
//     offline-to-online transition redials it fresh.
//   - the cloudflared deciders (argv/env secret discipline, the
//     capped ladder through the supervisor's shared lookup) and the
//     runner's lifecycle (no-binary, unconfigured asked again on an
//     interval and at a wake, probe-gated advertising with a deadline,
//     crash restart reusing the cached provision only after a
//     probe-passed child, re-provision on port change / a never-ready
//     child, stable reset, reconcile no-op that preserves backoff, a
//     denied provision parking with no timed retry, and the layer's
//     close pre-empting an in-flight provision) against a stub
//     spawner, stub deps and a TestClock, with the connector token
//     never in any status object.
//
// The listener's own hardening (framing, the Origin gate, the frame
// cap, the generation guard) is pinned by
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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as PlatformError from "effect/PlatformError";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Context from "effect/Context";
import { WebSocket as WsClient, WebSocketServer } from "ws";
import { it } from "vitest";
import {
  CommandRefusedError,
  errorMessageOf,
  LinkRefusedError,
  NoDirectConnectionError,
  NotSharingError,
} from "@shigomori/contracts/errors";
import { RemoteConnectError } from "@shared/remote/deviceLink";
import {
  type DirectCandidateKind,
  type DirectConnectInfo,
  DirectConnectInfoSchema,
} from "@shigomori/contracts/modules/direct";
import type { HubPeerPush, HubStatus } from "@shigomori/contracts/modules/hub";
import {
  type HubHandlers,
  makeHubHandlers,
  servedInvokePeer,
} from "@shared/hub/bridgeHandlers";
import {
  createDirectDialer,
  type DirectDialer,
  type DirectDialerDeps,
  NoDialableCandidateError,
} from "@shared/hub/directDial";
import { make as makeDirectKeeper } from "@shared/hub/directKeeper";
import {
  applyDirectPresence,
  type DirectPresenceDeps,
} from "@shared/hub/directPresence";
import {
  BACKOFF_LADDER_MS,
  backoffDelayMs,
  supervise,
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
  UNCONFIGURED_RETRY_MS,
  TUNNEL_STABLE_MS,
  type TunnelProvision,
} from "@host/direct/Tunnel";
import * as Tunnels from "@host/direct/Tunnel";
import {
  type ConnectTicketStore,
  createConnectTicketStore,
  DIRECT_TICKET_PREFIX,
} from "@host/direct/tickets";
import { makeConnectInfo, TUNNEL_HOLD_MS } from "@host/direct/connectInfo";
import { mintHexId } from "@host/lib/hexId";
import { CONNECT_INFO_ASK, HubAskRefusedError } from "@shared/hub/link";
import {
  CLOSE_HANDSHAKE_FAILED,
  STALE_TICKET,
} from "@shared/remote/sealedSocket";
import {
  decodeRelayFrame,
  encodeRelayFrame,
  MAX_DEVICE_CONNECTIONS,
} from "@shigomori/contracts/hubProtocol";
import { TunnelProvisionDeniedError } from "@shared/account/service";
import { HubTunnelUnconfiguredError } from "@shigomori/contracts/hubApi";
import { make as createWebConnection } from "../web/hub/connection.ts";
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
  bridgeTo,
  DIALER,
  type DialOpts,
  dialing,
  type DirectListenerOpts,
  LISTENER,
  makeDirectBridge,
  mintTicket,
  mintTickets,
  ONE_CONNECTION,
  startDirectListener as startListenerFixture,
} from "./lib/directBoot.mts";
import { bootDevice } from "./lib/hubBoot.mts";
import { delay } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";
import { sealAsk, startStubHub, testDeviceKey } from "./lib/hubStub.mts";

// A blackholed candidate (TEST-NET-3, never routed): a dial to it
// hangs or dies on its own, never reaching any listener.
const BLACKHOLE = "203.0.113.1";

const ECHO = "projects:defaultBranch";
const WHOAMI = "projects:pickWorktreeName";
const MUTATE = "git:refreshProject";
// A read the listener holds until the call is cancelled.
const HOLD = "projects:cloneUrl";
const echoOf = (value: string) => ({ projectId: value });

// The shared listener fixture (test/lib/directBoot.mts) with this
// check's data-plane test handlers mounted. Handler counters prove
// refusals never ran a body.
async function startDirectListener(
  track: Track,
  opts: DirectListenerOpts = {},
) {
  let mutateRuns = 0;
  // The held read's progress: started, then aborted by its caller.
  const hold = { started: false, aborted: false };
  const listener = await startListenerFixture(track, {
    ...opts,
    registerHandlers: (binding) => {
      // An echo, a who-am-I and a command, on real calls the link
      // serves: two reads and a gated one.
      binding.handle(
        ECHO,
        async (_ctx, raw) => (raw as { projectId: string }).projectId,
      );
      binding.handle(WHOAMI, async (ctx) => ctx.callerDeviceId ?? "none");
      binding.handle(MUTATE, async () => {
        mutateRuns += 1;
      });
      binding.handle(
        HOLD,
        (ctx) =>
          new Promise((resolve) => {
            hold.started = true;
            ctx.signal.addEventListener("abort", () => {
              hold.aborted = true;
              resolve(null);
            });
          }),
      );
    },
  });
  return { ...listener, mutateRuns: () => mutateRuns, hold };
}

// One dial straight at a listener (dialing, the shared sandbox's),
// linked or failed.
const dial = (listener: Parameters<typeof dialing>[0], opts: DialOpts = {}) =>
  dialing(listener, opts).authenticate();

// The host's refusal of a ticket: blocked, carrying LinkRefusedError.
const refusedTicket = (error: unknown) =>
  error instanceof RemoteConnectError &&
  error.blocked &&
  error.refusal instanceof LinkRefusedError;

// The close code the listener refuses a locked-out client with.
const CLOSE_AUTH_LOCKED_OUT = 4003;

// A dialer over a FAKE ask answering a fixed candidate list, for
// scenarios that need per-candidate URLs (different ports, stubs) the
// real server's one-listener-port shape cannot express. `answer` may be
// a function, which may throw to play a rejected ask.
function fakeAskDialer(
  answer: DirectConnectInfo | (() => DirectConnectInfo),
  opts: Pick<
    DirectDialerDeps,
    "dialableKinds" | "deadlineMs" | "openSocket"
  > & {
    // How long the peer takes to answer the ask.
    askDelayMs?: number;
  } = {},
) {
  const dialer = createDirectDialer({
    askConnectInfo: async () => {
      if (opts.askDelayMs !== undefined) await delay(opts.askDelayMs);
      return typeof answer === "function" ? answer() : answer;
    },
    localDeviceId: DIALER,
    localAppVersion: "1.0.0",
    localKey: () => testDeviceKey(DIALER).pair,
    peerKey: (deviceId) => testDeviceKey(deviceId).pair.publicKey,
    dialableKinds: opts.dialableKinds,
    // The production socket (the host injects ws), so the errno path the
    // seam exists for is what the proof runs.
    openSocket: opts.openSocket ?? ((url) => new WsClient(url)),
    deadlineMs: opts.deadlineMs ?? 4000,
  });
  return { dialer };
}

// The keeper's one dial on a bridge, as a Promise.
const dialOn = (bridge: HubHandlers, deviceId: string) =>
  Effect.runPromise(bridge.dialPeer(deviceId));

// One direct dial in a scope of its own, its link up until `close`.
async function connectOnce(dialer: DirectDialer, deviceId: string) {
  const scope = Scope.makeUnsafe();
  const closed = () => Effect.runPromise(Scope.close(scope, Exit.void));
  try {
    const connection = await Effect.runPromise(
      Scope.provide(scope)(dialer.connectDirect(deviceId)),
    );
    return { ...connection, close: () => void closed() };
  } catch (error) {
    await closed();
    throw error;
  }
}

// The keeper on a TestClock over a stub dial, the scaffolding the two
// supervision scenarios below share: they differ only in what a failed
// dial rejects with (transient vs terminal), which is the whole point
// of running both. Dials fail until succeed() flips them, so a
// scenario can walk a failure streak into an established session
// without rebuilding the keeper.
// What a scoped constructor makes on `context`, its scope closed with
// the test.
function madeOn<A>(
  context: Context.Context<never>,
  make: Effect.Effect<A, never, Scope.Scope>,
): A {
  const scope = Scope.makeUnsafe();
  trackTest(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  return Effect.runSyncWith(context)(Scope.provide(scope)(make));
}

function stubKeeper(rejectWith: unknown) {
  const clock = testClock();
  const dials: Array<{ deviceId: string; at: number }> = [];
  let dialSucceeds = false;
  const keeper = madeOn(
    clock.context,
    makeDirectKeeper({
      dial: (deviceId) => {
        dials.push({ deviceId, at: clock.now() });
        return dialSucceeds ? Effect.void : Effect.fail(rejectWith);
      },
    }),
  );
  return {
    keeper,
    clock,
    dials,
    succeed: () => {
      dialSucceeds = true;
    },
  };
}

// One invoke on the listener over the bridge's direct session, the call most
// scenarios below make.
function invokeListener(bridge: HubHandlers, channel: string, input?: unknown) {
  return bridge.invokePeer({ deviceId: LISTENER, channel, input }, undefined);
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

// Whether a ticket is still pending for `peer`, spending it. A
// loopback dial with no CF-Connecting-IP arrives as a "lan" candidate,
// which is what the default matches.
async function consumeTicket(
  store: ConnectTicketStore,
  ticket: string,
  peer: string,
  kind: DirectCandidateKind = "lan",
) {
  return store.consume(ticket, kind) === peer;
}

// One dial with the connector's CF-Connecting-IP header set, as a
// tunnel-borne connection arrives, for the lockout-identity scenario.
// Resolves with whether it linked, and its failure when it did not.
async function rawHeaderDial(
  listener: Parameters<typeof dialing>[0],
  ticket: string,
  cfConnectingIp: string,
): Promise<{ welcomed: boolean; error?: RemoteConnectError }> {
  try {
    const connection = await dial(listener, {
      ticket,
      openSocket: (url) =>
        new WsClient(url, {
          headers: { "cf-connecting-ip": cfConnectingIp },
        }),
    });
    connection.close();
    return { welcomed: true };
  } catch (error) {
    assert.ok(error instanceof RemoteConnectError, String(error));
    return { welcomed: false, error };
  }
}

// The bridge cache (shared/hub/bridgeHandlers.ts) driven directly
// with a controllable dialer whose one dial lands only on release, so
// the mid-dial sweep scenarios can provably land a sweep between dial
// start and completion. `closed` counts the dials whose scope closed,
// landed or not.
function heldDial() {
  let release: () => void = notYetSet;
  let closed = 0;
  let changes = 0;
  const handlers = madeOn(
    Context.empty(),
    makeHubHandlers({
      status: () => ({
        socket: { phase: "connected" },
        onlineDeviceIds: [],
        peerAppVersions: {},
        peerAcceptsCommands: {},
        peerSharesData: {},
      }),
      connectDirect: () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed += 1;
            }),
          );
          yield* Effect.callback<void>((resume) => {
            release = () => resume(Effect.void);
          });
          return {
            transport: {
              invoke: async () => null,
              subscribe: () => () => {},
            },
            channels: { attach: notYetSet, has: () => false, size: () => 0 },
            probe: () => {},
            remoteDeviceId: LISTENER,
            remoteAppVersion: "9",
            acceptsCommands: false,
            sharesData: true,
            dropped: Effect.never,
          };
        }),
      onDirectChange: () => {
        changes += 1;
      },
    }),
  );
  return {
    handlers,
    release: () => release(),
    closed: () => closed,
    changes: () => changes,
  };
}

it("brokering: connectInfo over the device hub carries fully dialable candidates with one ticket each while the listener is up, and available:false when it is down", async () => {
  const listener = await startDirectListener(trackTest);
  const { dialer } = await bridgeTo(trackTest, listener, {
    candidateAddresses: () => ["127.0.0.1", "192.0.2.9"],
  });
  const ask = () =>
    dialer.connection.askConnectInfo(
      LISTENER,
      { dialableKinds: ["lan", "tunnel"], connectionId: ONE_CONNECTION },
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
  await listener.binding.reconcile(null);
  assert.deepEqual(await ask(), { available: false });
});

it("brokering serves the roster only: an ask forged from outside the host's live roster, an ask with a malformed input and a replayed ask mint nothing, and a real ask mints for the hub-stamped caller", async () => {
  const listener = await startDirectListener(trackTest);
  const minted: string[] = [];
  const { stub, dialer } = await bridgeTo(trackTest, listener, {
    onMinted: (tickets) => minted.push(...tickets),
  });
  // A hostile hub can forge any `from`. The host answers nothing to
  // a device its roster does not name, and mints nothing for it.
  stub.injectTo(LISTENER, {
    t: "relay",
    from: "ghost",
    frame: sealAsk("ghost", LISTENER, 1, {
      ask: CONNECT_INFO_ASK,
      input: { dialableKinds: ["lan"], connectionId: ONE_CONNECTION },
    }).frame,
  });
  await delay(100);
  assert.equal(stub.sentTo(LISTENER, "ghost"), false);
  assert.equal(minted.length, 0, "a ticket was minted for a forged sender");
  // The input is parsed before anything is minted.
  await assert.rejects(
    () =>
      dialer.connection.askConnectInfo(
        LISTENER,
        { dialableKinds: "lan" },
        3000,
      ),
    (error) => error instanceof HubAskRefusedError,
  );
  assert.equal(minted.length, 0, "a malformed ask minted a ticket");
  const info = Schema.decodeUnknownSync(DirectConnectInfoSchema)(
    await dialer.connection.askConnectInfo(
      LISTENER,
      { dialableKinds: ["lan"], connectionId: ONE_CONNECTION },
      3000,
    ),
  );
  assert.equal(info.available, true);
  assert.equal(minted.length, 1);
  // The same sealed ask, replayed by a hub under another id, mints
  // nothing, so the asker's tickets stand.
  const sent = stub.received.findLast(
    (entry) => entry.from === DIALER && entry.to === LISTENER,
  );
  const replayed = sent === undefined ? null : decodeRelayFrame(sent.frame);
  assert.ok(replayed !== null && replayed.kind === "ask");
  stub.injectTo(LISTENER, {
    t: "relay",
    from: DIALER,
    frame: encodeRelayFrame({ ...replayed, id: replayed.id + 1 }),
  });
  await delay(100);
  assert.equal(minted.length, 1, "a replayed ask minted again");
  // Bound to the caller the hub stamped, not to anything the ask
  // could claim.
  assert.equal(
    await consumeTicket(listener.tickets, entryAt(minted, 0), DIALER),
    true,
    "the ticket was not bound to the asking device",
  );
});

it("direct dial: the handshake completes with the pinned identity and invokes flow while the device hub's forwardedCount stays flat", async () => {
  const listener = await startDirectListener(trackTest);
  const { stub, bridge } = await bridgeTo(trackTest, listener);
  await dialOn(bridge, LISTENER);
  // The welcome pinned the dialed identity and confirmed the
  // host's version, surfaced through the one per-peer data fact.
  assert.deepEqual(bridge.directPeers().peerAppVersions, {
    [LISTENER]: "2.0.0",
  });
  // The direct wire carries the authed caller identity to
  // handlers.
  assert.equal(await invokeListener(bridge, WHOAMI, echoOf("p")), DIALER);
  const baseline = stub.forwardedCount();
  for (let i = 0; i < 5; i += 1) {
    const result = await invokeListener(bridge, ECHO, echoOf(String(i)));
    assert.equal(result, String(i));
  }
  assert.equal(
    stub.forwardedCount(),
    baseline,
    "direct invokes still rode the device hub",
  );
});

it("interrupted over the hop: a call a window or a tab drops cancels the listener's handler", async () => {
  const listener = await startDirectListener(trackTest);
  const { bridge } = await bridgeTo(trackTest, listener);
  await dialOn(bridge, LISTENER);
  const fiber = Effect.runFork(
    servedInvokePeer(() => bridge)({
      deviceId: LISTENER,
      channel: HOLD,
      input: echoOf("p"),
    }),
  );
  await waitFor(() => listener.hold.started, "the held read to start");
  await Effect.runPromise(Fiber.interrupt(fiber));
  await waitFor(
    () => listener.hold.aborted,
    "the listener's handler to see its call cancelled",
  );
});

it("concurrent race: a junk candidate enumerating first no longer defeats a reachable one, and per-candidate tickets keep every candidate authable", async () => {
  const listener = await startDirectListener(trackTest);
  // The junk candidate FIRST, exactly the ordering that made the
  // sequential walk fail deterministically on multi-interface
  // machines. Both candidates dial at once, so the reachable one
  // wins without waiting out the blackhole.
  const { bridge } = await bridgeTo(trackTest, listener, {
    candidateAddresses: () => [BLACKHOLE, "127.0.0.1"],
    deadlineMs: 4000,
  });
  const startedAt = Date.now();
  await dialOn(bridge, LISTENER);
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < 2000,
    `the reachable candidate waited on the junk one (${elapsed}ms)`,
  );
  assert.equal(await invokeListener(bridge, ECHO, echoOf("raced")), "raced");
});

it("blocked verdict is terminal but does not end the race: an auth-refused candidate still rejects the attempt as blocked once the remaining candidates have had their turn, never as a transient timeout", async () => {
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
  const { bridge } = await bridgeTo(trackTest, brokerListener, {
    candidateAddresses: () => ["127.0.0.1", BLACKHOLE],
    deadlineMs: 1500,
  });
  await assert.rejects(
    () => dialOn(bridge, LISTENER),
    (error) => refusedTicket(error),
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
  const ticket = mintTicket(listener.tickets, DIALER);
  const { dialer } = fakeAskDialer({
    available: true,
    acceptsCommands: false,
    sharesData: true,
    candidates: [
      {
        kind: "lan",
        url: `ws://127.0.0.1:${squatter.port}`,
        ticket: "smpt_never_minted",
      },
      { kind: "lan", url: `ws://127.0.0.1:${slowPort}`, ticket },
    ],
  });
  const connection = await connectOnce(dialer, LISTENER);
  trackTest(() => connection.close());
  assert.equal(connection.remoteDeviceId, LISTENER);
});

it("a late answer leaves the race its own budget: a peer just woken answers most of the way to the deadline, and its candidate still wins", async () => {
  const listener = await startDirectListener(trackTest);
  // The handshake reaches the listener only after a slow route, as one
  // across the tunnel after a wake does.
  const slowPort = await delayProxy(trackTest, listener.port, 500);
  const ticket = mintTicket(listener.tickets, DIALER);
  const { dialer } = fakeAskDialer(
    {
      available: true,
      acceptsCommands: false,
      sharesData: true,
      candidates: [{ kind: "lan", url: `ws://127.0.0.1:${slowPort}`, ticket }],
    },
    { deadlineMs: 1000, askDelayMs: 700 },
  );
  const connection = await connectOnce(dialer, LISTENER);
  trackTest(() => connection.close());
  assert.equal(connection.remoteDeviceId, LISTENER);
});

it("serialized hellos: with two reachable candidates the slow one never hellos, the winner's session survives (no supersede), and the loser's ticket stays unspent", async () => {
  const listener = await startDirectListener(trackTest);
  // The SAME listener behind a delayed route and a direct one. The
  // slow candidate's socket opens well after the fast one won: if
  // its hello were sent anyway (the old concurrent-hello shape),
  // the host's per-device supersede would kill the winner's fresh
  // session and the invoke below would reject.
  const slowPort = await delayProxy(trackTest, listener.port, 250);
  const [slowTicket, fastTicket] = mintTickets(listener.tickets, DIALER, 2);
  assert.ok(
    slowTicket !== undefined && fastTicket !== undefined,
    "expected two minted tickets",
  );
  const { dialer } = fakeAskDialer({
    available: true,
    acceptsCommands: false,
    sharesData: true,
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
  const connection = await connectOnce(dialer, LISTENER);
  trackTest(() => connection.close());
  assert.equal(connection.remoteDeviceId, LISTENER);
  // Let the slow candidate's socket open, be abandoned, and any
  // frames drain before judging the winner's health.
  await delay(450);
  assert.equal(
    await connection.transport.invoke(ECHO, echoOf("still the winner")),
    "still the winner",
    "the slow candidate's late hello superseded the winning session",
  );
  // A ticket is spent by the hello that links, so the loser, which
  // never said one, left its own pending.
  assert.equal(
    await consumeTicket(listener.tickets, slowTicket, DIALER),
    true,
    "the abandoned candidate spent its ticket",
  );
  assert.equal(
    await consumeTicket(listener.tickets, fastTicket, DIALER),
    false,
  );
});

it("the host names its lockout on the wire: a client inside the failed-auth window is refused CLOSE_AUTH_LOCKED_OUT, so a single-candidate dial rejects unblocked and the keeper LADDERS instead of parking", async () => {
  const listener = await startDirectListener(trackTest);
  // Bench 127.0.0.1 the way a real client does: five refused
  // tickets. (The dialer cannot set CF-Connecting-IP, so it keys on
  // the loopback address, which is exactly the identity these
  // failures burn.)
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(
      () => dial(listener, { ticket: "smpt_wrong" }),
      refusedTicket,
    );
  }
  // ONE candidate, a VALID ticket, and a benched IP: the shape a
  // tunnel-only peer has. Only the close code can tell this lockout
  // from a refused ticket.
  const ticket = mintTicket(listener.tickets, DIALER);
  const { dialer } = fakeAskDialer({
    available: true,
    acceptsCommands: false,
    sharesData: true,
    candidates: [
      { kind: "lan", url: `ws://127.0.0.1:${listener.port}`, ticket },
    ],
  });
  let verdict: unknown;
  await assert.rejects(
    () => connectOnce(dialer, LISTENER),
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
  // The whole point: the ladder, so the peer comes back on its own
  // when the window expires. A park would outlive the lockout with
  // no roster transition to unpark on.
  const { keeper, clock, dials } = stubKeeper(verdict);
  keeper.reconcile([LISTENER]);
  await clock.settle();
  assert.equal(dials.length, 1);
  await clock.advance(BACKOFF_LADDER_MS[0]);
  assert.equal(
    dials.length,
    2,
    "a lockout parked the peer instead of retrying it",
  );
});

it("a genuine ticket refusal is blocked, and the keeper asks again on the shared ladder", async () => {
  // The other side of the same line. Same single-candidate shape,
  // same connection-time close code family, opposite verdict --
  // and the ONLY thing separating them is what the host put on the
  // wire, which is the argument for the distinct code.
  const listener = await startDirectListener(trackTest);
  const { dialer } = fakeAskDialer({
    available: true,
    acceptsCommands: false,
    sharesData: true,
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
    () => connectOnce(dialer, LISTENER),
    (error) => {
      verdict = error;
      return error instanceof RemoteConnectError;
    },
  );
  assert.ok(verdict instanceof RemoteConnectError);
  assert.ok(refusedTicket(verdict), "a refused ticket was not blocked");
  // Asked again on the same ladder, and the network coming back
  // hurries it.
  const { keeper, clock, dials } = stubKeeper(verdict);
  keeper.reconcile([LISTENER]);
  await clock.settle();
  assert.equal(dials.length, 1);
  await clock.advance(BACKOFF_LADDER_MS[0]);
  assert.equal(dials.length, 2);
  keeper.dialNow();
  await clock.settle();
  assert.equal(dials.length, 3);
});

it("a machine that answers at an advertised LAN address learns the ticket and nothing it can use: the dial to it fails the handshake, and what it heard opens nothing at the real listener", async () => {
  const listener = await startDirectListener(trackTest);
  const ticket = mintTicket(listener.tickets, DIALER);
  // The impostor: whoever holds that private address on the network
  // the dialer happens to be on. It keeps what it is sent.
  const heard: Buffer[] = [];
  const impostor = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  impostor.on("connection", (socket) => {
    socket.on("message", (data) => heard.push(Buffer.from(data as Buffer)));
  });
  await new Promise((resolve) => impostor.on("listening", resolve));
  trackTest(
    () => new Promise<void>((resolve) => impostor.close(() => resolve())),
  );

  // It cannot answer a handshake sealed to the listener's key.
  await assert.rejects(
    () =>
      dial(listener, {
        url: `ws://127.0.0.1:${boundPort(impostor)}`,
        ticket,
        deadlineMs: 600,
      }),
    "the dialer accepted a host that never proved it holds the listener's key",
  );
  const first = heard[0];
  assert.ok(first !== undefined, "the impostor saw nothing");
  assert.ok(first.includes(ticket), "the ticket opens the socket in clear");

  // Replayed at the real listener, the first frame draws an answer only
  // the dialer can read: nothing the impostor sends after it authenticates, and
  // the socket closes.
  const closedWith = await new Promise<number>((resolve) => {
    const socket = new WsClient(`ws://127.0.0.1:${listener.port}`);
    socket.on("open", () => socket.send(first));
    socket.once("message", () => socket.send(first));
    socket.on("close", (code) => resolve(code));
    socket.on("error", () => {});
  });
  assert.equal(closedWith, CLOSE_HANDSHAKE_FAILED);
  // Spending nothing: the ticket is still the real device's to link
  // with.
  assert.equal(
    await consumeTicket(listener.tickets, ticket, DIALER),
    true,
    "a replayed first frame spent the ticket",
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
  const lanTicket = mintTicket(listener.tickets, DIALER, "lan");
  const crossPath = await rawHeaderDial(listener, lanTicket, "203.0.113.9");
  assert.equal(
    crossPath.welcomed,
    false,
    "a LAN ticket authed through the tunnel path",
  );
  assert.ok(refusedTicket(crossPath.error));
  // Refused, not consumed: the honest LAN dial it was minted for is
  // untouched by someone else's failed attempt.
  assert.equal(
    await consumeTicket(listener.tickets, lanTicket, DIALER, "lan"),
    true,
    "a cross-path attempt spent the ticket it failed to redeem",
  );
});

it("loopback lockout identity: the ticket listener keys lockout on CF-Connecting-IP for loopback connections, so one hostile identity cannot bench another's dial", async () => {
  const listener = await startDirectListener(trackTest);
  // Five bad tickets under one forwarded identity lock IT out.
  for (let i = 0; i < 5; i += 1) {
    const { error } = await rawHeaderDial(
      listener,
      "smpt_wrong",
      "198.51.100.7",
    );
    assert.ok(refusedTicket(error));
  }
  // The locked identity is refused at connection time even with a
  // VALID ticket (never presented, so it stays live). Minted
  // "tunnel" because that is what a loopback connection carrying
  // CF-Connecting-IP arrives as, which is the whole point of this
  // scenario: these dials stand in for the cloudflared connector.
  const lockedTicket = mintTicket(listener.tickets, DIALER, "tunnel");
  const locked = await rawHeaderDial(listener, lockedTicket, "198.51.100.7");
  assert.equal(locked.welcomed, false, "a locked-out identity authed");
  // A DISTINCT code from the five bad-ticket refusals above. The
  // host is the only side that can tell "your credential is wrong"
  // from "you are benched for 30s", and this dial is the proof it
  // must: the ticket here is VALID and was never even read.
  assert.equal(
    locked.error?.code,
    CLOSE_AUTH_LOCKED_OUT,
    "the lockout refusal was indistinguishable from a bad ticket",
  );
  assert.equal(
    await consumeTicket(listener.tickets, lockedTicket, DIALER, "tunnel"),
    true,
    "the lockout refusal spent the valid ticket it never read",
  );
  // A DIFFERENT identity over the same loopback path dials fine:
  // under remoteAddress keying both would share one 127.0.0.1
  // bucket and this dial would be benched too.
  const freshTicket = mintTicket(listener.tickets, DIALER, "tunnel");
  const other = await rawHeaderDial(listener, freshTicket, "198.51.100.8");
  assert.equal(
    other.welcomed,
    true,
    "an innocent identity was benched by another identity's lockout",
  );
});

it("deadline: a peer that never answers the ask cannot hang the bridge cache, whose attempt rejects typed within the budget, an invoke joins the in-flight dial's fate, and with nothing cached an invoke refuses at once instead of dialing", async () => {
  const stub = await startStubHub(trackTest);
  // The listener is a raw socket on the stub that NEVER answers (a wedged
  // peer).
  const wedged = new WsClient(
    `ws://127.0.0.1:${stub.port}/connect?ticket=t:${LISTENER}:1`,
  );
  trackTest(() => wedged.close());
  await new Promise((resolve) => wedged.once("open", resolve));
  const dialer = await bootDevice(stub, DIALER, {}, trackTest);
  const { bridge } = makeDirectBridge(dialer, { deadlineMs: 400 });
  const startedAt = Date.now();
  // Direct or nothing: the unanswered ask means the peer is
  // unreachable for data. An invoke arriving while the dial is in
  // flight joins it (the seamless boot race) and shares its typed
  // deadline rejection instead of hanging every consumer.
  const inFlight = dialOn(bridge, LISTENER);
  await assert.rejects(
    async () => invokeListener(bridge, ECHO, echoOf("hung peer")),
    /did not answer within/,
  );
  await assert.rejects(() => inFlight, /did not answer within/);
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < 3000,
    `the unanswered ask was not bounded by the deadline (${elapsed}ms)`,
  );
  assert.deepEqual(bridge.directPeers().peerAppVersions, {});
  // The failed dial dropped its cache entry (no poisoning), and a
  // bare invoke against the empty slot refuses at once WITHOUT
  // dialing: the keeper is the only dial trigger, so no user
  // action or renderer retry loop can pace attempts against a
  // wedged peer.
  const baseline = stub.receivedCount();
  const retryStartedAt = Date.now();
  await assert.rejects(
    async () => invokeListener(bridge, ECHO, echoOf("retry")),
    /no direct connection to listener/,
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

it("ticket single-use and expiry: a replayed ticket and an expired ticket are refused", async () => {
  // The tickets' own clock, which moves only when the case moves it: a
  // dial on a busy machine can take longer than a ticket lives.
  let clock = 0;
  const listener = await startDirectListener(trackTest, {
    ticketOpts: { ttlMs: 80, now: () => clock },
  });
  const ticket = mintTicket(listener.tickets, DIALER);
  const first = await dial(listener, { ticket });
  first.close();
  // Replay: the ticket was consumed on first presentation.
  await assert.rejects(
    () => dial(listener, { ticket }),
    refusedTicket,
    "a replayed ticket authenticated",
  );
  // Expiry: a fresh ticket past its TTL is refused too.
  const stale = mintTicket(listener.tickets, DIALER);
  clock += 150;
  await assert.rejects(
    () => dial(listener, { ticket: stale }),
    refusedTicket,
    "an expired ticket authenticated",
  );
});

it("per-connection ticket bookkeeping: one connection's mint replaces only its own set, a device's sibling connections each keep theirs, siblings in a set stay independently consumable, a device's sets are capped, and the backstop refuses instead of evicting", async () => {
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
  // Two tabs of one web device asking at once each keep their set.
  const tab1 = "1".repeat(32);
  const tab2 = "2".repeat(32);
  const first = mintTickets(store, "W", 1, "tunnel", tab1);
  const second = mintTickets(store, "W", 1, "tunnel", tab2);
  assert.equal(
    await consumeTicket(store, entryAt(first, 0), "W", "tunnel"),
    true,
  );
  assert.equal(
    await consumeTicket(store, entryAt(second, 0), "W", "tunnel"),
    true,
  );
  // A device asking under ever new connections holds at most
  // MAX_DEVICE_CONNECTIONS sets: its oldest gives way, and no one
  // else's does.
  const oldest = mintTickets(store, "F", 1, "lan", "0".repeat(32));
  for (let i = 1; i <= MAX_DEVICE_CONNECTIONS; i += 1) {
    mintTickets(store, "F", 1, "lan", i.toString(16).padStart(32, "0"));
  }
  assert.equal(await consumeTicket(store, entryAt(oldest, 0), "F"), false);
  // A device the roster dropped keeps none of its tickets, and the
  // devices it still names keep theirs.
  const dropped = mintTickets(store, "D", 1);
  const kept = mintTickets(store, "K", 1);
  store.keepDevices(["K"]);
  assert.equal(await consumeTicket(store, entryAt(dropped, 0), "D"), false);
  assert.equal(await consumeTicket(store, entryAt(kept, 0), "K"), true);
  // The global backstop refuses the overflowing mint outright and
  // never evicts another peer's pending tickets.
  const keeper = mintTickets(store, "keeper", 2);
  for (let i = 0; i < 200; i += 1) mintTickets(store, `peer-${i}`, 1);
  assert.equal(
    store.mint(
      { deviceId: "overflow", connectionId: ONE_CONNECTION },
      Array.from({ length: 60 }, () => "lan"),
    ),
    null,
  );
  assert.equal(await consumeTicket(store, entryAt(keeper, 0), "keeper"), true);
});

it("stale tickets: one the store issued and let go (spent, replaced, expired, dropped, or presented on another path) reads as stale, and only one it never issued as unknown", async () => {
  let now = 0;
  const store = createConnectTicketStore({ ttlMs: 1_000, now: () => now });
  const one = (peer: string) => entryAt(mintTickets(store, peer, 1), 0);
  const pair = mintTickets(store, "A", 2);
  assert.equal(store.consume(entryAt(pair, 0), "lan"), "A");
  assert.equal(store.check(entryAt(pair, 0), "lan"), STALE_TICKET);
  assert.equal(store.check(entryAt(pair, 1), "tunnel"), STALE_TICKET);
  const replaced = one("A");
  one("A");
  assert.equal(store.check(replaced, "lan"), STALE_TICKET);
  const expired = one("B");
  now += 1_000;
  assert.equal(store.check(expired, "lan"), STALE_TICKET);
  // Swept by the next mint, still known.
  one("C");
  assert.equal(store.check(expired, "lan"), STALE_TICKET);
  const dropped = one("D");
  store.keepDevices(["C"]);
  assert.equal(store.check(dropped, "lan"), STALE_TICKET);
  assert.equal(store.check("smpt_never_minted", "lan"), null);
});

// The ticket an answer carries for a candidate of `kind`.
function ticketOf(info: DirectConnectInfo, kind: "lan" | "tunnel"): string {
  assert.ok(info.available);
  const candidate = info.candidates.find((each) => each.kind === kind);
  assert.ok(candidate !== undefined);
  return candidate.ticket;
}

it("tunnel recheck: a device whose last two asks, each under a fresh connection id as the dialer makes them, were handed a tunnel ticket that reached nothing rechecks an up tunnel once per run of failures, and a link from any of its connections starts the count over", async () => {
  const store = createConnectTicketStore();
  let tunnel: string | null = "wss://sm-0123456789ab.sm.example.test";
  let rechecks = 0;
  const connectInfo = makeConnectInfo({
    listenerPort: () => 42017,
    mintTickets: (peer, kinds) => store.mint(peer, kinds),
    candidateAddresses: () => ["127.0.0.1"],
    tunnelUrl: () => tunnel,
    tunnelUndialed: (deviceId, runs) =>
      store.claimUndialed(deviceId, "tunnel", runs),
    recheckTunnel: () => {
      rechecks += 1;
    },
    acceptsCommands: () => false,
    sharesData: () => true,
  });
  // One dial's ask, as directDial.ts makes it: a connection of its own.
  const ask = (deviceId: string, dialableKinds: string[]) =>
    connectInfo(deviceId, { dialableKinds, connectionId: mintHexId() });
  const web = ["tunnel"];
  const desktop = ["lan", "tunnel"];
  // A first ask, then one after its dial reached nothing.
  await ask(DIALER, web);
  await ask(DIALER, web);
  assert.equal(rechecks, 0, "one failed dial rechecked");
  // After two: once, and not again for the same run.
  const third = await ask(DIALER, web);
  assert.equal(rechecks, 1);
  await ask(DIALER, web);
  await ask(DIALER, web);
  assert.equal(rechecks, 1, "a run of failures rechecked twice");
  // A link, here from an earlier connection (another tab), ends the run.
  assert.equal(store.consume(ticketOf(third, "tunnel"), "tunnel"), DIALER);
  await ask(DIALER, web);
  await ask(DIALER, web);
  assert.equal(rechecks, 1);
  await ask(DIALER, web);
  assert.equal(rechecks, 2);
  // Another device keeps its own count, and a desktop whose lan
  // candidate won leaves its tunnel ticket be.
  const raced = await ask("E", desktop);
  assert.equal(store.consume(ticketOf(raced, "lan"), "lan"), "E");
  await ask("E", desktop);
  await ask("E", desktop);
  assert.equal(rechecks, 2);
  // Two whose every candidate failed.
  await ask("E", desktop);
  assert.equal(rechecks, 3);
  // A tunnel already down is not asked.
  tunnel = null;
  for (let turn = 0; turn < 3; turn++) await ask("F", web);
  assert.equal(rechecks, 3);
});

it("identity binding: a ticket minted for one device refuses another, and a wrong expected welcome identity fails the handshake", async () => {
  const listener = await startDirectListener(trackTest);
  // The ticket is bound to the dialer, the hello claims C. No identity pin:
  // the refusal under test is the listener's, not the client's.
  const wrongPeer = mintTicket(listener.tickets, DIALER);
  await assert.rejects(
    () => dial(listener, { ticket: wrongPeer, dialer: "C" }),
    refusedTicket,
    "a ticket bound to another device authenticated",
  );
  // A dial pinned to another identity is sealed to that device's key,
  // which the listener does not hold: it fails at the handshake and closes rather
  // than cache the wrong machine.
  const ticket = mintTicket(listener.tickets, DIALER);
  await assert.rejects(
    () => dial(listener, { ticket, expects: "X" }),
    (error) => error instanceof RemoteConnectError && error.blocked,
    "a dial pinned to another device linked to the listener",
  );
});

it("grant gate on the direct wire: mutating refused with the typed error pre-grant and the handler never runs, served post-grant, revoked live on the same socket", async () => {
  const listener = await startDirectListener(trackTest);
  const connection = await dial(listener);
  trackTest(() => connection.close());
  await assert.rejects(
    () => connection.transport.invoke(MUTATE, echoOf("p")),
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
  assert.equal(await connection.transport.invoke(ECHO, echoOf("read")), "read");
  // Grant: the SAME socket serves the mutation, no reconnect.
  listener.setAccepts(true);
  assert.equal(
    await connection.transport.invoke(MUTATE, echoOf("p")),
    undefined,
  );
  assert.equal(listener.mutateRuns(), 1);
  // Revoke: takes effect live at the next dispatch.
  listener.setAccepts(false);
  await assert.rejects(
    () => connection.transport.invoke(MUTATE, echoOf("p")),
    (error) => error instanceof CommandRefusedError,
    "a revoke did not take effect without a reconnect",
  );
  assert.equal(listener.mutateRuns(), 1);
});

it("supersede kills the old socket dead: nothing it delivers after the supersede executes a handler", async () => {
  const listener = await startDirectListener(trackTest);
  listener.setAccepts(true);
  const first = await dial(listener);
  assert.equal(await first.transport.invoke(MUTATE, echoOf("p")), undefined);
  assert.equal(listener.mutateRuns(), 1);
  // The same device dials again: the old socket is superseded AND
  // killed (dead flag set, signal aborted), so a mutating req it
  // delivers during the close grace window must execute nothing --
  // without the kill it would run twice.
  const second = await dial(listener);
  trackTest(() => second.close());
  await assert.rejects(
    () => first.transport.invoke(MUTATE, echoOf("p")),
    "an invoke on the superseded socket resolved",
  );
  // Let any frame that raced the close drain before counting.
  await delay(120);
  assert.equal(
    listener.mutateRuns(),
    1,
    "the superseded socket still executed a mutating handler",
  );
  assert.equal(await second.transport.invoke(MUTATE, echoOf("p")), undefined);
  assert.equal(listener.mutateRuns(), 2);
});

it("one round trip: a winning dial costs the device hub exactly one ask and one answer, and data then flows direct with the hub quiet", async () => {
  const listener = await startDirectListener(trackTest);
  const { stub, bridge } = await bridgeTo(trackTest, listener);
  const before = stub.receivedCount();
  await dialOn(bridge, LISTENER);
  const exchange = stub.received.slice(before);
  assert.deepEqual(
    exchange.map((entry) => `${entry.from}>${entry.to}`),
    [`${DIALER}>${LISTENER}`, `${LISTENER}>${DIALER}`],
    "the dial was not one ask and one answer",
  );
  const [ask, answer] = exchange;
  assert.ok(
    ask !== undefined && answer !== undefined,
    "the ask and its answer were not both received",
  );
  assert.equal(decodeRelayFrame(ask.frame)?.kind, "ask");
  assert.equal(decodeRelayFrame(answer.frame)?.kind, "answer");
  const baseline = stub.forwardedCount();
  assert.equal(await invokeListener(bridge, ECHO, echoOf("direct")), "direct");
  await delay(150);
  assert.equal(
    stub.forwardedCount(),
    baseline,
    "post-dial traffic still rode the device hub",
  );
});

it("presence scopes the data plane: a peer leaving a LIVE roster loses its direct sessions on both sides, our own hub link going down leaves them alone, and a stopped or revoked socket closes them all", async () => {
  const CONNECTED: SupervisorStatus = { phase: "connected" };
  const listener = await startDirectListener(trackTest);
  const { bridge } = await bridgeTo(trackTest, listener);
  const reconcileCalls: string[][] = [];
  const presenceDeps: DirectPresenceDeps = {
    closeHostPeersNotIn: (online) => listener.binding.closePeersNotIn(online),
    dropClientPeersNotIn: (online) => bridge.dropDirectPeersNotIn(online),
    reconcilePeers: (online) => reconcileCalls.push([...online]),
  };
  await dialOn(bridge, LISTENER);
  assert.deepEqual(await invokeListener(bridge, ECHO, echoOf("up")), "up");
  assert.deepEqual(Object.keys(bridge.directPeers().peerAppVersions), [
    LISTENER,
  ]);
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
  assert.deepEqual(Object.keys(bridge.directPeers().peerAppVersions), [
    LISTENER,
  ]);
  assert.deepEqual(
    await invokeListener(bridge, ECHO, echoOf("outage")),
    "outage",
  );
  // A live roster still naming the peer: nothing closes, and the
  // keeper receives the roster as its desired set.
  applyDirectPresence(CONNECTED, [DIALER, LISTENER], presenceDeps);
  assert.deepEqual(Object.keys(bridge.directPeers().peerAppVersions), [
    LISTENER,
  ]);
  assert.deepEqual(reconcileCalls.at(-1), [DIALER, LISTENER]);
  // The peer leaves the live roster: the cached client session
  // drops at once.
  applyDirectPresence(CONNECTED, [DIALER], presenceDeps);
  assert.deepEqual(bridge.directPeers().peerAppVersions, {});
  // Host side: an inbound authed direct socket dies when ITS
  // deviceId leaves the roster, and survives while present.
  let hostSideClosed = false;
  const inbound = await dial(listener, {
    onClose: () => (hostSideClosed = true),
  });
  applyDirectPresence(CONNECTED, [DIALER], presenceDeps);
  assert.equal(
    await inbound.transport.invoke(ECHO, echoOf("still here")),
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
  await dialOn(bridge, LISTENER);
  assert.deepEqual(Object.keys(bridge.directPeers().peerAppVersions), [
    LISTENER,
  ]);
  let inboundClosed = false;
  const inbound2 = await dial(listener, {
    onClose: () => (inboundClosed = true),
  });
  assert.equal(
    await inbound2.transport.invoke(ECHO, echoOf("before stop")),
    "before stop",
  );
  applyDirectPresence({ phase: "stopped" }, [DIALER, LISTENER], presenceDeps);
  assert.deepEqual(bridge.directPeers().peerAppVersions, {});
  assert.deepEqual(reconcileCalls.at(-1), []);
  await waitFor(
    () => inboundClosed,
    "a stopped socket to close the host-side sockets",
  );
  // A revoked block is the same verdict from the hub's side.
  await dialOn(bridge, LISTENER);
  assert.deepEqual(Object.keys(bridge.directPeers().peerAppVersions), [
    LISTENER,
  ]);
  applyDirectPresence(
    { phase: "blocked", reason: "revoked", message: "removed" },
    [LISTENER],
    presenceDeps,
  );
  assert.deepEqual(bridge.directPeers().peerAppVersions, {});
  // Any other block is an outage: the sessions ride it out.
  await dialOn(bridge, LISTENER);
  applyDirectPresence(
    { phase: "blocked", reason: "refused", message: "401" },
    [],
    presenceDeps,
  );
  assert.deepEqual(Object.keys(bridge.directPeers().peerAppVersions), [
    LISTENER,
  ]);
});

it("mid-dial sweeps: a peer leaving the roster while its dial is in flight ends the dial at once, closing what it opened and reporting nothing, and the quit sweep does the same", async () => {
  // Roster sweep: the peer leaves (revocation included) while its dial
  // is still in flight. Nothing is installed for a device the control
  // plane stopped vouching for, and the dial does not run on.
  for (const close of [
    (handlers: HubHandlers) => handlers.dropDirectPeersNotIn([]),
    (handlers: HubHandlers) => handlers.closeDirectPeers(),
  ]) {
    const held = heldDial();
    const ended = dialOn(held.handlers, LISTENER).then(
      () => "landed",
      () => "ended",
    );
    close(held.handlers);
    assert.equal(await ended, "ended");
    await waitFor(() => held.closed() === 1, "the in-flight dial to close");
    held.release();
    assert.deepEqual(held.handlers.directPeers().peerAppVersions, {});
    assert.equal(held.changes(), 0, "an ended dial fired onDirectChange");
  }
});

// A far end that takes a candidate's socket and never answers, so a
// dial sits mid-open until it is ended or out of budget, counting the
// sockets the far end took and the dial's sockets that closed.
async function silentCandidates(count: number) {
  const seen = { accepted: 0, closed: 0 };
  const server = await startLoopbackServer(() => {
    seen.accepted += 1;
  });
  trackTest(server.close);
  const { dialer } = fakeAskDialer(
    {
      available: true,
      acceptsCommands: false,
      sharesData: true,
      candidates: Array.from({ length: count }, (_, index) => ({
        kind: "lan" as const,
        url: `ws://127.0.0.1:${server.port}`,
        ticket: `smpt_silent_${index}`,
      })),
    },
    {
      deadlineMs: 1500,
      openSocket: (url) => {
        const socket = new WsClient(url);
        socket.on("close", () => {
          seen.closed += 1;
        });
        return socket;
      },
    },
  );
  return { seen, dialer };
}

const QUIET_STATUS = {
  socket: { phase: "connected" },
  onlineDeviceIds: [],
  peerAppVersions: {},
  peerAcceptsCommands: {},
  peerSharesData: {},
} as const;

it("a dial ended mid-open, by the roster sweep or the bridge's close, closes its candidates' sockets at once, and nothing more comes of it past its deadline", async () => {
  for (const end of ["the roster sweep", "the bridge's close"] as const) {
    const { seen, dialer } = await silentCandidates(2);
    let changes = 0;
    const scope = Scope.makeUnsafe();
    trackTest(() => Effect.runPromise(Scope.close(scope, Exit.void)));
    const bridge = Effect.runSync(
      Scope.provide(scope)(
        makeHubHandlers({
          status: () => QUIET_STATUS,
          connectDirect: (deviceId) => dialer.connectDirect(deviceId),
          onDirectChange: () => {
            changes += 1;
          },
        }),
      ),
    );
    const ended = dialOn(bridge, LISTENER).then(
      () => "landed",
      () => "ended",
    );
    await waitFor(() => seen.accepted === 2, "both candidates to be taken");
    const endedAt = Date.now();
    if (end === "the roster sweep") bridge.dropDirectPeersNotIn([]);
    else await Effect.runPromise(Scope.close(scope, Exit.void));
    assert.equal(await ended, "ended", end);
    await waitFor(() => seen.closed === 2, `${end} to close both sockets`);
    assert.ok(
      Date.now() - endedAt < 1000,
      `${end} left the sockets to the dial's deadline`,
    );
    await delay(1800);
    assert.equal(seen.accepted, 2, `the dial ran on after ${end}`);
    assert.equal(changes, 0, `an ended dial fired onDirectChange (${end})`);
  }
});

it("a dial that dies settles its waiters and leaves the slot empty, so the next dial starts afresh", async () => {
  let dials = 0;
  const bridge = madeOn(
    Context.empty(),
    makeHubHandlers({
      status: () => QUIET_STATUS,
      connectDirect: () =>
        Effect.suspend(() => {
          dials += 1;
          return Effect.die(new Error("the dialer threw"));
        }),
    }),
  );
  await assert.rejects(() => dialOn(bridge, LISTENER), /the dialer threw/);
  await assert.rejects(() => dialOn(bridge, LISTENER), /the dialer threw/);
  assert.equal(dials, 2, "the dead dial stayed in the cache");
});

it("a dial ended mid-ask drops its hub ask at once", async () => {
  let aborted = false;
  const dialer = createDirectDialer({
    askConnectInfo: (_deviceId, _input, _timeoutMs, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        });
      }),
    localDeviceId: DIALER,
    localAppVersion: "1.0.0",
    localKey: () => testDeviceKey(DIALER).pair,
    peerKey: (deviceId) => testDeviceKey(deviceId).pair.publicKey,
    deadlineMs: 1500,
  });
  const bridge = madeOn(
    Context.empty(),
    makeHubHandlers({
      status: () => QUIET_STATUS,
      connectDirect: (deviceId) => dialer.connectDirect(deviceId),
    }),
  );
  const ended = dialOn(bridge, LISTENER).then(
    () => "landed",
    () => "ended",
  );
  await delay(50);
  bridge.dropDirectPeersNotIn([]);
  assert.equal(await ended, "ended");
  await waitFor(() => aborted, "the hub ask to be dropped");
});

it("a dial's deadline runs on the bridge's clock, as everything else its fibers do", async () => {
  const { seen, dialer } = await silentCandidates(1);
  const clock = testClock();
  const bridge = madeOn(
    clock.context,
    makeHubHandlers({
      status: () => QUIET_STATUS,
      connectDirect: (deviceId) => dialer.connectDirect(deviceId),
    }),
  );
  let outcome: string | null = null;
  void dialOn(bridge, LISTENER).then(
    () => {
      outcome = "landed";
    },
    (error: unknown) => {
      outcome = errorMessageOf(error);
    },
  );
  await waitFor(() => seen.accepted === 1, "the candidate to be taken");
  // Past the deadline on the wall clock, and not on the bridge's.
  await delay(1800);
  assert.equal(outcome, null, "the deadline read the wall clock");
  await clock.advance(1500);
  await waitFor(() => outcome !== null, "the deadline on the bridge's clock");
  assert.match(outcome ?? "", /did not open|exceeded its 1500ms deadline/);
  await waitFor(() => seen.closed === 1, "the candidate's socket to close");
});

it("supervised and eager: presence alone establishes the session (no invoke anywhere), a host-side drop is redialed by the keeper on the shared ladder, and the plane's close latches the schedule", async () => {
  const listener = await startDirectListener(trackTest);
  // Supervised as production wires it, with the keeper on a TestClock
  // so the ladder is advanced by hand instead of slept out.
  const clock = testClock();
  const { bridge, stop } = await bridgeTo(trackTest, listener, {
    supervised: true,
    context: clock.context,
  });
  // Presence alone: the roster names the listener, so the keeper dials it
  // with no invoke and no ensure in sight.
  await waitFor(
    () => bridge.directPeers().peerAppVersions[LISTENER] !== undefined,
    "the keeper to establish the session off presence alone",
  );
  assert.deepEqual(bridge.directPeers().peerAppVersions, {
    [LISTENER]: "2.0.0",
  });
  // The established direct socket dies out from under the client
  // (the host closes it), and the cache drops the session.
  listener.binding.closePeersNotIn([]);
  await waitFor(
    () => Object.keys(bridge.directPeers().peerAppVersions).length === 0,
    "the dropped session to leave the cache",
  );
  // Nothing redials before the ladder's first rung...
  await clock.settle();
  assert.deepEqual(bridge.directPeers().peerAppVersions, {});
  // ...and the keeper redials at it, with no ensure/invoke: the
  // drop was a self-close, so supervision owns the recovery.
  await clock.advance(BACKOFF_LADDER_MS[0]);
  await waitFor(
    () => bridge.directPeers().peerAppVersions[LISTENER] !== undefined,
    "the keeper to redial the dropped session",
  );
  assert.deepEqual(
    await invokeListener(bridge, ECHO, echoOf("recovered")),
    "recovered",
  );
  // Quit: the plane's close is BOTH halves in the order that matters
  // (latch, then close every cached session), so the cache is empty
  // once it is done and nothing a drop or a pending timer does
  // afterwards can dial a fresh session into the teardown.
  await stop();
  assert.deepEqual(bridge.directPeers().peerAppVersions, {});
  listener.binding.closePeersNotIn([]);
  await clock.advance(lastOf(BACKOFF_LADDER_MS) * 4);
  await delay(50);
  assert.deepEqual(
    bridge.directPeers().peerAppVersions,
    {},
    "a latched keeper still redialed after the close",
  );
});

it("command access on the answer and live: the connectInfo answer's switch lands in the bridge's snapshot, the host's flips reach it as pushes over the SAME direct session, and a redial's answer carries the switch as it stands", async () => {
  const listener = await startDirectListener(trackTest);
  const snapshots: HubStatus[] = [];
  const { plane, bridge } = await bridgeTo(trackTest, listener, {
    onStatusChange: (status) => snapshots.push(status),
  });
  await dialOn(bridge, LISTENER);
  // Off at dial time: the answer said so, before any call.
  assert.deepEqual(bridge.directPeers().peerAcceptsCommands, {
    [LISTENER]: false,
  });
  assert.deepEqual(plane.status().peerAcceptsCommands, { [LISTENER]: false });
  // On: the host's push moves the snapshot, and fans it out.
  const fannedBefore = snapshots.length;
  listener.setAccepts(true);
  await waitFor(
    () => bridge.directPeers().peerAcceptsCommands[LISTENER] === true,
    "the switch-on push to reach the bridge",
  );
  assert.ok(
    snapshots
      .slice(fannedBefore)
      .some((status) => status.peerAcceptsCommands[LISTENER] === true),
    "the flip never fanned a fresh status out",
  );
  // The gate agrees with what the snapshot says.
  assert.equal(await invokeListener(bridge, MUTATE, echoOf("p")), undefined);
  // Off again, live on the same socket, and the gate refuses.
  listener.setAccepts(false);
  await waitFor(
    () => bridge.directPeers().peerAcceptsCommands[LISTENER] === false,
    "the switch-off push to reach the bridge",
  );
  await assert.rejects(
    async () => invokeListener(bridge, MUTATE, echoOf("p")),
    (error) => error instanceof CommandRefusedError,
  );
  // A fresh dial reads the switch off its answer again.
  listener.setAccepts(true);
  bridge.closeDirectPeers();
  assert.deepEqual(bridge.directPeers().peerAcceptsCommands, {});
  await dialOn(bridge, LISTENER);
  assert.deepEqual(bridge.directPeers().peerAcceptsCommands, {
    [LISTENER]: true,
  });
});

it("sharing on the answer and live: the answer's switch lands in the snapshot, the host's flips reach it as pushes over the same session, and with it off the gate refuses even a read", async () => {
  const listener = await startDirectListener(trackTest);
  const { plane, bridge } = await bridgeTo(trackTest, listener);
  await dialOn(bridge, LISTENER);
  assert.deepEqual(plane.status().peerSharesData, { [LISTENER]: true });
  listener.setSharing(false);
  await waitFor(
    () => plane.status().peerSharesData[LISTENER] === false,
    "the sharing-off push to reach the snapshot",
  );
  await assert.rejects(
    async () => invokeListener(bridge, ECHO, echoOf("p")),
    (error) => error instanceof NotSharingError,
  );
  // A fresh dial reads it off the answer.
  bridge.closeDirectPeers();
  await dialOn(bridge, LISTENER);
  assert.deepEqual(plane.status().peerSharesData, { [LISTENER]: false });
  listener.setSharing(true);
  await waitFor(
    () => plane.status().peerSharesData[LISTENER] === true,
    "the sharing-on push to reach the snapshot",
  );
  assert.equal(await invokeListener(bridge, ECHO, echoOf("p")), "p");
});

it("routing: the cache is direct or nothing, directPeers reports the direct session, and a closed direct socket drops the cache, refuses sessionless invokes and rejects typed on the next dial", async () => {
  const listener = await startDirectListener(trackTest);
  // The plane fans a status snapshot out on every direct open and
  // close (the same statusChanged fan-out a device hub transition
  // fires), so the counter reads that seam.
  let directChanges = 0;
  const { stub, bridge } = await bridgeTo(trackTest, listener, {
    onStatusChange: () => {
      directChanges += 1;
    },
  });
  // Direct available: the keeper-shaped dial establishes the
  // session, and invokes ride it leaving the device hub flat.
  await dialOn(bridge, LISTENER);
  assert.deepEqual(await invokeListener(bridge, ECHO, echoOf("1")), "1");
  assert.deepEqual(Object.keys(bridge.directPeers().peerAppVersions), [
    LISTENER,
  ]);
  // The welcome-confirmed version surfaces for the direct session,
  // so the owner's status snapshot can feed the skew check.
  assert.deepEqual(bridge.directPeers().peerAppVersions, {
    [LISTENER]: "2.0.0",
  });
  assert.equal(
    directChanges,
    1,
    "opening a direct session never fired onDirectChange",
  );
  const baseline = stub.forwardedCount();
  assert.deepEqual(await invokeListener(bridge, ECHO, echoOf("2")), "2");
  assert.equal(
    stub.forwardedCount(),
    baseline,
    "a cached direct session still rode the device hub",
  );
  // Closing the direct socket (listener teardown) drops the cache
  // and the direct marker.
  await listener.binding.reconcile(null);
  await waitFor(
    () => Object.keys(bridge.directPeers().peerAppVersions).length === 0,
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
    async () => invokeListener(bridge, ECHO, echoOf("3")),
    /no direct connection to listener/,
  );
  // The keeper's next dial re-decides: the host answers
  // unavailable now and there is nothing to fall back to, so the
  // attempt rejects with the typed unreachable outcome and the
  // cache stays empty.
  await assert.rejects(
    () => dialOn(bridge, LISTENER),
    /offers no direct listener/,
  );
  assert.deepEqual(bridge.directPeers().peerAppVersions, {});
});

it("a link that drops under a call is no session, in words: the call a woken window made on a link that died meanwhile fails as no direct connection, which a query waits out quietly and an action reports", async () => {
  const listener = await startDirectListener(trackTest);
  const { bridge } = await bridgeTo(trackTest, listener);
  await dialOn(bridge, LISTENER);
  const held = invokeListener(bridge, HOLD, echoOf("p"));
  await waitFor(() => listener.hold.started, "the held call to start");
  await listener.binding.reconcile(null);
  await assert.rejects(
    async () => held,
    (error) =>
      error instanceof NoDirectConnectionError &&
      error.message ===
        `no direct connection to ${LISTENER} (remote device disconnected)`,
  );
});

it("unreachable is typed: a failed direct dial rejects the invoke with the dial error and creates no hub data session", async () => {
  const listener = await startDirectListener(trackTest);
  // Free the port, then keep ADVERTISING it: the host hands out
  // tickets and a port nobody listens on, so the dial itself fails
  // and the failure is the outcome (direct or nothing).
  const deadPort = listener.port;
  await listener.binding.reconcile(null);
  listener.listenerPort = () => deadPort;
  const { stub, bridge } = await bridgeTo(trackTest, listener, {
    deadlineMs: 1500,
  });
  const before = stub.receivedCount();
  // An invoke racing the in-flight dial shares its fate as no session,
  // in the dial's words.
  const inFlight = dialOn(bridge, LISTENER);
  await assert.rejects(
    async () => invokeListener(bridge, ECHO, echoOf("unreachable")),
    (error) =>
      error instanceof NoDirectConnectionError &&
      /ECONNREFUSED/.test(error.message),
  );
  await assert.rejects(
    () => inFlight,
    (error) =>
      error instanceof RemoteConnectError &&
      // The exhaustion message names the candidate and, through
      // the ws socket the host injects, the errno itself, which is
      // what makes a failed dial diagnosable on the account page.
      /lan ws:\/\/.*ECONNREFUSED/.test(error.message),
  );
  assert.deepEqual(bridge.directPeers().peerAppVersions, {});
  // Nothing rode the device hub for the data: the one ask and its
  // answer, and after them nothing from the dialer reaches the listener through it.
  assert.equal(stub.receivedCount() - before, 2);
  const baseline = stub.receivedCount();
  await delay(200);
  assert.equal(
    stub.receivedCount(),
    baseline,
    "something kept riding the device hub after the failed dial",
  );
});

// Sockets that fail as the platform would, each with an errno its
// kind can die of: no route on the LAN, and for the tunnel a name the
// dialer's resolver can't answer.
function failingSocket(url: string) {
  const ws = new WsClient("ws://127.0.0.1:1");
  const emit = ws.emit.bind(ws);
  ws.emit = (event: string | symbol, ...args: unknown[]) =>
    event === "error"
      ? emit(
          event,
          Object.assign(new Error("failed"), {
            code: url.startsWith("wss:") ? "ENOTFOUND" : "EHOSTUNREACH",
          }),
        )
      : emit(event, ...args);
  return ws;
}

it("the no-route hint names the LAN addresses it tried and, beside it, why the tunnel failed: machines on different networks fail their LAN addresses the same way, and there the tunnel is the path", async () => {
  const lan = {
    kind: "lan",
    url: "ws://192.168.1.20:42017",
    ticket: "smpt_x",
  } as const;
  const tunnel = {
    kind: "tunnel",
    url: "wss://sm-x.sm.example.test",
    ticket: "smpt_x",
  } as const;
  const failureOf = async (
    candidates: Extract<DirectConnectInfo, { available: true }>["candidates"],
  ) => {
    const dialer = createDirectDialer({
      askConnectInfo: async () => ({
        available: true,
        acceptsCommands: true,
        sharesData: true,
        candidates,
      }),
      localDeviceId: DIALER,
      localAppVersion: "1.0.0",
      localKey: () => testDeviceKey(DIALER).pair,
      peerKey: (deviceId) => testDeviceKey(deviceId).pair.publicKey,
      openSocket: failingSocket,
      deadlineMs: 4000,
    });
    const error = await connectOnce(dialer, LISTENER).then(
      () => assert.fail("the dial landed"),
      (failure: unknown) => failure,
    );
    assert.ok(error instanceof RemoteConnectError);
    return error.message;
  };
  const both = await failureOf([lan, tunnel]);
  assert.match(
    both,
    /No route to ws:\/\/192\.168\.1\.20:42017: if both machines share a network, macOS may be denying this app Local Network access/,
  );
  assert.match(
    both,
    /If they don't, the tunnel was the path, and it failed: .*ENOTFOUND/,
  );
  const lanOnly = await failureOf([lan]);
  assert.match(lanOnly, /The peer offered no tunnel endpoint/);
  assert.match(lanOnly, /No route to ws:\/\/192\.168\.1\.20:42017: /);
  assert.doesNotMatch(lanOnly, /the tunnel was the path/);
});

it("pushes: a host broadcast reaches a direct-connected client through the shared peerPush path, tagged with the peer's deviceId", async () => {
  const listener = await startDirectListener(trackTest);
  const pushes: HubPeerPush[] = [];
  const { stub, bridge } = await bridgeTo(trackTest, listener, {
    onPeerPush: (push) => pushes.push(push),
  });
  // A keeper-shaped dial and nothing else: the session comes up
  // with no invoke, then the host's fan-out reaches it over the
  // direct socket.
  await dialOn(bridge, LISTENER);
  assert.deepEqual(Object.keys(bridge.directPeers().peerAppVersions), [
    LISTENER,
  ]);
  const baseline = stub.forwardedCount();
  listener.binding.broadcastAll("git:projectChanged", { projectId: "seven" });
  await waitFor(() => pushes.length > 0, "the direct push");
  assert.deepEqual(pushes[0], {
    deviceId: LISTENER,
    channel: "git:projectChanged",
    payload: { projectId: "seven" },
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
    sharesData: () => true,
  });
  const all = {
    dialableKinds: ["lan", "tunnel"],
    connectionId: ONE_CONNECTION,
  };
  // Unhealthy tunnel: lan candidates only, with IPv6 literals
  // bracketed into dialable URLs.
  const without = await connectInfo(DIALER, all);
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
  const withTunnel = await connectInfo(DIALER, all);
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
  const only = await makeConnectInfo({
    listenerPort: () => 42017,
    mintTickets: (_peer, kinds) => kinds.map((_kind, i) => `smpt_only_${i}`),
    candidateAddresses: () => [],
    tunnelUrl: () => tunnel,
    acceptsCommands: () => false,
    sharesData: () => true,
  })(DIALER, all);
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
  const tunnelOnly = await connectInfo(DIALER, {
    dialableKinds: ["tunnel"],
    connectionId: ONE_CONNECTION,
  });
  assert.equal(tunnelOnly.available, true);
  assert.deepEqual(
    tunnelOnly.candidates.map(({ kind }) => kind),
    ["tunnel"],
  );
  assert.equal(minted.length, before + 1);
  assert.equal(minted.at(-1)?.length, 1, "a lan ticket was minted anyway");
  const lanOnly = await connectInfo(DIALER, {
    dialableKinds: ["lan"],
    connectionId: ONE_CONNECTION,
  });
  assert.equal(lanOnly.available, true);
  assert.deepEqual(
    lanOnly.candidates.map(({ kind }) => kind),
    ["lan", "lan"],
  );
  tunnel = null;
  const nothing = await connectInfo(DIALER, {
    dialableKinds: ["tunnel"],
    connectionId: ONE_CONNECTION,
  });
  const mintsSoFar = minted.length;
  assert.deepEqual(nothing, { available: false });
  assert.equal(
    minted.length,
    mintsSoFar,
    "a ticket was minted for an undialable caller",
  );
});

it("the listener logs each peer it links, with the path it came in on", async () => {
  const listener = await startDirectListener(trackTest);
  const lines: string[] = [];
  const info = console.info;
  console.info = (...parts: unknown[]) => {
    lines.push(parts.join(" "));
  };
  try {
    const connection = await dial(listener);
    trackTest(() => connection.close());
  } finally {
    console.info = info;
  }
  assert.deepEqual(
    lines.filter((line) => line.startsWith("[link]")),
    [`[link] ${DIALER} linked over lan from 127.0.0.1`],
  );
});

it("connectInfo logs what an asker was offered when it changes, not at every ask", async () => {
  let tunnel: string | null = null;
  let port: number | null = 42017;
  const connectInfo = makeConnectInfo({
    listenerPort: () => port,
    mintTickets: (_peer, kinds) => kinds.map((_kind, i) => `smpt_log_${i}`),
    candidateAddresses: () => ["127.0.0.1", "fd00::1"],
    tunnelUrl: () => tunnel,
    acceptsCommands: () => false,
    sharesData: () => true,
  });
  const all = {
    dialableKinds: ["lan", "tunnel"],
    connectionId: ONE_CONNECTION,
  };
  const lines: string[] = [];
  const info = console.info;
  console.info = (...parts: unknown[]) => {
    lines.push(parts.join(" "));
  };
  try {
    await connectInfo(DIALER, all);
    await connectInfo(DIALER, all);
    tunnel = "wss://sm-0123456789ab.sm.example.test";
    await connectInfo(DIALER, all);
    port = null;
    await connectInfo(DIALER, all);
  } finally {
    console.info = info;
  }
  assert.deepEqual(lines, [
    `[direct] ${DIALER} asked how to connect: offered lan`,
    `[direct] ${DIALER} asked how to connect: offered lan, tunnel`,
    `[direct] ${DIALER} asked how to connect: offered nothing to dial`,
  ]);
});

it("a host just restarted: an ask only its tunnel could answer waits for the tunnel that is starting and carries it once it is up, while an ask it can answer now is answered at once", async () => {
  let tunnel: string | null = null;
  let comes: (up: boolean) => void = notYetSet;
  let waits = 0;
  const connectInfo = makeConnectInfo({
    listenerPort: () => 42017,
    mintTickets: (_peer, kinds) => kinds.map((_kind, i) => `smpt_held_${i}`),
    candidateAddresses: () => ["127.0.0.1"],
    tunnelUrl: () => tunnel,
    tunnelStartingThenUp: (withinMs) => {
      waits += 1;
      assert.equal(withinMs, TUNNEL_HOLD_MS);
      return new Promise((resolve) => {
        comes = resolve;
      });
    },
    acceptsCommands: () => false,
    sharesData: () => true,
  });
  const lanToo = await connectInfo(DIALER, {
    dialableKinds: ["lan", "tunnel"],
    connectionId: ONE_CONNECTION,
  });
  assert.equal(lanToo.available, true);
  assert.equal(waits, 0, "an ask the LAN answers waited on the tunnel");
  const tunnelOnly = {
    dialableKinds: ["tunnel"],
    connectionId: ONE_CONNECTION,
  };
  let answered: DirectConnectInfo | undefined;
  const held = connectInfo(DIALER, tunnelOnly).then((answer) => {
    answered = answer;
    return answer;
  });
  await waitFor(() => waits === 1, "the ask to wait on the tunnel");
  assert.equal(answered, undefined, "answered before the tunnel was up");
  tunnel = "wss://sm-0123456789ab.sm.example.test";
  comes(true);
  const up = await held;
  assert.ok(up.available);
  assert.deepEqual(
    up.candidates.map(({ kind, url }) => ({ kind, url })),
    [{ kind: "tunnel", url: tunnel }],
  );
  // A tunnel that does not come up in time: nothing, as before.
  tunnel = null;
  const late = connectInfo(DIALER, tunnelOnly);
  await waitFor(() => waits === 2, "the second ask to wait");
  comes(false);
  assert.deepEqual(await late, { available: false });
});

it("dialableKinds (the web path): the declared capability reaches the host over the wire, which mints only the tunnel ticket, and a tunnel-less peer is the plain unreachable outcome", async () => {
  const listener = await startDirectListener(trackTest);
  // A well-formed but unroutable tunnel hostname: a check cannot
  // stand up a real wss endpoint (the no-port invariant pins the
  // tunnel to 443), so this scenario pins the BROKER half (what
  // was minted) and the failure outcome, while the race mechanics
  // are pinned by the lan scenarios above through the same code
  // path.
  const minted: string[][] = [];
  const { bridge } = await bridgeTo(trackTest, listener, {
    // A REACHABLE lan candidate the host must NOT mint for a
    // tunnel-only caller.
    candidateAddresses: () => ["127.0.0.1"],
    tunnelUrl: () => "wss://sm-check-nonexistent.invalid",
    onMinted: (tickets) => {
      minted.push(tickets);
    },
    dialableKinds: ["tunnel"],
    deadlineMs: 2500,
  });
  // The dial cannot succeed (unroutable hostname), so the attempt
  // rejects as unreachable: direct or nothing. Typed pin: the
  // failed candidate socket surfaces as the connect error.
  await assert.rejects(
    () => dialOn(bridge, LISTENER),
    (error) => error instanceof RemoteConnectError,
  );
  assert.deepEqual(bridge.directPeers().peerAppVersions, {});
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
  const { bridge: bareBridge } = await bridgeTo(trackTest, bare, {
    candidateAddresses: () => ["127.0.0.1"],
    onMinted: (tickets) => {
      bareMinted.push(tickets);
    },
    dialableKinds: ["tunnel"],
    deadlineMs: 2000,
  });
  await assert.rejects(
    () => dialOn(bareBridge, LISTENER),
    /offers no direct listener/,
    "a kind-filtered empty answer was not the plain unavailable outcome",
  );
  assert.equal(bareMinted.length, 0, "an undialable caller minted tickets");
});

it("a listener-less peer is a TERMINAL verdict: the browser binding's no-listener answer yields NoDialableCandidateError and PARKS, while a peer whose server merely threw stays on the ladder", async () => {
  const stub = await startStubHub(trackTest);
  // The listener is the REAL browser binding (web/hub/connection.ts), which
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
    LISTENER,
    { createConnection: createWebConnection, label: "the web listener" },
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
  const dialer = await bootDevice(stub, DIALER, {}, trackTest);
  await waitFor(
    () =>
      dialer.connection.status().onlineDeviceIds.includes(LISTENER) &&
      dialer.connection.status().onlineDeviceIds.includes("C"),
    "the roster to name both peers",
  );
  const { bridge } = makeDirectBridge(dialer);
  let verdict: unknown;
  await assert.rejects(
    () => dialOn(bridge, LISTENER),
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
  // The discriminator is the no-listener CODE, never "the ask was
  // refused": a server that threw is one bad call, so it keeps its
  // place on the ladder.
  await assert.rejects(
    () => dialOn(bridge, "C"),
    (error) => {
      assert.ok(
        !(error instanceof NoDialableCandidateError),
        "a thrown connectInfo server was misread as structural and parked",
      );
      return true;
    },
  );
  // Parked with no timer, and the roster round trip is the only
  // thing that redials it -- the right lifecycle for a tab that
  // may later become a host.
  const { keeper, clock, dials } = stubKeeper(verdict);
  keeper.reconcile([LISTENER]);
  await clock.settle();
  assert.equal(dials.length, 1);
  await clock.advance(lastOf(BACKOFF_LADDER_MS) * 100);
  assert.equal(dials.length, 1, "a listener-less peer redialed on the ladder");
  keeper.reconcile([]);
  keeper.reconcile([LISTENER]);
  await clock.settle();
  assert.equal(dials.length, 2, "the roster round trip did not redial");
});

it("dial now: the network coming back ends a peer's wait on the shared ladder, and the hub supervisor's backoff, at once; outside a wait it does nothing", async () => {
  const { keeper, clock, dials } = stubKeeper(new Error("listener down"));
  keeper.reconcile([LISTENER]);
  await clock.settle();
  // Up the ladder to its top rung, the 16 s wait a long outage leaves.
  for (const delayMs of BACKOFF_LADDER_MS.slice(0, -1)) {
    await clock.advance(delayMs);
  }
  const climbed = dials.length;
  assert.equal(climbed, BACKOFF_LADDER_MS.length);
  await clock.advance(1_000);
  keeper.dialNow();
  await clock.settle();
  assert.equal(dials.length, climbed + 1, "dial now waited out the rung");
  // The ladder goes on from where it was: the next failure waits the
  // top rung again, not the bottom.
  await clock.advance(lastOf(BACKOFF_LADDER_MS) - 1);
  assert.equal(dials.length, climbed + 1);
  await clock.advance(1);
  assert.equal(dials.length, climbed + 2);

  const hubClock = testClock();
  let connects = 0;
  const statuses: SupervisorStatus[] = [];
  const supervisor = madeOn(
    hubClock.context,
    supervise({
      classifyClose: () => null,
      // Failing a turn later, as a real dial does.
      connect: () => {
        connects += 1;
        return Effect.andThen(Effect.yieldNow, Effect.fail("hub unreachable"));
      },
      onStatus: (status) => statuses.push(status),
    }),
  );
  // Outside a backoff (the first attempt not yet failed) it does
  // nothing.
  supervisor.dialNow();
  await hubClock.settle();
  assert.equal(connects, 1);
  assert.equal(statuses.at(-1)?.phase, "backoff");
  supervisor.dialNow();
  await hubClock.settle();
  assert.equal(connects, 2, "the supervisor waited out its backoff");
});

it("keeper discipline: eager dial on roster entry, the exact shared ladder on transient failures (capped, forever), roster exit cancels, and a stable session's drop resets the ladder", async () => {
  const { keeper, clock, dials, succeed } = stubKeeper(
    new Error("listener down"),
  );
  // Eager: the peer entering the roster dials at once, and a
  // steady roster re-fed dials nothing new.
  keeper.reconcile([LISTENER]);
  await clock.settle();
  assert.equal(dials.length, 1);
  assert.deepEqual(dials[0], { deviceId: LISTENER, at: 0 });
  keeper.reconcile([LISTENER]);
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
    await clock.advance(delayMs - 1);
    assert.equal(dials.length, before, `rung ${i} fired early`);
    await clock.advance(1);
    assert.equal(dials.length, before + 1, `rung ${i} never fired`);
  }
  // The keeper's last failure is the no-session explanation the
  // bridge folds into its refusal.
  assert.equal(keeper.unavailableReason(LISTENER), "listener down");
  // Roster exit cancels the schedule outright.
  keeper.reconcile([]);
  await clock.advance(lastOf(BACKOFF_LADDER_MS) * 4);
  const settled = dials.length;
  assert.equal(settled, 1 + expected.length, "a swept peer kept dialing");
  // Re-entry starts fresh at the bottom rung: dial now, and a
  // failure waits ladder[0], not the inherited cap.
  keeper.reconcile([LISTENER]);
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
  assert.equal(keeper.unavailableReason(LISTENER), null);
  await clock.advance(STABLE_CONNECTION_MS);
  keeper.peerDropped(LISTENER);
  await clock.advance(BACKOFF_LADDER_MS[0]);
  assert.equal(
    dials.length,
    connectedAt + 1,
    "a stable drop did not redial at the bottom rung",
  );
  // An UNSTABLE drop keeps climbing instead: rung 1 next, so a
  // connect-then-die flapper cannot hammer at the bottom.
  keeper.peerDropped(LISTENER);
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
});

it("keeper parks on a peer with no listener with NO timer, and the peer's roster round trip is what redials it", async () => {
  const { keeper, clock, dials, succeed } = stubKeeper(
    new NoDialableCandidateError(LISTENER),
  );
  keeper.reconcile([LISTENER]);
  await clock.settle();
  assert.equal(dials.length, 1);
  // Parked: a web client serves no listener while it is one, so no
  // amount of time redials it.
  await clock.advance(lastOf(BACKOFF_LADDER_MS) * 100);
  assert.equal(dials.length, 1, "a parked peer redialed on a timer");
  assert.equal(
    keeper.unavailableReason(LISTENER),
    "peer listener serves no direct listener",
  );
  // A steady roster does not unpark either...
  keeper.reconcile([LISTENER]);
  await clock.advance(lastOf(BACKOFF_LADDER_MS));
  assert.equal(dials.length, 1, "a steady roster unparked the peer");
  // ...but the peer's offline-to-online transition does (its app
  // restarted, or our own link came back: both reset the roster
  // diff), and the fresh dial may now succeed.
  succeed();
  keeper.reconcile([]);
  keeper.reconcile([LISTENER]);
  await clock.settle();
  assert.equal(dials.length, 2, "the roster round trip did not redial");
  assert.equal(keeper.unavailableReason(LISTENER), null);
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
// `exit` to play it dying, by a signal from outside when given one.
// `killed` is its scope closing while it ran.
type StubTunnelChild = {
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined> | undefined;
  readonly detached: boolean | undefined;
  killed: boolean;
  exit: (signal?: NodeJS.Signals) => void;
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
      const exit = yield* Deferred.make<number | NodeJS.Signals>();
      const child: StubTunnelChild = {
        args: command.args,
        env: command.options.env,
        detached: command.options.detached,
        killed: false,
        exit: (signal) => Effect.runSync(Deferred.succeed(exit, signal ?? 1)),
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
        // A signal's death fails the exit code, as the platform's does.
        exitCode: Deferred.await(exit).pipe(
          Effect.flatMap((ended) =>
            typeof ended === "number"
              ? Effect.succeed(ChildProcessSpawner.ExitCode(ended))
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "ChildProcess",
                    method: "exitCode",
                    description: `Process interrupted due to receipt of signal: '${ended}'`,
                  }),
                ),
          ),
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
  // The test clock with its wall clock moved by `stepWall` alone, for
  // the runner a reconcile starts.
  let wallOffset = 0;
  const stepped = runtime.runSync(
    TestClock.testClockWith((test) =>
      Effect.succeed<Clock.Clock>({
        ...test,
        currentTimeMillisUnsafe: () =>
          test.currentTimeMillisUnsafe() + wallOffset,
        currentTimeMillis: Effect.sync(
          () => test.currentTimeMillisUnsafe() + wallOffset,
        ),
      }),
    ),
  );
  return {
    spawned,
    reconcile: async (wanted: { port: number } | null) => {
      await runtime.runPromise(
        onTunnel((tunnel) => tunnel.reconcile(wanted)).pipe(
          Effect.provideService(Clock.Clock, stepped),
        ),
      );
      await settleTunnel();
    },
    recheck: async () => {
      await runtime.runPromise(onTunnel((tunnel) => tunnel.recheck));
      await settleTunnel();
    },
    stepWall: (ms: number) => {
      wallOffset += ms;
    },
    status: () => runtime.runSync(onTunnel((tunnel) => tunnel.status)),
    tunnelUrl: () => runtime.runSync(onTunnel((tunnel) => tunnel.tunnelUrl)),
    startingThenUp: (ms: number) =>
      runtime.runPromise(
        onTunnel((tunnel) => tunnel.startingThenUp(Duration.millis(ms))),
      ),
    advance: async (ms: number) => {
      await runtime.runPromise(TestClock.adjust(ms));
      await settleTunnel();
    },
    dispose,
  };
}

it("cloudflared runner: a wake's recheck takes an up tunnel that no longer routes off the advertisement, brings it back on the same child once it routes, and replaces one that never does; a clock step spends none of the deadline", async () => {
  let routes = true;
  const tunnel = await tunnelHarness({
    provision: async () => ({
      hostname: "h.example.test",
      connectorToken: "t",
      dnsCreated: false,
    }),
    probe: () => routes,
  });
  await tunnel.reconcile({ port: 40100 });
  await tunnel.advance(TUNNEL_PROBE_DELAYS_REUSED_MS[0]);
  assert.equal(tunnel.status().state, "up");

  // A wake on a network still coming back: off, then back, same child.
  routes = false;
  await tunnel.recheck();
  assert.equal(tunnel.status().state, "starting");
  assert.equal(tunnel.tunnelUrl(), null);
  await tunnel.advance(1_000);
  routes = true;
  await tunnel.advance(2_000);
  assert.equal(tunnel.status().state, "up");
  assert.equal(tunnel.spawned.length, 1);

  // A stopped connector: alive, routing nothing. Two hours of wall
  // clock step in, which the deadline doesn't count.
  routes = false;
  await tunnel.recheck();
  tunnel.stepWall(2 * 3_600_000);
  await tunnel.advance(TUNNEL_PROBE_DEADLINE_MS - 10_000);
  assert.equal(tunnel.status().state, "starting");
  assert.equal(tunnel.spawned.length, 1);
  assert.equal(tunnel.spawned[0]?.killed, false);
  await tunnel.advance(10_000 + TUNNEL_PROBE_SLOW_MS);
  assert.equal(
    tunnel.spawned[0]?.killed,
    true,
    "the stuck child was not ended",
  );
  routes = true;
  await tunnel.advance(TUNNEL_BACKOFF_LADDER_MS[0] + 8_000);
  assert.equal(tunnel.spawned.length, 2, "started again once");
  assert.equal(tunnel.status().state, "up");
});

it("cloudflared runner: no-binary is a typed terminal state, and an unconfigured Worker is asked again on an interval, at a wake and on a reconcile, so a redeploy brings the tunnel up", async () => {
  // Missing binary: reported, and provisioning never even runs.
  let binaryPath: string | null = null;
  let provisions = 0;
  const noBinary = await tunnelHarness({
    resolveBinary: () => binaryPath,
    provision: async () => {
      provisions += 1;
      return {
        hostname: "h.example.test",
        connectorToken: "t",
        dnsCreated: false,
      };
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
  // Worker unconfigured: a deployment setting, which a redeploy changes,
  // so the runner asks again on its interval, at once after a wake, and
  // on a reconcile, and starts the tunnel once the Worker provisions.
  let configured = false;
  let unconfiguredCalls = 0;
  const unconfigured = await tunnelHarness({
    provision: async () => {
      unconfiguredCalls += 1;
      if (!configured) throw new HubTunnelUnconfiguredError();
      return {
        hostname: "h.example.test",
        connectorToken: "t",
        dnsCreated: false,
      };
    },
  });
  await unconfigured.reconcile({ port: 40100 });
  assert.equal(unconfigured.status().state, "unconfigured");
  assert.equal(unconfiguredCalls, 1);
  await unconfigured.advance(UNCONFIGURED_RETRY_MS - 1_000);
  assert.equal(unconfiguredCalls, 1, "asked again before its interval");
  await unconfigured.advance(1_000);
  assert.equal(unconfiguredCalls, 2, "not asked again on its interval");
  assert.equal(unconfigured.status().state, "unconfigured");
  // A wake asks at once, without waiting out the interval.
  await unconfigured.recheck();
  assert.equal(unconfiguredCalls, 3, "a wake did not ask again");
  // A same-port reconcile (a re-sign-in, a config write) asks too.
  await unconfigured.reconcile({ port: 40100 });
  assert.equal(unconfiguredCalls, 4, "a reconcile did not ask again");
  assert.equal(unconfigured.spawned.length, 0, "spawned while unconfigured");
  // The hub redeployed with its tunnel env: the next ask starts it.
  configured = true;
  await unconfigured.recheck();
  assert.equal(unconfiguredCalls, 5);
  assert.equal(unconfigured.spawned.length, 1);
  await unconfigured.advance(TUNNEL_PROBE_DELAYS_REUSED_MS[0]);
  assert.equal(unconfigured.status().state, "up");
  // Once up, a stop and a start ask the Worker again like any start.
  await unconfigured.reconcile(null);
  configured = false;
  await unconfigured.reconcile({ port: 40100 });
  assert.equal(unconfiguredCalls, 6);
  assert.equal(unconfigured.status().state, "unconfigured");
  // A stop in the wait forgets the answer: a wake after it asks
  // nothing, and the next start asks at once.
  await unconfigured.reconcile(null);
  await unconfigured.recheck();
  assert.equal(unconfiguredCalls, 6, "a wake after a stop asked");
  await unconfigured.reconcile({ port: 40100 });
  assert.equal(unconfiguredCalls, 7, "a start after a stop did not ask");
  // A clock step is no wake: the wall clock moved past the interval
  // with no elapsed time asks nothing.
  unconfigured.stepWall(UNCONFIGURED_RETRY_MS * 2);
  await unconfigured.advance(0);
  assert.equal(unconfiguredCalls, 7, "a wall-clock step asked");
});

it("cloudflared runner: a transient failure while an unconfigured answer is waited out is waited out too, and a cached provision that comes up again leaves same-port reconciles alone", async () => {
  // The Worker's answers in order, then provisions.
  const answers: Array<"unconfigured" | "offline"> = [
    "unconfigured",
    "offline",
  ];
  let asks = 0;
  const runner = await tunnelHarness({
    provision: async (port) => {
      asks += 1;
      const answer = answers.shift();
      if (answer === "unconfigured") throw new HubTunnelUnconfiguredError();
      if (answer === "offline") throw new Error("getaddrinfo ENOTFOUND");
      return {
        hostname: `h${port}.example.test`,
        connectorToken: "t",
        dnsCreated: false,
      };
    },
  });
  await runner.reconcile({ port: 40100 });
  assert.equal(runner.status().state, "unconfigured");
  // A wake on a network still coming back: the ask fails, and the
  // runner keeps waiting rather than stepping onto its error ladder,
  // saying the tunnel is down rather than the hub unconfigured.
  await runner.recheck();
  assert.equal(asks, 2);
  assert.equal(runner.status().state, "error");
  await runner.advance(TUNNEL_BACKOFF_LADDER_MS[0] * 4);
  assert.equal(asks, 2, "the failed ask went onto the restart ladder");
  await runner.recheck();
  assert.equal(asks, 3);
  await runner.advance(TUNNEL_PROBE_DELAYS_REUSED_MS[0]);
  assert.equal(runner.status().state, "up");
  assert.equal(runner.spawned.length, 1);
  // The Worker loses its env, the listener moves, and moves back: the
  // first port's provision is reused and comes up, and a reconcile of
  // that port after it leaves the child alone.
  answers.push("unconfigured");
  await runner.reconcile({ port: 40200 });
  assert.equal(runner.status().state, "unconfigured");
  await runner.reconcile({ port: 40100 });
  await runner.advance(TUNNEL_PROBE_DELAYS_REUSED_MS[0]);
  assert.equal(runner.status().state, "up");
  const spawned = runner.spawned.length;
  await runner.reconcile({ port: 40100 });
  assert.equal(
    runner.spawned.length,
    spawned,
    "a same-port reconcile restarted it",
  );
  assert.equal(runner.status().state, "up");
});

it("cloudflared runner: a denial after an unconfigured answer parks as a denial, not a wait", async () => {
  let asks = 0;
  const runner = await tunnelHarness({
    provision: async () => {
      asks += 1;
      if (asks === 1) throw new HubTunnelUnconfiguredError();
      throw new TunnelProvisionDeniedError("HTTP 401");
    },
  });
  await runner.reconcile({ port: 40100 });
  assert.equal(runner.status().state, "unconfigured");
  await runner.recheck();
  assert.equal(asks, 2);
  assert.equal(runner.status().state, "error");
  await runner.recheck();
  await runner.advance(UNCONFIGURED_RETRY_MS * 2);
  assert.equal(asks, 2, "a denial was asked again on a timer or a wake");
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
        dnsCreated: false,
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
  // In the host's process group: what stops the app's group stops it.
  assert.equal(entryAt(spawned, 0).detached, false);
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

it("cloudflared runner: one killed by a signal from outside (another tool's pkill) is started again on the ladder", async () => {
  const runner = await tunnelHarness({
    provision: async () => ({
      hostname: "sm-feedfacecafe.sm.example.test",
      connectorToken: "token",
      dnsCreated: false,
    }),
  });
  const { spawned } = runner;
  await runner.reconcile({ port: 40100 });
  await runner.advance(TUNNEL_PROBE_DELAYS_REUSED_MS[0]);
  assert.equal(runner.status().state, "up");
  entryAt(spawned, 0).exit("SIGTERM");
  await runner.advance(0);
  assert.equal(runner.status().state, "error");
  await runner.advance(TUNNEL_BACKOFF_LADDER_MS[0]);
  assert.equal(spawned.length, 2, "not started again after a signal");
  await runner.advance(TUNNEL_PROBE_DELAYS_REUSED_MS[0]);
  assert.equal(runner.status().state, "up");
  await runner.dispose();
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
        dnsCreated: false,
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
    await notYetRoutable.advance(step);
  }
  for (let i = 0; i < 3; i += 1) {
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
  // A wait on a starting tunnel gives up at its bound, and one under
  // way when the tunnel comes up says so.
  const givesUp = notYetRoutable.startingThenUp(1_000);
  await notYetRoutable.advance(1_000);
  assert.equal(await givesUp, false);
  const comesUp = notYetRoutable.startingThenUp(10 * TUNNEL_PROBE_SLOW_MS);
  // DNS catches up: the next (slow-rung) probe advertises the same
  // child.
  lateRoutable = true;
  await notYetRoutable.advance(TUNNEL_PROBE_SLOW_MS);
  assert.equal(await comesUp, true);
  assert.equal(notYetRoutable.status().state, "up");
  // With none starting, at once.
  assert.equal(await notYetRoutable.startingThenUp(0), true);
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
      return {
        hostname: "h.example.test",
        connectorToken: "t",
        dnsCreated: false,
      };
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
        throw new TunnelProvisionDeniedError("device revoked");
      }
      return {
        hostname: "h.example.test",
        connectorToken: "t",
        dnsCreated: false,
      };
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
  releaseProvision({
    hostname: "h.example.test",
    connectorToken: "t",
    dnsCreated: false,
  });
  await settleTunnel();
  assert.equal(
    hung.spawned.length,
    0,
    "a provision that outran the quit spawned",
  );
});

// A ticket the hub refused (any 401 or 403, as a misdeployed hub gives
// every device at once) blocks, then is asked again on a slow schedule
// rather than waiting for the next sign-in.
it("a refused ticket blocks, and is asked again two minutes on", async () => {
  const clock = testClock();
  let connects = 0;
  const statuses: SupervisorStatus[] = [];
  madeOn(
    clock.context,
    supervise({
      classifyClose: () => null,
      connect: () => {
        connects += 1;
        return Effect.andThen(
          Effect.yieldNow,
          Effect.fail(
            new RemoteConnectError("the hub refused the ticket", null, true),
          ),
        );
      },
      onStatus: (status) => statuses.push(status),
    }),
  );
  await clock.settle();
  assert.equal(connects, 1);
  const blocked = statuses.at(-1);
  assert.equal(blocked?.phase, "blocked");
  assert.equal(blocked?.phase === "blocked" ? blocked.reason : "", "refused");
  await clock.advance(119_000);
  assert.equal(connects, 1, "not before its time");
  // Then the ladder's first rung, as after any failed attempt.
  await clock.advance(1_000 + BACKOFF_LADDER_MS[0]);
  assert.equal(connects, 2, "asked again");
});
