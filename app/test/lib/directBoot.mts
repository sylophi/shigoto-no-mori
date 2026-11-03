// The direct sandbox: two devices on a REAL direct link, beside the
// stub device hub (hubStub.mts). The listener is a REAL direct ws
// listener (host/socket/DeviceLink.ts) with its ticket store and command
// switch, answering connectInfo through the hub as the host does. The
// dialer drives the REAL shared composition (shared/hub/directPlane.ts).
// What each proof adds is its own handlers and what it asserts.
import { STALE_TICKET } from "@shared/remote/sealedSocket";
import assert from "node:assert/strict";
import { makeConnectInfo } from "@host/direct/connectInfo";
import * as DeviceLink from "@host/socket/DeviceLink";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import * as HostPushes from "@host/lib/HostPushes";
import * as Views from "@host/lib/Views";
import * as Sharing from "@host/lib/Sharing";
import {
  createConnectTicketStore,
  type ConnectTicketStore,
} from "@host/direct/tickets";
import type { HubConnection } from "@shared/hub/connection";
import {
  type HubConnectionOpts,
  make as makeHubConnection,
} from "@host/hub/connection";
import type { HubHandlers } from "@shared/hub/bridgeHandlers";
import { make as makeDirectPlane } from "@shared/hub/directPlane";
import type { ContractModule } from "@shigomori/contracts/contract";
import { accountContract } from "@shigomori/contracts/modules/account";
import type { HubPeerPush } from "@shigomori/contracts/modules/hub";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as HostRpc from "@host/socket/hostRpc";
import type { HostServices } from "@host/process/services";
import { hostContext } from "./hostRuntime.mts";
import type { HandlerContext } from "@shared/ipc/transport";
import type * as PeerReach from "@host/ipc/PeerReach";
import { WebSocket as WsClient } from "ws";
import { startStubHub, type StubHub, testDeviceKey } from "./hubStub.mts";
import { type Track, waitFor } from "./checkKit.mts";

// The two devices, named by their part in the link: the one that dials
// and the one that listens. Each seals with its test key (hubStub.mts).
export const DIALER = "dialer";
export const LISTENER = "listener";

// How long each leg of a dial may take.
const DIAL_DEADLINE_MS = 3000;

type ServedContracts<C extends readonly ContractModule[]> = {
  [I in keyof C]: readonly [
    C[I],
    EffectHandlers<C[I], HandlerContext, HostServices>,
  ];
};

type DirectListener = {
  tickets: ConnectTicketStore;
  acceptsCommands(): boolean;
  setAccepts(next: boolean): void;
  sharesData(): boolean;
  listenerPort(): number | null;
};

