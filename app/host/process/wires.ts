// The wires the host serves on, and the registrar that mounts its
// handlers there: the device link's listener (host/socket/DeviceLink.ts)
// for peers, fronted by the tunnel; the same link on loopback
// (host/socket/Loopback.ts) for this machine's windows, its shell and
// its terminal; and the hub socket with the direct plane, which dials
// the peers. Every host-side module (`isHostSide`) registers here.
import { LOOPBACK_FILE } from "@shigomori/engine/Control";
import { ROSTER_UNAVAILABLE, STALE_TICKET } from "@shared/remote/sealedSocket";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import * as Terrier from "@shigomori/engine/Terrier";
import * as HostPushes from "@host/lib/HostPushes";
import type { HostServices } from "./services";
import * as Graph from "./graph";
import { join } from "node:path";
import { WebSocket as WsWebSocket } from "ws";
import {
  annotation,
  type ContractModule,
  nameOf,
  Remote,
} from "@shigomori/contracts/contract";
import { isHostSide } from "@shigomori/contracts/link";
import {
  hubContract,
  type HubPeerPush,
} from "@shigomori/contracts/modules/hub";
import { sharingContract } from "@shigomori/contracts/modules/sharing";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import type {
  EffectHandlers,
  PushKeys,
  PushProducerPayload,
  ViewHandlers,
} from "@shigomori/contracts/types";
import { createServed, resolvePush } from "@shared/ipc/served";
import type { HandlerContext } from "@shared/ipc/transport";
import * as DirectPlane from "@shared/hub/directPlane";
import type { HubConnection } from "@shared/hub/connection";
import {
  CLOUDFLARED_BINARY_NAME,
  CLOUDFLARED_DIST_DIR,
} from "@shared/packaging/cloudflaredDist.mts";
import * as TunnelService from "@host/direct/Tunnel";
import { makeConnectInfo } from "@host/direct/connectInfo";
import { reconcileOnLastPort } from "@host/direct/listenerPort";
import { devDialKinds, devFrontPort } from "@host/direct/dialKinds";
import { createConnectTicketStore } from "@host/direct/tickets";
import * as HubConnectionNode from "@host/hub/connection";
import { LayerDownError, layerLatch } from "@shared/layerLatch";
import * as DeviceId from "@host/lib/config/DeviceId";
import * as Engine from "@host/lib/Engine";
import * as Ops from "@host/lib/engineOps";
import { recordProjectActionUsage } from "@host/lib/projects/usage";
import { dataDir } from "@shared/paths";
import * as Sharing from "@host/lib/Sharing";
import { mirrorInviteAdmits, mirrorInviteSees } from "@host/mirror/invites";
import * as Loopback from "@host/socket/Loopback";
import * as DeviceLink from "@host/socket/DeviceLink";
import {
  acceptsPeerCommands,
  allowedWebOrigin,
  hubConnectInputs,
  provisionDeviceTunnel,
} from "./account";
import { hostBinaryPath, hostFacts, tunnelPidFile } from "./facts";

// The device link's listener. A peer's socket opens with one of the
// single-use connect tickets connectInfo mints over the device hub and
// a handshake proving the key the hub's roster names for the device it
// was minted for, and its gates serve a
// peer nothing while the sharing switch is off (Sharing) and run every
// call not annotated gated:false only under the command switch
// (acceptsPeerCommands): every ticketed peer is a device of this
// account, so the switches are the whole verdict. The gates are the
// only enforcement; everything else that shows the switches is a
// reading of them. The registrar records the handlers at start, while
// listening follows enrollment in refreshDirectHost below.
const directTickets = createConnectTicketStore();

// Every push the host makes, published synchronously so pushes keep
// their order, and never waiting on the graph: the hub is the root's,
// served into the graph by pushesLayer.
const pushes = Effect.runSync(PubSub.unbounded<HostPushes.Push>());
export const pushesLayer = HostPushes.layerOn(pushes);

// Actions that opt in via `tracksProjectUsage` rank their project for
// the sidebar's usage sorts, which reorder live on this push.
const onUsageTracked = (input: unknown) => {
  void Graph.run(recordProjectActionUsage(input)).then(
    (bumpedProjectId) => {
      if (bumpedProjectId) {
        broadcastAll(projectsContract, "usageBumped", {
          projectId: bumpedProjectId,
        });
      }
    },
    () => {},
  );
};

