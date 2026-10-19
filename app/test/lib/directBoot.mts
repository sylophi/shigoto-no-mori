// The direct sandbox: two devices on a REAL direct link, beside the
// stub device hub (hubStub.mts). The listener is a REAL direct ws
// listener (host/socket/DeviceLink.ts) with its ticket store and switches,
// answering connectInfo through the hub as the host does. The dialer
// drives the REAL shared composition (shared/hub/directPlane.ts) or
// dials the listener straight. What each proof adds is its own
// handlers and what it asserts (README.md, "Shared fakes").
import { ROSTER_UNAVAILABLE, STALE_TICKET } from "@shared/remote/sealedSocket";
import assert from "node:assert/strict";
import { makeConnectInfo } from "@host/direct/connectInfo";
import * as DeviceLink from "@host/socket/DeviceLink";
import type { WsServerStartOpts } from "@host/socket/DeviceLink";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import * as HostPushes from "@host/lib/HostPushes";
import { pushesLayer } from "./hostStandIns.mts";
import * as Views from "@host/lib/Views";
import * as Sharing from "@host/lib/Sharing";
import {
  createConnectTicketStore,
  type ConnectTicketStore,
  type ConnectTicketStoreOpts,
} from "@host/direct/tickets";
import type { HubHandlers } from "@shared/hub/bridgeHandlers";
import {
  type DirectPlane,
  type DirectPlaneDeps,
  make as makeDirectPlane,
} from "@shared/hub/directPlane";
import {
  callsOf,
  channelOf,
  type ContractModule,
  keyOf,
} from "@shigomori/contracts/contract";
import type { DirectCandidateKind } from "@shigomori/contracts/modules/direct";
import { accountContract } from "@shigomori/contracts/modules/account";
import { sharingContract } from "@shigomori/contracts/modules/sharing";
import type { HubPeerPush } from "@shigomori/contracts/modules/hub";
import type { EffectHandlers } from "@shigomori/contracts/types";
import { createServed, resolvePush, type View } from "@shared/ipc/served";
import { allContractModules } from "@shigomori/contracts/allModules";
import type { HostServices } from "@host/process/services";
import { hostContext } from "./hostRuntime.mts";
import type {
  ClientTransport,
  HandlerContext,
  Link,
} from "@shared/ipc/transport";
import { WebSocket as WsClient } from "ws";
import type { KeyPair } from "@shared/crypto/noise";
import {
  type DeviceConnection,
  type DeviceLinkOptions,
  dialDevice,
  RemoteConnectError,
} from "@shared/remote/deviceLink";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { startStubHub, type StubHub, testDeviceKey } from "./hubStub.mts";
import { bootDevice, type BootedDevice } from "./hubBoot.mts";
import { type Track, waitFor } from "./checkKit.mts";

// The two devices, named by their part in the link: the one that dials
// and the one that listens. Each seals with its test key (hubStub.mts).
export const DIALER = "dialer";
export const LISTENER = "listener";

// A channel's module and key, for a proof that names a call by its
// channel.
function callByChannel(channel: string): {
  module: ContractModule;
  key: string;
} {
  for (const module of allContractModules) {
    for (const call of callsOf(module)) {
      if (channelOf(call) === channel) return { module, key: keyOf(call) };
    }
  }
  throw new Error(`no contract call is ${channel}`);
}

// How long a dial may take before it fails, unless a check shortens it
// to see a failure settle.
const DIAL_DEADLINE_MS = 3000;

// The listener as a proof drives it: what it serves (a whole module, as
// the host registers one), a call of its own by channel, a Promise
// handler handed a signal that aborts when the call is interrupted, a
// view by channel, and the listener's own state.
type WsServerBinding = {
  served: DeviceLink.LinkRegistrar;
  handle(
    channel: string,
    fn: (
      ctx: HandlerContext & { readonly signal: AbortSignal },
      raw: unknown,
    ) => Promise<unknown>,
  ): void;
  view(channel: string, view: View<HostServices>): void;
  // A push from the host, as the host's broadcastAll publishes it.
  broadcastAll(
    channel: string,
    payload: unknown,
    opts?: { remote?: boolean },
  ): void;
  status(): { listening: boolean; port: number | null };
  closePeersNotIn(online: readonly string[]): Promise<void>;
  // Brings the listener to `opts` (null stops it), as the host's refresh
  // does.
  reconcile(opts: WsServerStartOpts | null): Promise<void>;
};

