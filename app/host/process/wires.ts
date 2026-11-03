// The wires the host serves on. The device link's listener
// (host/socket/DeviceLink.ts) is for peers, fronted by the tunnel. The
// same link on loopback (host/socket/Loopback.ts) is for this machine's
// windows, its shell and its terminal. The hub socket with the direct
// plane dials the peers. The handlers they serve are layer.ts's to give
// them (handlers.ts).
import { hubConnectInputs } from "@shared/account/hubConnect";
import { ROSTER_UNAVAILABLE, STALE_TICKET } from "@shared/remote/sealedSocket";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import * as Terrier from "@shigomori/engine/Terrier";
import * as HostPushes from "@host/lib/HostPushes";
import * as Graph from "./graph";
import { join } from "node:path";
import { WebSocket as WsWebSocket } from "ws";
import { LOOPBACK_FILE } from "@shigomori/contracts/link";
import { hubContract } from "@shigomori/contracts/modules/hub";
import * as DirectPlane from "@shared/hub/directPlane";
import type { HubConnection } from "@shared/hub/connection";
import * as TunnelService from "@host/direct/Tunnel";
import { makeConnectInfo } from "@host/direct/connectInfo";
import { reconcileOnLastPort } from "@host/direct/listenerPort";
import { devDialKinds, devFrontPort } from "@host/direct/dialKinds";
import { createConnectTicketStore } from "@host/direct/tickets";
import * as HubConnectionNode from "@host/hub/connection";
import { LayerDownError, layerLatch } from "@shared/layerLatch";
import * as DeviceId from "@host/lib/config/DeviceId";
import { dataDir } from "@shared/paths";
import * as Sharing from "@host/lib/Sharing";
import * as PeerReach from "@host/ipc/PeerReach";
import * as Loopback from "@host/socket/Loopback";
import * as DeviceLink from "@host/socket/DeviceLink";
import { acceptsPeerCommands, allowedWebOrigin, hubAccount } from "./account";
import { hostFacts } from "./facts";
import * as EngineConfig from "@shigomori/engine/Config";

// The device link's listener. A peer's socket opens with one of the
// single-use connect tickets connectInfo mints over the device hub and
// a handshake proving the key the hub's roster names for the device it
// was minted for, and its gates serve a
// peer nothing while the sharing switch is off (Sharing) and run every
// call not annotated gated:false only under the command switch
// (acceptsPeerCommands): every ticketed peer is a device of this
// account, so the switches are the whole verdict. The gates are the
// only enforcement; everything else that shows the switches is a
// reading of them. Listening follows enrollment in refreshDirectHost
// below.
const directTickets = createConnectTicketStore();

export const deviceLinkLayer = DeviceLink.layer({
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
        return publicKey === undefined ? STALE_TICKET : { deviceId, publicKey };
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
  },
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
export const tunnelLayer = TunnelService.layer({
  // Tunnel state rides the hub status snapshot, so the account
  // page updates live.
  onChange: () => remote.now()?.plane.notifyStatusChanged(),
});

// The device link again, on loopback, for the processes on this
// machine: the windows, the shell, and the terminal's control ops.
export const loopbackLayer = Layer.unwrap(
  Effect.map(DeviceId.current, (deviceId) =>
    Loopback.layer({
      deviceId: () => deviceId,
      appVersion: hostFacts().appVersion,
      file: () => join(dataDir(), LOOPBACK_FILE),
      // The window's own page dials it, from the renderer scheme.
      allowedOrigin: hostFacts().rendererOrigin,
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

// Each peer as it comes to take this device's calls (PeerReach's
// admissions), off the status snapshots.
export const peerAdmissions = Effect.runSync(PeerReach.makeAdmissions);

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
  tunnelUndialed: (peerDeviceId, runs) =>
    directTickets.claimUndialed(peerDeviceId, "tunnel", runs),
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

// The hub socket and the direct plane it brokers
// (shared/hub/directPlane.ts), for the length of the graph. Connecting
// is gated in refreshHubConnection below. Closing it closes the socket
// first, so the Durable Object sees a clean departure, then the
// outbound links, or each peer would land our next start on the
// supersede path.
const remote = layerLatch<{
  readonly hub: HubConnection;
  readonly plane: DirectPlane.DirectPlane;
}>("The device hub");
export const remotePlanesLayer = Layer.effectDiscard(
  remote.provide(
    Effect.gen(function* () {
      const pushes = yield* HostPushes.HostPushes;
      const plane: DirectPlane.DirectPlane = yield* DirectPlane.make({
        connection: () => hub,
        localDeviceId: deviceIdNow,
        localAppVersion: () => hostFacts().appVersion,
        broadcastStatus: (status) => {
          peerAdmissions.note(status);
          pushes.publishUnsafe(hubContract, "statusChanged", status);
        },
        broadcastPeerPush: (push) =>
          pushes.publishUnsafe(hubContract, "peerPush", push),
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
          Effect.sync(() => hubConnectInputs(hubAccount, thisDevice)),
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
          const inputs = hubAccount();
          if (inputs === null) return null;
          // The device-scoped opt-out: absent means enrolled, explicit
          // false stops the listener.
          const config = await Graph.run(
            Effect.flatMap(EngineConfig.Config, (engine) => engine.readDevice),
          );
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
      // A reconcile that fails is the tunnel's to report.
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