const linkRegistrar: DeviceLink.LinkRegistrar = createServed({
  failure: Engine.hostCallFailure,
  serves: (call) => annotation(call, Remote) === true,
  onUsageTracked,
});
export const deviceLinkLayer = () =>
  DeviceLink.layer({
    registrar: linkRegistrar,
    auth: {
      opens: {
        check: (ticket, arrivedAs) => {
          const deviceId = directTickets.check(ticket, arrivedAs);
          if (deviceId === null || deviceId === STALE_TICKET) return deviceId;
          const hub = remote.now()?.hub;
          if (hub === undefined || !hub.rosterKnown()) {
            return ROSTER_UNAVAILABLE;
          }
          const publicKey = hub.peerKey(deviceId);
          return publicKey === undefined
            ? STALE_TICKET
            : { deviceId, publicKey };
        },
        spend: (ticket, arrivedAs) => directTickets.consume(ticket, arrivedAs),
        keepDevices: (deviceIds) => directTickets.keepDevices(deviceIds),
        keyOf: (deviceId) => {
          const hub = remote.now()?.hub;
          return hub?.rosterKnown() === true
            ? hub.peerKey(deviceId)
            : ROSTER_UNAVAILABLE;
        },
        localKey: () => remote.now()?.hub.localKey() ?? null,
      },
      isCommandGranted: acceptsPeerCommands,
      // The switches' one exception: the mirrors this device asked for.
      isInvited: mirrorInviteAdmits,
    },
    // Not sharing, a mirror it asked for still follows its copy here.
    seesPush: mirrorInviteSees,
    services: Graph.services,
  });

// The sharing switch the link's gate reads. Its changes go to this
// device's windows and, the push being remote, to every peer.
export const sharingLayer = Sharing.layer({
  announce: (on) => broadcastAll(sharingContract, "changed", on),
});

// The listener and the tunnel, as the root's callbacks reach them.
const onLink = <A, E>(
  f: (link: DeviceLink.DeviceLink["Service"]) => Effect.Effect<A, E>,
) => Effect.flatMap(DeviceLink.DeviceLink, f);
const linkStatus = () =>
  Graph.readNow(
    onLink((link) => link.status),
    () => ({ listening: false, port: null, bindAddress: null, error: null }),
  );
const onTunnel = <A, E>(
  f: (tunnel: TunnelService.Tunnel["Service"]) => Effect.Effect<A, E>,
) => Effect.flatMap(TunnelService.Tunnel, f);

// The tunnel endpoint: a supervised cloudflared child fronting the
// listener's port through this device's named Cloudflare tunnel.
// Reconciled from refreshDirectHost so it follows the listener exactly,
// and sign-out, an account switch and directConnections off land here
// as reconcile(null) through the same path. The connector token stays
// inside the Tunnel.
export const tunnelLayer = () =>
  TunnelService.layer({
    // Resolved fresh per start attempt: the probe is one bounded
    // spawn, and any memo here would leave the install-cloudflared
    // recovery path (any config write re-probes) dead for the PATH
    // case.
    resolveBinary: Effect.promise(() => Graph.run(Ops.readGlobalConfig())).pipe(
      Effect.flatMap((config) =>
        TunnelService.resolveCloudflaredBinary(
          config.cloudflaredPath,
          hostBinaryPath(CLOUDFLARED_DIST_DIR, CLOUDFLARED_BINARY_NAME),
        ),
      ),
    ),
    provision: (port) =>
      Effect.tryPromise({
        try: () => provisionDeviceTunnel(port),
        catch: (cause) => new TunnelService.TunnelProvisionError({ cause }),
      }),
    pidFilePath: tunnelPidFile,
    // Tunnel state rides the hub status snapshot, so the account
    // page updates live.
    onChange: () => remote.now()?.plane.notifyStatusChanged(),
  });

