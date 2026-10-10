// Shared fixtures for the checks that run a REAL direct data plane
// beside the stub device hub (test/lib/hubStub.mts): a direct ws
// listener (host/socket/server.ts), the connectInfo server on a hub
// host device, and the REAL shared composition
// (shared/hub/directPlane.ts) a client drives. Extracted from
// direct-plane.mts so sync-transfer.mts and
// port-forward.mts move their transfer scenarios onto a real
// direct connection without a second copy of the plumbing.
import assert from "node:assert/strict";
import { makeConnectInfo } from "@host/direct/connectInfo";
import * as DeviceLink from "@host/socket/server";
import { invokeInCallSpan, withParentSpan } from "@host/lib/util/trace";
import type { WsServerStartOpts } from "@host/socket/server";
import * as Effect from "effect/Effect";
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import * as HostPushes from "@host/lib/hostPushes";
import * as Sharing from "@host/lib/sharing";
import {
  createConnectTicketStore,
  type ConnectTicketStore,
  type ConnectTicketStoreOpts,
} from "@host/direct/tickets";
import type { HubHandlers } from "@shared/hub/bridgeHandlers";
import {
  createDirectPlane,
  type DirectPlane,
  type DirectPlaneDeps,
} from "@shared/hub/directPlane";
import type { ContractModule } from "@shigomori/contracts/contract";
import type { DirectCandidateKind } from "@shigomori/contracts/modules/direct";
import { accountContract } from "@shigomori/contracts/modules/account";
import { sharingContract } from "@shigomori/contracts/modules/sharing";
import type { HubPeerPush } from "@shigomori/contracts/modules/hub";
import {
  broadcastAll,
  registerHostContract,
} from "@shared/ipc/registerContract";
import type { HostServices } from "@host/process/services";
import { hostContext } from "./adapters.mts";
import type {
  ClientTransport,
  HandlerContext,
  ServerTransport,
} from "@shared/ipc/transport";
import type { Handlers } from "@shigomori/contracts/types";
import { WebSocket as WsClient } from "ws";
import { type DeviceConnection, openDevice } from "@shared/remote/deviceLink";
import { startStubHub, type StubHub } from "./hubStub.mts";
import { bootDevice, type BootedDevice } from "./hubBoot.mts";
import { type Track, waitFor } from "./checkKit.mts";

// The listener as a proof drives it: the registrar it serves, its calls
// Promise handlers (a ServerTransport, for registerContract and
// broadcastAll), and the listener's own state.
type WsServerBinding = Omit<DeviceLink.LinkRegistrar, "handle"> &
  Pick<ServerTransport, "handle"> & {
    // A call as the host serves it, an effect (registerHostContract).
    serve: DeviceLink.LinkRegistrar["handle"];
    // A push from the host, as main's broadcastAll publishes it.
    broadcastAll(
      channel: string,
      payload: unknown,
      opts?: { remote?: boolean },
    ): void;
    status(): { listening: boolean; port: number | null };
    closePeersNotIn(online: readonly string[]): Promise<void>;
    // Brings the listener to `opts` (null stops it), as main's refresh
    // does.
    reconcile(opts: WsServerStartOpts | null): Promise<void>;
  };

export type DirectListenerOpts = {
  ticketOpts?: ConnectTicketStoreOpts;
  deviceId?: string;
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
  // sharing:changed (main's mirrorInviteSees). Absent, none.
  seesPush?: (peerDeviceId: string, payload: unknown) => boolean;
  // What the listener's graph runs on beyond its own (a tracer).
  provide?: Layer.Layer<never>;
};