export type DirectListenerOpts = {
  ticketOpts?: ConnectTicketStoreOpts;
  // LISTENER unless a check stands up another device's listener.
  deviceId?: string;
  // The key the roster names for a dialing device, where it is not
  // its test key (a web profile's, from its stored envelope).
  peerKey?: (deviceId: string) => Uint8Array;
  registerHandlers?: (binding: WsServerBinding) => void;
  start?: Partial<WsServerStartOpts>;
  // The switch's one exception (WsServerTicketAuth.isInvited): the
  // calls the host asked for itself. Absent, the switch is the whole
  // verdict, as it is for every check but the gate's own.
  isInvited?: (
    peerDeviceId: string,
    channel: string,
    input: unknown,
  ) => boolean;
  // The pushes a peer still hears while sharing is off, beside
  // sharing:changed (the host's mirrorInviteSees). Absent, none.
  seesPush?: (peerDeviceId: string, payload: unknown) => boolean;
  // What the listener's graph runs on beyond its own (a tracer, a
  // file-sync engine), over the proof file's host services.
  provide?: Layer.Layer<never>;
};

export type DirectListener = {
  deviceId: string;
  binding: WsServerBinding;
  tickets: ConnectTicketStore;
  rosterUnavailable(unavailable: boolean): void;
  // `sweep: false` leaves the links and the tickets be, for a check of
  // what the hello does on its own.
  rosterNow(
    online: readonly string[],
    only?: { sweep?: boolean },
  ): Promise<void>;
  acceptsCommands(): boolean;
  setAccepts(next: boolean): void;
  sharesData(): boolean;
  setSharing(next: boolean): void;
  port: number;
  listenerPort(): number | null;
};