// The device link again, on loopback, for the processes on this
// machine: the windows, the shell, and the terminal's control ops.
const loopbackRegistrar: DeviceLink.LinkRegistrar = createServed({
  failure: Engine.hostCallFailure,
  onUsageTracked,
});
export const loopbackLayer = () =>
  Layer.unwrap(
    Effect.map(DeviceId.current, (deviceId) =>
      Loopback.layer({
        registrar: loopbackRegistrar,
        deviceId: () => deviceId,
        appVersion: hostFacts().appVersion,
        file: () => join(dataDir(), LOOPBACK_FILE),
        // The window's own page dials it, from the renderer scheme.
        allowedOrigin: hostFacts().rendererOrigin,
        services: Graph.services,
      }),
    ),
  );

// This device's id, for the root's synchronous callbacks, which run
// once the graph is up.
let deviceId: string | undefined;
const deviceIdNow = () =>
  (deviceId ??= Graph.readNow(DeviceId.current, () => {
    throw new Error("The device id was asked before launch read it.");
  }));

// The host's own consumers of peer pushes (the mirror's git follower
// reacts to a peer's git:projectChanged and mirror:gitChanged), beside
// the fan-out to this machine's windows. Returns the unsubscribe.
type PeerPushListener = (push: HubPeerPush) => void;
const peerPushListeners = new Set<PeerPushListener>();

export function onPeerPush(listener: PeerPushListener): () => void {
  peerPushListeners.add(listener);
  return () => {
    peerPushListeners.delete(listener);
  };
}

// The window-facing hub module, which also lends its invokeOnPeer to
// the host's peer reach (handlers.ts).
export const hubHandlers = () => {
  const up = remote.now();
  if (up === undefined) {
    throw new LayerDownError({ name: "The device hub", reason: "is not up" });
  }
  return up.plane.handlers;
};

// The answer to a peer's connectInfo ask (host/direct/connectInfo.ts),
// the one question the device hub carries, with the switches the
// listener's gates read.
const serveConnectInfo = makeConnectInfo({
  listenerPort: () => {
    const current = linkStatus();
    return current.listening && current.port !== null
      ? devFrontPort(current.port, hostFacts().packaged)
      : null;
  },
  mintTickets: (peer, kinds) => directTickets.mint(peer, kinds),
  // The tunnel candidate, advertised only while the cloudflared child
  // is healthy (probed routable).
  tunnelUrl: () =>
    Graph.readNow(
      onTunnel((tunnel) => tunnel.tunnelUrl),
      () => null,
    ),
  tunnelStartingThenUp: (withinMs) =>
    Graph.run(
      onTunnel((tunnel) => tunnel.startingThenUp(Duration.millis(withinMs))),
    ).catch(() => false),
  tunnelUndialed: (peer) => directTickets.undialed(peer, "tunnel"),
  recheckTunnel: () => {
    void Graph.run(onTunnel((tunnel) => tunnel.recheck)).catch(() => {});
  },
  acceptsCommands: acceptsPeerCommands,
  // Before the graph is up the link serves nobody, so it reads as off.
  sharesData: () =>
    Graph.readNow(
      Effect.flatMap(Sharing.Sharing, (sharing) => sharing.current),
      () => false,
    ),
});