// A REAL direct listener on an ephemeral loopback port serving
// `contracts`, with its ticket store and the two answers a peer reads:
// command access (the host-wide "accepts commands from its account's
// devices" answer the real binding reads from the account's facts) and
// sharing (on, as a device starts). Flipping command access pushes it to
// every connected peer, as the host does, so a peer's bridge follows it
// live.
async function startDirectListener<const C extends readonly ContractModule[]>(
  track: Track,
  contracts: ServedContracts<C>,
  // What the listener's graph runs on beyond its own (a file-sync
  // engine), over the proof file's host services.
  provide: Layer.Layer<never>,
): Promise<DirectListener> {
  const tickets = createConnectTicketStore();
  let accepts = false;
  const sharing = Effect.runSync(SubscriptionRef.make(true));
  const served = Layer.mergeAll(
    Layer.empty,
    ...contracts.map(([contract, handlers]) =>
      HostRpc.handlers(contract, handlers),
    ),
  );
  const host = await hostContext();
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      // Its calls run on the services beneath it, there from the start.
      Layer.unwrap(
        Effect.map(Effect.context<HostServices>(), (services) =>
          DeviceLink.layer({
            auth: {
              // The roster's keys are the test keys (hubStub.mts), and
              // the listener seals with its own.
              opens: {
                check: (ticket, arrivedAs) => {
                  const deviceId = tickets.check(ticket, arrivedAs);
                  if (deviceId === null || deviceId === STALE_TICKET) {
                    return deviceId;
                  }
                  return {
                    deviceId,
                    publicKey: testDeviceKey(deviceId).pair.publicKey,
                  };
                },
                spend: (ticket, arrivedAs) =>
                  tickets.consume(ticket, arrivedAs),
                keepDevices: (deviceIds) => tickets.keepDevices(deviceIds),
                keyOf: (deviceId) => testDeviceKey(deviceId).pair.publicKey,
                localKey: () => testDeviceKey(LISTENER).pair,
              },
              isCommandGranted: () => accepts,
            },
          }).pipe(
            Layer.provide(served),
            Layer.provide(
              Layer.succeed(HostRpc.HostGraph, Effect.succeed(services)),
            ),
          ),
        ),
      ),
      Layer.mergeAll(
        // The host's services, beneath the stand-ins below.
        Layer.succeedContext(host),
        HostPushes.layer,
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
        Layer.succeed(StoreChanges.StoreChanges, {
          subscribe: Effect.succeed(Stream.never),
          release: Effect.void,
        }),
        provide,
      ),
    ),
  );
  track(() => runtime.dispose());
  const onLink = <A,>(
    f: (link: DeviceLink.DeviceLink["Service"]) => Effect.Effect<A>,
  ) => runtime.runPromise(Effect.flatMap(DeviceLink.DeviceLink, f));
  await onLink((link) =>
    link.reconcile(
      Effect.succeed({
        port: 0,
        bindAddress: "127.0.0.1",
        deviceId: LISTENER,
        appVersion: "2.0.0",
        helloTimeoutMs: 1000,
      }),
    ),
  );
  const status = await onLink((link) => link.status);
  assert.ok(status.port !== null, "the listener did not bind");
  return {
    tickets,
    acceptsCommands: () => accepts,
    setAccepts: (next) => {
      accepts = next;
      runtime.runSync(
        HostPushes.push(accountContract, "commandAccessChanged", next),
      );
    },
    sharesData: () => Effect.runSync(SubscriptionRef.get(sharing)),
    listenerPort: () => (status.listening ? status.port : null),
  };
}