// A REAL direct listener on an ephemeral loopback port, with its
// ticket store and toggleable switches: command access (the host-wide
// "accepts commands from its account's devices" answer the real
// binding reads from the account's facts) and sharing (on, as a device starts).
// Flipping either pushes it to every connected peer, as the host does, so
// a peer's bridge follows it live. `registerHandlers`, when
// set, mounts the check's contracts or test channels on the binding
// before it starts, and `start` overrides the start opts (the hello
// and liveness seams, the admitted web origin).
export async function startDirectListener(
  track: Track,
  opts: DirectListenerOpts = {},
): Promise<DirectListener> {
  const listenerId = opts.deviceId ?? LISTENER;
  const tickets = createConnectTicketStore(opts.ticketOpts);
  // The roster's keys: the test keys (hubStub.mts) unless the check
  // names others, and none for a device a roster (rosterNow) left out.
  let roster: ReadonlySet<string> | null = null;
  let rosterUnavailable = false;
  const rosterKey = (deviceId: string): Uint8Array | undefined =>
    roster !== null && !roster.has(deviceId)
      ? undefined
      : (opts.peerKey?.(deviceId) ?? testDeviceKey(deviceId).pair.publicKey);
  let accepts = false;
  const sharing = Effect.runSync(SubscriptionRef.make(true));
  const registrar: DeviceLink.LinkRegistrar = createServed({
    // The host's usage bump is its own concern.
    onUsageTracked: () => {},
  });
  const host = await hostContext();
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      // Its calls run on the services beneath it, there from the start.
      Layer.unwrap(
        Effect.map(Effect.context<HostServices>(), (services) =>
          DeviceLink.layer({
            services: Effect.succeed(services),
            registrar,
            auth: {
              // The roster's keys are the test keys (hubStub.mts), and
              // the listener seals with its own.
              opens: {
                check: (ticket, arrivedAs) => {
                  const deviceId = tickets.check(ticket, arrivedAs);
                  if (deviceId === null || deviceId === STALE_TICKET) {
                    return deviceId;
                  }
                  if (rosterUnavailable) return ROSTER_UNAVAILABLE;
                  const publicKey = rosterKey(deviceId);
                  return publicKey === undefined
                    ? STALE_TICKET
                    : { deviceId, publicKey };
                },
                spend: (ticket, arrivedAs) =>
                  tickets.consume(ticket, arrivedAs),
                keepDevices: (deviceIds) => tickets.keepDevices(deviceIds),
                keyOf: (deviceId) =>
                  rosterUnavailable ? ROSTER_UNAVAILABLE : rosterKey(deviceId),
                localKey: () => testDeviceKey(listenerId).pair,
              },
              isCommandGranted: () => accepts,
              ...(opts.isInvited === undefined
                ? {}
                : { isInvited: opts.isInvited }),
            },
            seesPush: opts.seesPush ?? (() => false),
          }),
        ),
      ),
      Layer.mergeAll(
        // The host's services, beneath the stand-ins below.
        Layer.succeedContext(host),
        pushesLayer,
        Views.layer,
        Layer.succeed(
          Sharing.Sharing,
          Sharing.Sharing.of({
            current: SubscriptionRef.get(sharing),
            now: () => SubscriptionRef.getUnsafe(sharing),
            changes: SubscriptionRef.changes(sharing),
            set: (on) => SubscriptionRef.set(sharing, on),
          }),
        ),
        // The store says nothing here: the views a proof reads are
        // host-views.mts's.
        Layer.succeed(StoreChanges.StoreChanges, {
          subscribe: Effect.succeed(Stream.never),
          release: Effect.void,
        }),
        opts.provide ?? Layer.empty,
      ),
    ),
  );
  track(() => runtime.dispose());
  const onLink = <A,>(
    f: (link: DeviceLink.DeviceLink["Service"]) => Effect.Effect<A>,
  ) => runtime.runPromise(Effect.flatMap(DeviceLink.DeviceLink, f));
  let current = await onLink((link) => link.status);
  const binding: WsServerBinding = {
    served: registrar,
    // A proof's own channel: each call's signal aborts when the call is
    // interrupted.
    handle: (channel, fn) => {
      const { module, key } = callByChannel(channel);
      registrar.serveOne(
        module,
        key as never,
        ((raw: unknown, ctx: HandlerContext) =>
          Effect.tryPromise({
            try: async (signal) => fn({ ...ctx, signal }, raw),
            catch: callFailureOf,
          })) as never,
      );
    },
    view: (channel, view) => {
      const { module, key } = callByChannel(channel);
      registrar.view(module, { [key]: view } as never);
    },
    broadcastAll: (channel, payload, broadcastOpts) =>
      runtime.runSync(
        Effect.flatMap(HostPushes.HostPushes, (pushes) =>
          pushes.publish({
            channel,
            payload,
            remote: broadcastOpts?.remote === true,
          }),
        ),
      ),
    status: () => current,
    closePeersNotIn: (online) => onLink((link) => link.closePeersNotIn(online)),
    reconcile: async (next) => {
      await onLink((link) => link.reconcile(Effect.succeed(next)));
      current = await onLink((link) => link.status);
    },
  };
  opts.registerHandlers?.(binding);
  await binding.reconcile({
    port: 0,
    bindAddress: "127.0.0.1",
    deviceId: listenerId,
    appVersion: "2.0.0",
    helloTimeoutMs: 1000,
    ...opts.start,
  });
  const port = binding.status().port;
  assert.ok(port !== null, "the listener did not bind");
  return {
    deviceId: listenerId,
    binding,
    tickets,
    // What the host does as the hub's roster changes (host/process/
    // wires.ts): the keys follow it, and the listener's sweep drops the
    // dropped devices' tickets and closes their links.
    // The hub out of reach, as the host reads it: no roster to check a
    // key against.
    rosterUnavailable: (unavailable) => {
      rosterUnavailable = unavailable;
    },
    rosterNow: async (online, only = {}) => {
      roster = new Set(online);
      if (only.sweep !== false) await binding.closePeersNotIn(online);
    },
    acceptsCommands: () => accepts,
    setAccepts: (next) => {
      accepts = next;
      const push = resolvePush(accountContract, "commandAccessChanged", next);
      binding.broadcastAll(push.channel, push.payload, push);
    },
    sharesData: () => Effect.runSync(SubscriptionRef.get(sharing)),
    setSharing: (next) => {
      Effect.runSync(SubscriptionRef.set(sharing, next));
      const push = resolvePush(sharingContract, "changed", next);
      binding.broadcastAll(push.channel, push.payload, push);
    },
    port,
    listenerPort: () => {
      const status = binding.status();
      return status.listening ? status.port : null;
    },
  };
}