// The hub socket and the direct plane (shared/hub/directPlane.ts) it
// brokers, for the length of the graph: the dialer, the window-facing
// hub handlers, the status snapshot and the presence reconcile,
// assembled identically for the web bridge. Connecting itself is gated
// in refreshHubConnection below (signed out or unconfigured means no
// socket). The hub's status transitions go to the direct plane, which
// fans a snapshot out and reconciles direct-session presence on each.
// Peer pushes arrive over direct sessions only, never over the device
// hub. Closing it closes the socket, so the Durable Object sees a clean
// departure instead of waiting out a dead connection, and then the
// outbound links, or each remote host would keep a dead socket in its
// per-device slot and land the next start on the supersede path
// instead of a clean reconnect.
const remote = layerLatch<{
  readonly hub: HubConnection;
  readonly plane: DirectPlane.DirectPlane;
}>("The device hub");
export const remotePlanesLayer = Layer.effectDiscard(
  remote.provide(
    Effect.gen(function* () {
      const plane: DirectPlane.DirectPlane = yield* DirectPlane.make({
        connection: () => hub,
        localDeviceId: deviceIdNow,
        localAppVersion: () => hostFacts().appVersion,
        broadcastStatus: (status) =>
          broadcastAll(hubContract, "statusChanged", status),
        broadcastPeerPush: (push) => {
          broadcastAll(hubContract, "peerPush", push);
          for (const listener of peerPushListeners) listener(push);
        },
        // The candidate sockets ride the `ws` package so a failed dial
        // names its errno (see OpenClientSocket in
        // shared/remote/deviceLink.ts). Neither ws nor Node's global
        // sends an Origin header, so the peer's upgrade gate reads the
        // two identically. No permessage-deflate: the link's frames are
        // ciphertext, which does not compress.
        openSocket: (url) => new WsWebSocket(url, { perMessageDeflate: false }),
        dialableKinds: devDialKinds(hostFacts().packaged),
        host: {
          // A device the roster dropped loses its links and the tickets
          // it was handed but has not spent (DeviceLink.closePeersNotIn).
          closeHostPeersNotIn: (online) =>
            void Graph.runIfUp(onLink((link) => link.closePeersNotIn(online))),
          tunnelState: () =>
            Graph.readNow(
              onTunnel((tunnel) => tunnel.status),
              () => ({ state: "off" as const, hostname: null }),
            ).state,
        },
      });
      const hub: HubConnection = yield* HubConnectionNode.make({
        serveConnectInfo,
        onChange: () => plane.handleConnectionChange(),
      });
      return { hub, plane };
    }),
  ),
);

function assertHostSide(module: ContractModule): void {
  if (!isHostSide(module)) {
    throw new Error(`${nameOf(module)} is the shell's, not the host's`);
  }
}

// A host module, on the loopback and, for each call that opted into
// remote exposure, on the device link, whose gates read each call's own
// annotations (host/socket/DeviceLink.ts, CommandGate). A host call that is
// not remote (runtime:nuke, launchers:launch) is never there, and a
// peer asking for it gets the same no-handler answer as for a call the
// host does not serve at all. The device hub is not a wire here: it
// answers connectInfo and nothing else.
export function registerContract<M extends ContractModule>(
  module: M,
  handlers: EffectHandlers<M, HandlerContext, HostServices>,
): void {
  assertHostSide(module);
  loopbackRegistrar.serve(module, handlers);
  linkRegistrar.serve(module, handlers);
}

// A module's views (contract.ts, view), served on the device link to
// the peers its annotations admit, and on the loopback.
export function registerViews<M extends ContractModule>(
  module: M,
  views: ViewHandlers<M, HostServices>,
): void {
  linkRegistrar.view(module, views);
  loopbackRegistrar.view(module, views);
}

// A contract on the loopback alone (the control contract, and the
// shell's session with its host): its calls, and its views.
export function registerLoopbackContract<M extends ContractModule>(
  module: M,
  handlers: EffectHandlers<M, HandlerContext, HostServices>,
  views?: ViewHandlers<M, HostServices>,
): void {
  loopbackRegistrar.serve(module, handlers);
  if (views !== undefined) loopbackRegistrar.view(module, views);
}

// A push from the host: to every window and process on the loopback,
// which serves every one off the host's pushes, and, when annotated
// `remote`, to the device link's peers. A push of a shell module
// annotated `remote` is the host's to send its peers too
// (account:commandAccessChanged, as the switch the shell reported).
export function broadcastAll<M extends ContractModule, K extends PushKeys<M>>(
  module: M,
  key: K,
  payload: PushProducerPayload<M, K>,
): void {
  PubSub.publishUnsafe(pushes, resolvePush(module, key, payload));
}

// Reconciles the hub socket with the account. Runs at start and after
// every account change, so the socket follows the credential. The
// account read runs inside the binding's serialized lifecycle, so an
// overlapping refresh can never apply a stale read last, and a failure
// is a log line: a connect problem must never fail the account change
// that triggered it.
export async function refreshHubConnection(): Promise<void> {
  await Graph.run(
    Effect.flatMap(
      Effect.all([remote.get, DeviceId.current]),
      ([{ hub }, thisDevice]) =>
        hub.refresh(
          Effect.sync(() => {
            const inputs = hubConnectInputs();
            if (inputs === null) return null;
            return {
              hubUrl: inputs.hubUrl,
              // A different account rotates the credential, so accountId is
              // in the opts to force a reconnect onto the new account's
              // object instead of leaving the old socket live.
              accountId: inputs.accountId,
              deviceKey: inputs.deviceKey,
              mintTicket: inputs.mintTicket,
              deviceId: thisDevice,
            };
          }),
        ),
    ).pipe(
      Effect.ignoreCause({
        log: "Warn",
        message: "[hub] connection refresh failed",
      }),
    ),
  ).catch(() => undefined);
  // The listener follows the same enrollment condition, so it
  // reconciles on exactly the hub's cadence. Folded here so call sites
  // cannot forget one half.
  await refreshDirectHost();
}