export type DirectListener = {
  binding: WsServerBinding;
  tickets: ConnectTicketStore;
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
// binding reads from main) and sharing (on, as a device starts).
// Flipping either pushes it to every connected peer, as main does, so
// a peer's bridge follows it live. `registerHandlers`, when
// set, mounts the check's contracts or test channels on the binding
// before it starts, and `start` overrides the start opts (the hello
// and liveness seams, the admitted web origin).
export async function startDirectListener(
  track: Track,
  opts: DirectListenerOpts = {},
): Promise<DirectListener> {
  const tickets = createConnectTicketStore(opts.ticketOpts);
  let accepts = false;
  const sharing = Effect.runSync(SubscriptionRef.make(true));
  const registrar = DeviceLink.createLinkRegistrar();
  const host = await hostContext();
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      DeviceLink.layer({
        registrar,
        auth: {
          matchTicket: (deviceId, arrivedAs, matches) =>
            tickets.consumeProven(deviceId, arrivedAs, matches),
          isCommandGranted: () => accepts,
          ...(opts.isInvited === undefined
            ? {}
            : { isInvited: opts.isInvited }),
        },
        seesPush: opts.seesPush ?? (() => false),
      }),
      Layer.mergeAll(
        // The host's services, beneath the stand-ins below.
        Layer.succeedContext(host),
        HostPushes.layer,
        Layer.succeed(
          Sharing.Sharing,
          Sharing.Sharing.of({
            current: SubscriptionRef.get(sharing),
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
    ...registrar,
    serve: registrar.handle,
    // Each call's signal aborts when the call is interrupted, and its
    // span is the parent of the handler's, as the host's are.
    handle: (channel, fn, handleOpts) =>
      registrar.handle(
        channel,
        (ctx, raw) =>
          Effect.flatMap(Effect.option(Effect.currentSpan), (span) =>
            Effect.tryPromise({
              try: (signal) =>
                withParentSpan(span, () => fn({ ...ctx, signal }, raw)),
              catch: callFailureOf,
            }),
          ),
        handleOpts,
      ),
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
    deviceId: opts.deviceId ?? "B",
    appVersion: "2.0.0",
    helloTimeoutMs: 1000,
    ...opts.start,
  });
  const port = binding.status().port;
  assert.ok(port !== null, "the listener did not bind");
  return {
    binding,
    tickets,
    acceptsCommands: () => accepts,
    setAccepts: (next) => {
      accepts = next;
      broadcastAll(accountContract, "commandAccessChanged", next, binding);
    },
    sharesData: () => Effect.runSync(SubscriptionRef.get(sharing)),
    setSharing: (next) => {
      Effect.runSync(SubscriptionRef.set(sharing, next));
      broadcastAll(sharingContract, "changed", next, binding);
    },
    port,
    listenerPort: () => {
      const status = binding.status();
      return status.listening ? status.port : null;
    },
  };
}

// Mints `count` connect tickets of one candidate kind for `peer`,
// failing the check when the store refuses. A loopback dial with no
// CF-Connecting-IP arrives as a "lan" candidate, hence the default.
export function mintTickets(
  store: Pick<ConnectTicketStore, "mint">,
  peer: string,
  count: number,
  kind: DirectCandidateKind = "lan",
): string[] {
  const tickets = store.mint(
    peer,
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

export type BrokeredPairOpts = {
  hostDeviceId?: string;
  clientDeviceId?: string;
  onMinted?: (tickets: string[]) => void;
  candidateAddresses?: () => string[];
  tunnelUrl?: () => string | null;
  clientOnChange?: () => void;
};

export type BrokeredPair = { host: BootedDevice; client: BootedDevice };

// Boots the hub pair: B answers connectInfo with the REAL server (the
// ONLY thing the hub wire answers, wired as main wires it), A is the
// dialing client. The two devices are independent, so they boot
// concurrently.
export async function bootBrokeredPair(
  stub: Pick<StubHub, "hubUrl">,
  track: Track,
  listener: BrokerListener,
  opts: BrokeredPairOpts = {},
): Promise<BrokeredPair> {
  const [host, client] = await Promise.all([
    bootDevice(
      stub,
      opts.hostDeviceId ?? "B",
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
    bootDevice(
      stub,
      opts.clientDeviceId ?? "A",
      { onChange: opts.clientOnChange },
      track,
    ),
  ]);
  return { host, client };
}

export type ServedContracts<C extends readonly ContractModule[]> = {
  [I in keyof C]: readonly [C[I], Handlers<C[I], HandlerContext, HostServices>];
};

export type DirectWire = {
  stub: StubHub;
  listener: DirectListener;
  client: BootedDevice;
  plane: DirectPlane;
  bridge: HubHandlers;
  peerA: PeerTransport;
};

// The whole direct wire the transfer checks share, exactly as
// production composes it: the stub device hub, a REAL direct
// listener on device A serving the check's contracts, the brokered hub
// pair (A answering connectInfo, B the dialing client), the REAL shared
// composition as B's bridge, and a counting peer transport aimed at A.
// The plane's presence path is wired to the client connection exactly
// as production wires it (late-bound, plus one catch-up call for the
// roster that connected before the plane existed), so the KEEPER is
// what establishes the B->A session -- eagerly, before any invoke,
// which is the supervised model the transfer checks now ride.
// Everything registers its teardown on the caller's tracker.
// `opts.contracts` lists the [contract, handlers] pairs A serves, each
// registered with output validation and a no-op usage hook: the hook is
// the Electron binding's concern, and the registrar only calls it for
// defs marked tracksProjectUsage (and requires it for a module that has
// one), so passing it everywhere satisfies the registrar and changes
// nothing else.
export async function bootDirectWire<const C extends readonly ContractModule[]>(
  track: Track,
  opts: { contracts?: ServedContracts<C> } = {},
): Promise<DirectWire> {
  const stub = await startStubHub(track);
  const listener = await startDirectListener(track, {
    deviceId: "A",
    registerHandlers: (binding) => {
      for (const [contract, handlers] of opts.contracts ?? []) {
        registerHostContract(
          contract,
          handlers,
          { handle: binding.serve, broadcastAll: binding.broadcastAll },
          {
            validateOutputs: true,
            onUsageTracked: () => {},
            invoke: invokeInCallSpan,
          },
        );
      }
    },
  });
  let onPlaneChange: (() => void) | null = null;
  const { client } = await bootBrokeredPair(stub, track, listener, {
    hostDeviceId: "A",
    clientDeviceId: "B",
    clientOnChange: () => onPlaneChange?.(),
  });
  // A's pushes on the session, as main's peer-push fan-out hands them
  // on (host/process/wires.ts onPeerPush), for the peer transport's
  // subscribe.
  const pushListeners = new Set<(push: HubPeerPush) => void>();
  const { plane, bridge } = makeDirectBridge(client, {
    localDeviceId: "B",
    onPeerPush: (push) => {
      for (const hear of pushListeners) hear(push);
    },
  });
  track(() => plane.stop());
  onPlaneChange = () => plane.handleConnectionChange();
  plane.handleConnectionChange();
  await waitFor(
    () => bridge.directPeerVersions().A !== undefined,
    "the keeper to establish the direct session to A",
  );
  const peerA = bridgePeerTransport(bridge, "A", pushListeners);
  return { stub, listener, client, plane, bridge, peerA };
}

export type DirectBridgeOpts = {
  localDeviceId?: string;
  onStatusChange?: DirectPlaneDeps["broadcastStatus"];
  onPeerPush?: DirectPlaneDeps["broadcastPeerPush"];
  dialableKinds?: DirectPlaneDeps["dialableKinds"];
  deadlineMs?: number;
  keeper?: DirectPlaneDeps["keeper"];
};

// The client-side composition under test: the REAL direct plane
// (dialer over the connection's connectInfo ask, bridge cache over the
// dialer) exactly as main and the web bridge assemble it. The fan-out
// sinks are observation seams the scenarios read, and the deadline
// is shrunk so failure scenarios settle fast.
export function makeDirectBridge(
  client: Pick<BootedDevice, "connection">,
  opts: DirectBridgeOpts = {},
): { plane: DirectPlane; bridge: HubHandlers } {
  const plane = createDirectPlane({
    connection: () => client.connection,
    localDeviceId: () => opts.localDeviceId ?? "A",
    localAppVersion: () => "1.0.0",
    broadcastStatus: (status) => opts.onStatusChange?.(status),
    broadcastPeerPush: (push) => opts.onPeerPush?.(push),
    dialableKinds: opts.dialableKinds,
    // The production socket (main injects ws), so the proof exercises
    // the errno detail the seam exists for rather than the bare 1006
    // of Node's global.
    openSocket: (url) => new WsClient(url),
    deadlineMs: opts.deadlineMs ?? 3000,
    // The keeper's clock/ladder seam, so retry scenarios advance a
    // TestClock instead of sleeping the real ladder out.
    keeper: opts.keeper,
  });
  return { plane, bridge: plane.handlers };
}

export type PeerTransport = {
  transport: ClientTransport;
  invokeCount(channel: string): number;
  channels(): ReturnType<HubHandlers["peerChannels"]>;
};

// A ClientTransport riding the bridge's cached direct session, with a
// per-channel invoke counter so a transfer check can pin poll-side
// chunking as round trips (the hub stub sees none of them, which the
// checks assert separately via forwardedCount). Its subscribe hears
// the peer's pushes off the bridge's fan-out, the way main's peer
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

// One link to a listener, dialed straight at its port with a ticket
// minted for `deviceId`, closed with the test.
export async function dialListener(
  track: Track,
  listener: Pick<DirectListener, "port" | "tickets">,
  opts: { deviceId?: string; hostDeviceId?: string } = {},
): Promise<DeviceConnection> {
  const deviceId = opts.deviceId ?? "client";
  const connection = await openDevice({
    url: `ws://127.0.0.1:${listener.port}`,
    ticket: mintTicket(listener.tickets, deviceId),
    appVersion: "1.0.0",
    localDeviceId: deviceId,
    expectedDeviceId: opts.hostDeviceId ?? "B",
    onClose: () => {},
    openSocket: (url) => new WsClient(url),
    deadlineMs: 3000,
  }).authenticate();
  track(() => connection.close());
  return connection;
}