// The connection a check's tickets are minted for, unless it names
// another.
export const ONE_CONNECTION = "c".repeat(32);

// Mints `count` connect tickets of one candidate kind for `peer`'s
// `connectionId`, failing the check when the store refuses. A loopback
// dial with no CF-Connecting-IP arrives as a "lan" candidate, hence the
// default.
export function mintTickets(
  store: Pick<ConnectTicketStore, "mint">,
  peer: string,
  count: number,
  kind: DirectCandidateKind = "lan",
  connectionId = ONE_CONNECTION,
): string[] {
  const tickets = store.mint(
    { deviceId: peer, connectionId },
    Array.from({ length: count }, () => kind),
  );
  assert.ok(tickets !== null, `the store refused to mint for ${peer}`);
  return tickets;
}

// The one-ticket case of mintTickets, for a check that dials once.
export function mintTicket(
  store: Pick<ConnectTicketStore, "mint">,
  peer: string,
  kind: DirectCandidateKind = "lan",
): string {
  const [ticket] = mintTickets(store, peer, 1, kind);
  assert.ok(ticket !== undefined, `the store minted no ticket for ${peer}`);
  return ticket;
}

export type BrokerListener = Pick<DirectListener, "tickets" | "listenerPort"> &
  Partial<Pick<DirectListener, "acceptsCommands" | "sharesData">>;

export type BridgeOpts = {
  // The listener's hub device, LISTENER unless a check names another.
  listenerId?: string;
  onMinted?: (tickets: string[]) => void;
  candidateAddresses?: () => string[];
  tunnelUrl?: () => string | null;
  onStatusChange?: DirectPlaneDeps["broadcastStatus"];
  onPeerPush?: DirectPlaneDeps["broadcastPeerPush"];
  dialableKinds?: DirectPlaneDeps["dialableKinds"];
  deadlineMs?: number;
  // What the plane is made in: a check's TestClock, so its keeper's
  // retries are advanced by hand instead of slept out.
  context?: Context.Context<never>;
  // The plane's presence path wired to the dialer's hub connection as
  // production wires it (late-bound, plus one catch-up call for the
  // roster that connected before the plane existed), so the keeper
  // dials the listener on its own. Off, a check dials by hand.
  supervised?: boolean;
};

export type Bridged = {
  stub: StubHub;
  dialer: BootedDevice;
  plane: DirectPlane;
  bridge: HubHandlers;
  // Closes the plane's scope: its keeper latched, its sessions closed.
  stop(): Promise<void>;
};

