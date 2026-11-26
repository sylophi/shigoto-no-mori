// The direct sandbox: two devices joined by a pair of in-memory links
// where Colibrii would carry them. The listener is the REAL link server
// (host/socket/DeviceLink.ts) with its command switch and sharing, which
// admits the dialer's hello and serves its link as the host does. The
// dialer drives the REAL shared composition (shared/hub/directPlane.ts)
// over a stand-in device whose roster names the listener and whose dial
// hands the listener the other end. What each proof adds is its own
// handlers and what it asserts.
import { randomUUID } from "node:crypto";
import * as Colibrii from "@colibrii/sdk";
import * as DeviceLink from "@host/socket/DeviceLink";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import * as DeviceId from "@host/lib/config/DeviceId";
import * as HostFacts from "@host/lib/HostFacts";
import * as HostPushes from "@host/lib/HostPushes";
import * as Views from "@host/lib/Views";
import * as Sharing from "@host/lib/Sharing";
import type { HubHandlers } from "@shared/hub/bridgeHandlers";
import {
  make as makeDirectPlane,
  type PeerDevice,
} from "@shared/hub/directPlane";
import type { ContractModule } from "@shigomori/contracts/contract";
import { accountContract } from "@shigomori/contracts/modules/account";
import type { HubPeerPush } from "@shigomori/contracts/modules/hub";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as HostRpc from "@host/socket/hostRpc";
import type { HostServices } from "@host/process/services";
import { hostContext } from "./hostRuntime.mts";
import type { HandlerContext } from "@shared/ipc/transport";
import type * as PeerReach from "@host/ipc/PeerReach";
import { type Track, waitFor } from "./checkKit.mts";

// The two devices, named by their part in the link: the one that dials
// and the one that listens.
export const DIALER = "dialer";
export const LISTENER = "listener";

type ServedContracts<C extends readonly ContractModule[]> = {
  [I in keyof C]: readonly [
    C[I],
    EffectHandlers<C[I], HandlerContext, HostServices>,
  ];
};

type DirectListener = {
  // Its side of a link: the welcome to a hello, and the link served.
  link: DeviceLink.DeviceLink["Service"];
  // Runs the link's serving where the listener's services are.
  fork: (effect: Effect.Effect<void>) => void;
  acceptsCommands(): boolean;
  setAccepts(next: boolean): void;
  sharesData(): boolean;
};

// Two ends of one link, as Colibrii hands them to each side: what one
// sends the other reads, and either closing closes both.
const linkPair = (greeting: Uint8Array) =>
  Effect.gen(function* () {
    const connectionId = randomUUID();
    const toDialer = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const toListener = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const closed = yield* Deferred.make<Colibrii.LinkClosed>();
    const close = Effect.gen(function* () {
      yield* Deferred.succeed(closed, {
        code: 1000,
        cause: "closed",
      } satisfies Colibrii.LinkClosed);
      yield* Queue.end(toDialer);
      yield* Queue.end(toListener);
    });
    const end = (
      deviceId: string,
      role: Colibrii.Link["role"],
      inbound: Queue.Queue<Uint8Array, Cause.Done>,
      outbound: Queue.Queue<Uint8Array, Cause.Done>,
    ): Colibrii.Link => ({
      deviceId,
      connectionId,
      role,
      arrival: "lan",
      greeting,
      send: (message) =>
        Effect.flatMap(Deferred.isDone(closed), (done) =>
          done
            ? Effect.fail(new Colibrii.LinkClosedError())
            : Effect.asVoid(Queue.offer(outbound, message)),
        ),
      messages: Stream.fromQueue(inbound).pipe(Stream.orDie),
      close,
      closed: Deferred.await(closed),
    });
    return {
      dialer: end(LISTENER, "dialer", toDialer, toListener),
      listener: end(DIALER, "listener", toListener, toDialer),
      close,
    };
  });