// Boots one device on the stub device hub and waits until it connects.
// `opts.serveConnectInfo` is the one thing the hub wire can answer
// (absent: a dial-only device that refuses every ask as serving no
// listener). The teardown is registered before the wait, so a boot that
// fails it still gets cleaned up and cannot leak the event loop.
async function bootDevice(
  stub: StubHub,
  deviceId: string,
  opts: HubConnectionOpts,
  track: Track,
): Promise<HubConnection> {
  const scope = Scope.makeUnsafe();
  const connection = Effect.runSync(
    makeHubConnection(opts).pipe(Scope.provide(scope)),
  );
  track(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  await Effect.runPromise(
    connection.refresh(
      Effect.succeed({
        hubUrl: stub.hubUrl,
        accountId: "acct",
        mintTicket: async (connectionId: string) =>
          `t:${deviceId}:desktop:${connectionId}`,
        deviceId,
        deviceKey: testDeviceKey(deviceId).privateKey,
      }),
    ),
  );
  await waitFor(
    () => connection.status().socket.phase === "connected",
    `${deviceId} to connect`,
  );
  return connection;
}

// The dialer bridged to `listener` through a stub device hub of its
// own: the listener's hub device answers connectInfo with the REAL
// server (the ONLY thing the hub wire answers, wired as the host wires
// it), and the dialer's REAL direct plane, exactly as the host
// assembles it, asks it. The plane's presence path is wired to the
// dialer's hub connection as production wires it (late-bound, plus one
// catch-up call for the roster that connected before the plane
// existed), so its keeper dials the listener on its own. The plane
// stops with the test, closing its sessions.
async function bridgeTo(
  track: Track,
  listener: DirectListener,
  onPeerPush: (push: HubPeerPush) => void,
): Promise<HubHandlers> {
  const stub = await startStubHub(track);
  let onPlaneChange: (() => void) | null = null;
  const serveConnectInfo = makeConnectInfo({
    listenerPort: listener.listenerPort,
    mintTickets: (peerDeviceId, kinds) =>
      listener.tickets.mint(peerDeviceId, kinds),
    // Deterministic candidates: the listener binds loopback, so real
    // interface enumeration would offer unreachable LAN addresses.
    candidateAddresses: () => ["127.0.0.1"],
    tunnelUrl: () => null,
    acceptsCommands: listener.acceptsCommands,
    sharesData: listener.sharesData,
  });
  // The two devices are independent, so they boot concurrently.
  const [, dialer] = await Promise.all([
    bootDevice(stub, LISTENER, { serveConnectInfo }, track),
    bootDevice(stub, DIALER, { onChange: () => onPlaneChange?.() }, track),
  ]);
  const scope = Scope.makeUnsafe();
  const plane = Effect.runSync(
    makeDirectPlane({
      connection: () => dialer,
      localDeviceId: () => DIALER,
      localAppVersion: () => "1.0.0",
      broadcastStatus: () => {},
      broadcastPeerPush: onPeerPush,
      // The production socket (the host injects ws), so the proof
      // exercises the errno detail the seam exists for rather than the
      // bare 1006 of Node's global.
      openSocket: (url) => new WsClient(url),
      deadlineMs: DIAL_DEADLINE_MS,
    }).pipe(Scope.provide(scope)),
  );
  track(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  onPlaneChange = () => plane.handleConnectionChange();
  plane.handleConnectionChange();
  return plane.handlers;
}

type PeerReachDeps = Omit<
  Parameters<typeof PeerReach.make>[0],
  "admissions" | "admits"
>;

export type DirectWire = {
  listener: DirectListener;
  toListener: PeerReachDeps;
};

// The whole direct wire the transfer checks share, exactly as
// production composes it: a REAL direct listener serving the check's
// contracts, the dialer's REAL direct plane supervised over the stub
// device hub (bridgeTo), and a peer reach aimed at the listener. The
// keeper establishes the session eagerly, before any invoke, which is
// the supervised model the transfer checks ride. Everything registers
// its teardown on the caller's tracker. `opts.contracts` lists the
// [contract, handlers] pairs the listener serves, each as the host
// serves it (host/socket/hostRpc.ts).
export async function bootDirectWire<const C extends readonly ContractModule[]>(
  track: Track,
  opts: { contracts: ServedContracts<C>; provide?: Layer.Layer<never> },
): Promise<DirectWire> {
  const listener = await startDirectListener(
    track,
    opts.contracts,
    opts.provide ?? Layer.empty,
  );
  // The listener's pushes on the session, as the host's hub:peerPush
  // hands them on (host/process/wires.ts), for the peer transport's
  // subscribe.
  const pushListeners = new Set<(push: HubPeerPush) => void>();
  const bridge = await bridgeTo(track, listener, (push) => {
    for (const hear of pushListeners) hear(push);
  });
  await waitFor(
    () => bridge.directPeers().peerAppVersions[LISTENER] !== undefined,
    "the keeper to establish the direct session to the listener",
  );
  return { listener, toListener: bridgePeerReach(bridge, pushListeners) };
}

// The host's peer reach (host/process/handlers.ts) over the bridge's
// cached direct session to the listener, whichever device a call names:
// both devices' handlers run in this process, so the listener's reach
// into its own peer lands here too. Its calls, the peer's pushes off
// the bridge's fan-out, and the session's byte channels
// (shared/remote/channels.ts), resolving like invokePeer does.
function bridgePeerReach(
  bridge: HubHandlers,
  pushListeners: Set<(push: HubPeerPush) => void>,
): PeerReachDeps {
  return {
    invoke: (_, channel, input) =>
      bridge.invokeOnPeer(LISTENER, channel, input),
    onPush: (_, channel, handler) => {
      const listener = (push: HubPeerPush) => {
        if (push.deviceId === LISTENER && push.channel === channel) {
          handler(push.payload);
        }
      };
      pushListeners.add(listener);
      return () => pushListeners.delete(listener);
    },
    channelsFor: () => () => Effect.runPromise(bridge.peerChannels(LISTENER)),
  };
}