// The dialer bridged to `listener` through a stub device hub of its
// own: the listener's hub device answers connectInfo with the REAL
// server (the ONLY thing the hub wire answers, wired as the host wires
// it), and the dialer's REAL direct plane asks it. The plane stops with
// the test, closing its sessions.
export async function bridgeTo(
  track: Track,
  listener: BrokerListener,
  opts: BridgeOpts = {},
): Promise<Bridged> {
  const stub = await startStubHub(track);
  let onPlaneChange: (() => void) | null = null;
  // The two devices are independent, so they boot concurrently.
  const [, dialer] = await Promise.all([
    bootDevice(
      stub,
      opts.listenerId ?? LISTENER,
      {
        serveConnectInfo: makeConnectInfo({
          listenerPort: listener.listenerPort,
          mintTickets: (peerDeviceId, kinds) => {
            const tickets = listener.tickets.mint(peerDeviceId, kinds);
            // Observation seam for the mint-alignment assertions.
            if (tickets !== null) opts.onMinted?.(tickets);
            return tickets;
          },
          // Deterministic candidates: the listener binds loopback,
          // so real interface enumeration would offer unreachable
          // LAN addresses.
          candidateAddresses: opts.candidateAddresses ?? (() => ["127.0.0.1"]),
          tunnelUrl: opts.tunnelUrl ?? (() => null),
          // A bare broker stand-in (no real listener behind it)
          // reports the switch off.
          acceptsCommands: () => listener.acceptsCommands?.() ?? false,
          sharesData: () => listener.sharesData?.() ?? true,
        }),
      },
      track,
    ),
    bootDevice(stub, DIALER, { onChange: () => onPlaneChange?.() }, track),
  ]);
  const { plane, bridge, stop } = makeDirectBridge(dialer, opts);
  track(stop);
  if (opts.supervised === true) {
    onPlaneChange = () => plane.handleConnectionChange();
    plane.handleConnectionChange();
  }
  return { stub, dialer, plane, bridge, stop };
}

export type ServedContracts<C extends readonly ContractModule[]> = {
  [I in keyof C]: readonly [
    C[I],
    EffectHandlers<C[I], HandlerContext, HostServices>,
  ];
};

export type DirectWire = Bridged & {
  listener: DirectListener;
  toListener: PeerTransport;
};

// The whole direct wire the transfer checks share, exactly as
// production composes it: a REAL direct listener serving the check's
// contracts, the dialer's REAL direct plane supervised over the stub
// device hub (bridgeTo), and a counting peer transport aimed at the
// listener. The keeper establishes the session eagerly, before any
// invoke, which is the supervised model the transfer checks ride.
// Everything registers its teardown on the caller's tracker.
// `opts.contracts` lists the [contract, handlers] pairs the listener
// serves, each registered with output validation and a no-op usage
// hook: the hook is the host's concern, and the registrar only calls it
// for defs marked tracksProjectUsage (and requires it for a module that
// has one), so passing it everywhere satisfies the registrar and
// changes nothing else.
export async function bootDirectWire<const C extends readonly ContractModule[]>(
  track: Track,
  opts: {
    contracts?: ServedContracts<C>;
    provide?: DirectListenerOpts["provide"];
    isInvited?: DirectListenerOpts["isInvited"];
  } = {},
): Promise<DirectWire> {
  const listener = await startDirectListener(track, {
    ...(opts.provide === undefined ? {} : { provide: opts.provide }),
    ...(opts.isInvited === undefined ? {} : { isInvited: opts.isInvited }),
    registerHandlers: (binding) => {
      for (const [contract, handlers] of opts.contracts ?? []) {
        binding.served.serve(contract, handlers);
      }
    },
  });
  // The listener's pushes on the session, as the host's peer-push
  // fan-out hands them on (host/process/wires.ts onPeerPush), for the
  // peer transport's subscribe.
  const pushListeners = new Set<(push: HubPeerPush) => void>();
  const bridged = await bridgeTo(track, listener, {
    supervised: true,
    onPeerPush: (push) => {
      for (const hear of pushListeners) hear(push);
    },
  });
  await waitFor(
    () => bridged.bridge.directPeers().peerAppVersions[LISTENER] !== undefined,
    "the keeper to establish the direct session to the listener",
  );
  const toListener = bridgePeerTransport(
    bridged.bridge,
    LISTENER,
    pushListeners,
  );
  return { ...bridged, listener, toListener };
}

export type DirectBridgeOpts = Pick<
  BridgeOpts,
  "onStatusChange" | "onPeerPush" | "dialableKinds" | "deadlineMs" | "context"
>;