// The REAL link server serving `contracts`, with the two answers a peer
// reads: command access (the host-wide "accepts commands from its
// account's devices" answer the real binding reads from the account's
// facts) and sharing (on, as a device starts). Flipping command access
// pushes it to every connected peer, as the host does, so a peer's
// bridge follows it live.
async function startDirectListener<const C extends readonly ContractModule[]>(
  track: Track,
  contracts: ServedContracts<C>,
  // What the listener's graph runs on beyond its own (a file-sync
  // engine), over the proof file's host services.
  provide: Layer.Layer<never>,
): Promise<DirectListener> {
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
          DeviceLink.layer({ isCommandGranted: () => accepts }).pipe(
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
          DeviceId.DeviceId,
          DeviceId.DeviceId.of({ id: LISTENER }),
        ),
        Layer.succeed(
          HostFacts.HostFacts,
          HostFacts.HostFacts.of({
            packaged: false,
            appPath: "",
            resourcesPath: "",
            appVersion: "2.0.0",
            userDataPath: "",
            logsPath: "",
            rendererOrigin: "",
            flavor: "dev",
          }),
        ),
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
  const link = await runtime.runPromise(Effect.service(DeviceLink.DeviceLink));
  return {
    link,
    fork: (effect) => void runtime.runFork(effect),
    acceptsCommands: () => accepts,
    setAccepts: (next) => {
      accepts = next;
      runtime.runSync(
        HostPushes.push(accountContract, "commandAccessChanged", next),
      );
    },
    sharesData: () => Effect.runSync(SubscriptionRef.get(sharing)),
  };
}

// The dialer's device as the plane sees it: enrolled, the listener
// online, and a dial that the listener admits and serves as Colibrii
// would hand it the link.
const dialerDevice = (listener: DirectListener): PeerDevice => ({
  account: Stream.make({
    _tag: "Enrolled",
    deviceId: DIALER,
    accountId: "acct",
    connected: true,
    settled: true,
  } as const),
  roster: Stream.make([
    { deviceId: LISTENER, publicKey: new Uint8Array(), connections: "single" },
  ]),
  dial: (deviceId, appHello) =>
    Effect.gen(function* () {
      const welcome = yield* listener.link
        .admit({
          deviceId: DIALER,
          connectionId: randomUUID(),
          arrival: "lan",
          appHello,
        })
        .pipe(
          Effect.mapError(
            (refusal) =>
              new Colibrii.LinkRefusedError({
                deviceId,
                by: "app",
                reason: refusal.reason,
                ...(refusal.appRefusal === undefined
                  ? {}
                  : { appRefusal: refusal.appRefusal }),
              }),
          ),
        );
      const pair = yield* linkPair(welcome);
      listener.fork(listener.link.serve(pair.listener));
      yield* Effect.addFinalizer(() => pair.close);
      return pair.dialer;
    }),
  wakes: Stream.never,
});

// The dialer's REAL direct plane, exactly as the host assembles it,
// over the stand-in device: its keeper dials the listener on its own.
// The plane stops with the test, closing its sessions.
function bridgeTo(
  track: Track,
  listener: DirectListener,
  onPeerPush: (push: HubPeerPush) => void,
): HubHandlers {
  const scope = Scope.makeUnsafe();
  const handlers = Effect.runSync(
    makeDirectPlane({
      device: dialerDevice(listener),
      localDeviceId: DIALER,
      localAppVersion: "1.0.0",
      broadcastStatus: () => {},
      broadcastPeerPush: onPeerPush,
    }).pipe(Scope.provide(scope)),
  );
  track(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  return handlers;
}

type PeerReachDeps = Omit<
  Parameters<typeof PeerReach.make>[0],
  "admissions" | "admits"
>;

export type DirectWire = {
  listener: DirectListener;
  toListener: PeerReachDeps;
};

// The whole direct wire the transfer checks share, as production
// composes it on both sides of Colibrii: a REAL link server serving the
// check's contracts, the dialer's REAL direct plane (bridgeTo), and a
// peer reach aimed at the listener. The keeper establishes the session
// eagerly, before any invoke, which is the supervised model the
// transfer checks ride. Everything registers its teardown on the
// caller's tracker. `opts.contracts` lists the [contract, handlers]
// pairs the listener serves, each as the host serves it
// (host/socket/hostRpc.ts).
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
  const bridge = bridgeTo(track, listener, (push) => {
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