// Tickets are account-scoped where the listener is not: an account
// change restarts the listener (dropping every authed socket), and
// this drops what could still auth one.
export function clearDirectTickets(): void {
  directTickets.clear();
}

// The wake-time liveness probe for the hub socket and every direct
// session: a socket that died while the machine slept gets its verdict
// within the probe window and redials at once.
export function probeRemoteConnections(): void {
  const up = remote.now();
  up?.hub.probe();
  up?.plane.probe();
}

const listenerPortPath = () => join(hostFacts().userDataPath, "direct-port");

// Reconciles the listener with the account and the device's config: run
// from refreshHubConnection's tail and on every device settings change
// (followDeviceSettings), so the directConnections opt-out applies
// without a restart. The config read runs inside the binding's
// serialized lifecycle. Dual-stack ("::") because connectInfo
// advertises IPv6 candidates too, on the port it listened on last
// (listenerPort.ts), read back from status. accountId rides the opts as
// an identity field, so an account switch restarts the listener and
// drops every socket authed under the old account.
export async function refreshDirectHost(): Promise<void> {
  await Graph.run(
    Effect.flatMap(DeviceLink.DeviceLink, (link) =>
      reconcileOnLastPort(
        link,
        listenerPortPath(),
        Effect.promise(async () => {
          const inputs = hubConnectInputs();
          if (inputs === null) return null;
          // The device-scoped opt-out: absent means enrolled, explicit
          // false stops the listener.
          const config = await Graph.run(Ops.readGlobalConfig());
          if (config.directConnections === false) return null;
          return {
            bindAddress: "::",
            deviceId: await Graph.run(DeviceId.current),
            appVersion: hostFacts().appVersion,
            accountId: inputs.accountId,
            // The web client's origin, so a browser can dial the wss tunnel
            // candidate.
            allowedOrigin: allowedWebOrigin(),
          };
        }),
      ),
    ).pipe(
      Effect.ignoreCause({
        log: "Warn",
        message: "[direct] listener refresh failed",
      }),
    ),
  ).catch(() => undefined);
  // The tunnel follows the listener: a running listener wants a tunnel
  // fronting its current port, and every condition that stopped the
  // listener stops the child through the same reconcile. A tunnel
  // problem must not fail the change that triggered the refresh.
  // Nothing to reconcile once the app is quitting: the layer's close
  // has stopped the child, and a graph that is down refuses the run.
  await Graph.run(
    Effect.suspend(() => {
      const listener = linkStatus();
      const wanted =
        listener.listening && listener.port !== null
          ? { port: devFrontPort(listener.port, hostFacts().packaged) }
          : null;
      // A reconcile that fails is the tunnel's to report, as before.
      return onTunnel((tunnel) => tunnel.reconcile(wanted)).pipe(Effect.ignore);
    }).pipe(
      Effect.ignoreCause({ log: "Warn", message: "[tunnel] reconcile failed" }),
    ),
  ).catch(() => undefined);
}

// What follows the device's settings wherever they are written, the
// Settings form or `sm config` in a terminal: `reconcile` (the listener
// and its tunnel, refreshDirectHost), and terrier's readiness, re-probed
// in case its toggle flipped. The start's pass is the account's first
// report (handlers.ts applyAccount).
export const followDeviceSettings = (reconcile: Effect.Effect<void>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const written = yield* (yield* StoreChanges.StoreChanges).subscribe;
      const terrier = yield* Terrier.Terrier;
      yield* written.pipe(
        Stream.filter((tables) => tables.has("device_config")),
        Stream.runForEach(() =>
          terrier.invalidate.pipe(Effect.andThen(reconcile)),
        ),
        Effect.forkScoped,
      );
    }),
  );