// The dialer's composition under test: the REAL direct plane (dialer
// over the connection's connectInfo ask, bridge cache over the dialer)
// exactly as the host and the web bridge assemble it, over any hub
// connection, for a check whose peer is no listener (a wedged or raw
// one). The fan-out sinks are observation seams the scenarios read. The
// plane lives until `stop`.
export function makeDirectBridge(
  dialer: Pick<BootedDevice, "connection">,
  opts: DirectBridgeOpts = {},
): { plane: DirectPlane; bridge: HubHandlers; stop: () => Promise<void> } {
  const scope = Scope.makeUnsafe();
  const make = makeDirectPlane({
    connection: () => dialer.connection,
    localDeviceId: () => DIALER,
    localAppVersion: () => "1.0.0",
    broadcastStatus: (status) => opts.onStatusChange?.(status),
    broadcastPeerPush: (push) => opts.onPeerPush?.(push),
    dialableKinds: opts.dialableKinds,
    // The production socket (the host injects ws), so the proof exercises
    // the errno detail the seam exists for rather than the bare 1006
    // of Node's global.
    openSocket: (url) => new WsClient(url),
    deadlineMs: opts.deadlineMs ?? DIAL_DEADLINE_MS,
  }).pipe(Scope.provide(scope));
  const plane = Effect.runSyncWith(opts.context ?? Context.empty())(make);
  return {
    plane,
    bridge: plane.handlers,
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

export type PeerTransport = {
  transport: ClientTransport;
  invokeCount(channel: string): number;
  channels(): ReturnType<HubHandlers["peerChannels"]>;
};

// A transport's invokes as a link's calls, for an effect client over it
// (shared/ipc/effectClient.ts): a call it cancels interrupts, and its
// failure is what a link's would be.
export const linkOver = (transport: ClientTransport): Pick<Link, "call"> => ({
  call: (channel, input) =>
    Effect.tryPromise({
      try: (signal) => transport.invoke(channel, input, { signal }),
      catch: callFailureOf,
    }),
});

// A ClientTransport riding the bridge's cached direct session, with a
// per-channel invoke counter so a transfer check can pin poll-side
// chunking as round trips (the hub stub sees none of them, which the
// checks assert separately via forwardedCount). Its subscribe hears
// the peer's pushes off the bridge's fan-out, the way the host's peer
// transport does.
function bridgePeerTransport(
  bridge: HubHandlers,
  deviceId: string,
  pushListeners: Set<(push: HubPeerPush) => void>,
): PeerTransport {
  const counts = new Map<string, number>();
  return {
    transport: {
      invoke: (channel, input, options) => {
        counts.set(channel, (counts.get(channel) ?? 0) + 1);
        return bridge.invokeOnPeer(deviceId, channel, input, options);
      },
      subscribe: (channel, handler) => {
        const listener = (push: HubPeerPush) => {
          if (push.deviceId === deviceId && push.channel === channel) {
            handler(push.payload);
          }
        };
        pushListeners.add(listener);
        return () => pushListeners.delete(listener);
      },
    },
    invokeCount: (channel) => counts.get(channel) ?? 0,
    // The session's byte channels (shared/remote/channels.ts),
    // resolving like invokePeer does.
    channels: () => bridge.peerChannels(deviceId),
  };
}

export type DialOpts = {
  // Who dials: DIALER unless a check plays another device.
  dialer?: string;
  // The identity the dial pins: the listener's own unless a check means
  // to reach the wrong one.
  expects?: string;
  // Minted for the dialer unless a check presents its own.
  ticket?: string;
  // The key the dialer seals with: its test key unless a check names
  // another.
  localKey?: KeyPair;
  // ws://127.0.0.1:<the listener's port> unless the dial goes another
  // way (a proxy, a shaped link).
  url?: string;
  deadlineMs?: number;
  // The socket the dial opens: plain ws unless a check hooks it (a
  // header, a frame counter).
  openSocket?: DeviceLinkOptions["openSocket"];
  onClose?: () => void;
  protocolVersion?: number;
  deviceKind?: "desktop" | "web";
  // The clock the link's timings read: the live one unless a check
  // steps it.
  clock?: Clock.Clock;
};

// A dial in its two steps, as the direct race takes it (dialDevice's
// gate), for checks that hold a link between its socket's open and its
// hello: `whenOpen`, then `authenticate()` for the link, or `abandon()`.
// The link is up until its `close`, and `onClose` hears it end on its
// own.
export type PendingDial = {
  whenOpen: Promise<void>;
  authenticate(): Promise<DeviceConnection>;
  abandon(): void;
};

function pendingDial(
  options: DeviceLinkOptions,
  onClose: () => void,
  clock: Clock.Clock | undefined,
): PendingDial {
  const opened = Deferred.makeUnsafe<void, RemoteConnectError>();
  const helloAsked = Deferred.makeUnsafe<void>();
  const welcomed = Deferred.makeUnsafe<DeviceConnection, RemoteConnectError>();
  let established = false;
  let ownerClosed = false;
  const close = () => {
    ownerClosed = true;
    Effect.runFork(Fiber.interrupt(fiber));
  };
  const fiber = Effect.runFork(
    Effect.gen(function* () {
      const {
        dropped,
        link: _,
        ...dialed
      } = yield* dialDevice(options, {
        opened,
        helloAsked,
      });
      established = true;
      yield* Deferred.succeed(welcomed, { ...dialed, close });
      yield* dropped;
    }).pipe(
      Effect.scoped,
      clock === undefined
        ? (dial) => dial
        : Effect.provideService(Clock.Clock, clock),
      Effect.catch((failed) =>
        Effect.andThen(
          Deferred.fail(opened, failed),
          Deferred.fail(welcomed, failed),
        ),
      ),
    ),
  );
  fiber.addObserver(() => {
    if (established && !ownerClosed) onClose();
    const closed = new RemoteConnectError("connection closed", null, false);
    Effect.runSync(
      Deferred.fail(opened, closed).pipe(
        Effect.andThen(Deferred.fail(welcomed, closed)),
      ),
    );
  });
  const whenOpen = Effect.runPromise(Deferred.await(opened));
  whenOpen.catch(() => {});
  const connected = Effect.runPromise(Deferred.await(welcomed));
  connected.catch(() => {});
  return {
    whenOpen,
    authenticate() {
      Effect.runSync(Deferred.succeed(helloAsked, undefined));
      return connected;
    },
    abandon: close,
  };
}

// A dial straight at a listener, sealed with the test keys, before its
// handshake: `.authenticate()` links it or fails.
export function dialing(
  listener: Pick<DirectListener, "port" | "tickets" | "deviceId">,
  opts: DialOpts = {},
) {
  const dialer = opts.dialer ?? DIALER;
  const expects = opts.expects ?? listener.deviceId;
  return pendingDial(
    {
      url: opts.url ?? `ws://127.0.0.1:${listener.port}`,
      ticket: opts.ticket ?? mintTicket(listener.tickets, dialer),
      seal: {
        localKey: opts.localKey ?? testDeviceKey(dialer).pair,
        remoteKey: testDeviceKey(expects).pair.publicKey,
      },
      appVersion: "1.0.0",
      localDeviceId: dialer,
      expectedDeviceId: expects,
      openSocket: opts.openSocket ?? ((url) => new WsClient(url)),
      deadlineMs: opts.deadlineMs ?? DIAL_DEADLINE_MS,
      ...(opts.deviceKind === undefined ? {} : { deviceKind: opts.deviceKind }),
      ...(opts.protocolVersion === undefined
        ? {}
        : { protocolVersion: opts.protocolVersion }),
    },
    opts.onClose ?? (() => {}),
    opts.clock,
  );
}

// One link to a listener, closed with the test.
export async function dialListener(
  track: Track,
  listener: Pick<DirectListener, "port" | "tickets" | "deviceId">,
  opts: DialOpts = {},
): Promise<DeviceConnection> {
  const connection = await dialing(listener, opts).authenticate();
  track(() => connection.close());
  return connection;
}
