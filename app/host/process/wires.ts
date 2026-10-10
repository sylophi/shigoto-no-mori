// The wires the host serves on, and the registrar that mounts its
// handlers there: the device link's listener (host/socket/server.ts)
// for peers, fronted by the tunnel; the same link on loopback
// (host/socket/loopback.ts) for this machine's windows, its shell and
// its terminal; and the hub socket with the direct plane, which dials
// the peers. Every host-side module (`isHostSide`) registers here.
import { ROSTER_UNAVAILABLE } from "@shared/remote/sealedSocket";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as HostPushes from "@host/lib/hostPushes";
import type { HostServices } from "./services";
import * as Graph from "./graph";
import type * as Stream from "effect/Stream";
import { join } from "node:path";
import { WebSocket as WsWebSocket } from "ws";
import { type ContractModule, nameOf } from "@shigomori/contracts/contract";
import { isHostSide } from "@shigomori/contracts/link";
import {
  hubContract,
  type HubPeerPush,
} from "@shigomori/contracts/modules/hub";
import { sharingContract } from "@shigomori/contracts/modules/sharing";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import type {
  BroadcastKeys,
  BroadcastProducerPayload,
  ViewHandlers,
} from "@shigomori/contracts/types";
import {
  broadcastAll as broadcastAllCore,
  type EffectHandlers,
  registerHostContract,
} from "@shared/ipc/registerContract";
import type {
  EffectServerTransport,
  HandlerContext,
} from "@shared/ipc/transport";
import { createDirectPlane } from "@shared/hub/directPlane";
import { logFailure } from "@shared/log";
import {
  CLOUDFLARED_BINARY_NAME,
  CLOUDFLARED_DIST_DIR,
} from "@shared/packaging/cloudflaredDist.mts";
import * as TunnelService from "@host/direct/cloudflared";
import { makeConnectInfo } from "@host/direct/connectInfo";
import { devDialKinds } from "@host/direct/dialKinds";
import { createConnectTicketStore } from "@host/direct/tickets";
import { createHubConnection } from "@host/hub/connection";
import { getDeviceId } from "@host/lib/config/deviceId";
import * as Ops from "@host/lib/engineOps";
import { recordProjectActionUsage } from "@host/lib/projects/usage";
import { dataDir } from "@host/lib/util/paths";
import * as Sharing from "@host/lib/sharing";
import { mirrorInviteAdmits, mirrorInviteSees } from "@host/mirror/invites";
import * as Loopback from "@host/socket/loopback";
import * as DeviceLink from "@host/socket/server";
import {
  acceptsPeerCommands,
  allowedWebOrigin,
  hubConnectInputs,
  provisionDeviceTunnel,
} from "./account";
import { hostBinaryPath, hostFacts } from "./facts";

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

const linkRegistrar = DeviceLink.createLinkRegistrar();
export const deviceLinkLayer = () =>
  DeviceLink.layer({
    registrar: linkRegistrar,
    auth: {
      opens: {
        check: (ticket, arrivedAs) => {
          const deviceId = directTickets.check(ticket, arrivedAs);
          if (deviceId === null) return null;
          if (!hubServer.rosterKnown()) return ROSTER_UNAVAILABLE;
          const publicKey = hubServer.peerKey(deviceId);
          return publicKey === undefined ? null : { deviceId, publicKey };
        },
        spend: (ticket, arrivedAs) => directTickets.consume(ticket, arrivedAs),
        keepDevices: (deviceIds) => directTickets.keepDevices(deviceIds),
        keyOf: (deviceId) =>
          hubServer.rosterKnown()
            ? hubServer.peerKey(deviceId)
            : ROSTER_UNAVAILABLE,
        localKey: () => hubServer.localKey(),
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
    // The live child's pid, so a crashed host's leftover connector
    // is killed on the next start.
    pidFilePath: () => join(hostFacts().userDataPath, "cloudflared.pid"),
    // Tunnel state rides the hub status snapshot, so the account
    // page updates live.
    onChange: () => directPlane().notifyStatusChanged(),
  });

// The device link again, on loopback, for the processes on this
// machine: the windows, the shell, and the terminal's control ops.
const loopbackRegistrar = DeviceLink.createLinkRegistrar();
export const loopbackLayer = () =>
  Loopback.layer({
    registrar: loopbackRegistrar,
    deviceId: () => getDeviceId(),
    appVersion: hostFacts().appVersion,
    file: () => join(dataDir(), Loopback.LOOPBACK_FILE),
    // The window's own page dials it, from the renderer scheme.
    allowedOrigin: hostFacts().rendererOrigin,
    services: Graph.services,
  });

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

// The direct plane (shared/hub/directPlane.ts): the dialer, the
// window-facing hub handlers, the status snapshot and the presence
// reconcile, assembled identically for the web bridge. Built on first
// use, since its dialable kinds read a fact.
let plane: ReturnType<typeof createDirectPlane> | undefined;
const directPlane = () =>
  (plane ??= createDirectPlane({
    connection: () => hubServer,
    localDeviceId: () => getDeviceId(),
    localAppVersion: () => hostFacts().appVersion,
    broadcastStatus: (status) =>
      broadcastAll(hubContract, "statusChanged", status),
    broadcastPeerPush: (push) => {
      broadcastAll(hubContract, "peerPush", push);
      for (const listener of peerPushListeners) listener(push);
    },
    // The candidate sockets ride the `ws` package so a failed dial names
    // its errno (see OpenClientSocket in shared/remote/deviceLink.ts).
    // Neither ws nor Node's global sends an Origin header, so the
    // peer's upgrade gate reads the two identically. No
    // permessage-deflate: the link's frames are ciphertext, which does
    // not compress.
    openSocket: (url) => new WsWebSocket(url, { perMessageDeflate: false }),
    dialableKinds: devDialKinds(),
    host: {
      // A device the roster dropped loses its links and the tickets it
      // was handed but has not spent (DeviceLink.closePeersNotIn).
      closeHostPeersNotIn: (online) =>
        void Graph.runIfUp(onLink((link) => link.closePeersNotIn(online))),
      tunnelState: () =>
        Graph.readNow(
          onTunnel((tunnel) => tunnel.status),
          () => ({ state: "off" as const, hostname: null }),
        ).state,
    },
  }));

// The window-facing hub module, which also lends its invokeOnPeer to
// the host's peer reach (handlers.ts).
export const hubHandlers = () => directPlane().handlers;

// The answer to a peer's connectInfo ask (host/direct/connectInfo.ts),
// the one question the device hub carries, with the switches the
// listener's gates read.
const serveConnectInfo = makeConnectInfo({
  listenerPort: () => {
    const current = linkStatus();
    return current.listening ? current.port : null;
  },
  mintTickets: (peer, kinds) => directTickets.mint(peer, kinds),
  // The tunnel candidate, advertised only while the cloudflared child
  // is healthy (probed routable).
  tunnelUrl: () =>
    Graph.readNow(
      onTunnel((tunnel) => tunnel.tunnelUrl),
      () => null,
    ),
  acceptsCommands: acceptsPeerCommands,
  // Before the graph is up the link serves nobody, so it reads as off.
  sharesData: () =>
    Graph.readNow(
      Effect.flatMap(Sharing.Sharing, (sharing) => sharing.current),
      () => false,
    ),
});

// The hub connection: connecting itself is gated in
// refreshHubConnection below (signed out or unconfigured means no
// socket). Its status transitions go to the direct plane, which fans a
// snapshot out and reconciles direct-session presence on each. Peer
// pushes arrive over direct sessions only, never over the device hub.
const hubServer = createHubConnection({
  serveConnectInfo,
  onChange: () => directPlane().handleConnectionChange(),
});

// The loopback serves every host call. The device link serves a call
// only when it opted into remote exposure, so a host call that is not
// remote (runtime:nuke, launchers:launch) is never registered there,
// and a peer asking for it gets the same no-handler answer as for a
// channel the host does not serve at all. The device hub is not a wire
// here: it answers connectInfo and nothing else.
const hostServer: EffectServerTransport<HostServices> = {
  handle(channel, fn, opts) {
    loopbackRegistrar.handle(channel, fn);
    // The link's gate reads each call's own annotations
    // (host/socket/server.ts, CommandGate).
    if (opts?.remote === true) linkRegistrar.handle(channel, fn);
  },
  broadcastAll(channel, payload, opts) {
    // The loopback serves every one off the host's pushes, and the
    // device link the remote ones.
    PubSub.publishUnsafe(pushes, {
      channel,
      payload,
      remote: opts?.remote === true,
    });
  },
};

function assertHostSide(module: ContractModule): void {
  if (!isHostSide(module)) {
    throw new Error(`${nameOf(module)} is the shell's, not the host's`);
  }
}

export function registerContract<M extends ContractModule>(
  module: M,
  handlers: EffectHandlers<M, HandlerContext, HostServices>,
): void {
  assertHostSide(module);
  registerHostContract(module, handlers, hostServer, {
    // Handler results are parsed with their output schema in a dev
    // build, so drift surfaces here and not as a confusing failure in a
    // window. A packaged build skips the extra parse.
    validateOutputs: !hostFacts().packaged,
    // Actions that opt in via `tracksProjectUsage` rank their project
    // for the sidebar's usage sorts, which reorder live on this push.
    onUsageTracked: (parsedInput) => {
      void Graph.run(recordProjectActionUsage(parsedInput)).then(
        (bumpedProjectId) => {
          if (bumpedProjectId) {
            broadcastAll(projectsContract, "usageBumped", {
              projectId: bumpedProjectId,
            });
          }
        },
        () => {},
      );
    },
  });
}

type View = (input: unknown) => Stream.Stream<unknown, unknown, HostServices>;

// A module's views (contract.ts, view), served on the device link to
// the peers its annotations admit, and on the loopback.
export function registerViews<M extends ContractModule>(
  module: M,
  views: ViewHandlers<M, HostServices>,
): void {
  for (const [key, view] of Object.entries(views)) {
    const channel = `${nameOf(module)}:${key}`;
    linkRegistrar.view(channel, view as View);
    loopbackRegistrar.view(channel, view as View);
  }
}

// A contract on the loopback alone (the control contract, and the
// shell's session with its host): its calls, and its streams.
export function registerLoopbackContract<M extends ContractModule>(
  module: M,
  handlers: EffectHandlers<M, HandlerContext, HostServices>,
  streams: Readonly<Record<string, View>> = {},
): void {
  registerHostContract(
    module,
    handlers,
    {
      handle: (channel, fn) => loopbackRegistrar.handle(channel, fn),
      broadcastAll: () => {},
    },
    { validateOutputs: !hostFacts().packaged },
  );
  for (const [key, stream] of Object.entries(streams)) {
    loopbackRegistrar.view(`${nameOf(module)}:${key}`, stream);
  }
}

// A push from the host: to every window and process on the loopback,
// and, when annotated `remote`, to the device link's peers. A push of a
// shell module annotated `remote` is the host's to send its peers too
// (account:commandAccessChanged, as the switch the shell reported).
export function broadcastAll<
  M extends ContractModule,
  K extends BroadcastKeys<M>,
>(module: M, key: K, payload: BroadcastProducerPayload<M, K>): void {
  broadcastAllCore(module, key, payload, hostServer);
}

// Reconciles the hub socket with the account. Runs at start and after
// every account change, so the socket follows the credential. The
// account read runs inside the binding's serialized lifecycle, so an
// overlapping refresh can never apply a stale read last, and a failure
// is a log line: a connect problem must never fail the account change
// that triggered it.
export async function refreshHubConnection(): Promise<void> {
  await logFailure("[hub] connection refresh failed", () =>
    hubServer.refresh(async () => {
      const inputs = hubConnectInputs();
      if (inputs === null) return null;
      return {
        hubUrl: inputs.hubUrl,
        // A different account rotates the credential, so accountId is
        // in the opts to force a reconnect onto the new account's object
        // instead of leaving the old socket live.
        accountId: inputs.accountId,
        deviceKey: inputs.deviceKey,
        mintTicket: inputs.mintTicket,
        deviceId: getDeviceId(),
      };
    }),
  );
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

// Closes the hub socket at quit, so the Durable Object sees a clean
// departure instead of waiting out a dead connection.
export function stopHubConnection(): Promise<void> {
  return hubServer.stop();
}

// The wake-time liveness probe for the hub socket and every direct
// session: a socket that died while the machine slept gets its verdict
// within the probe window and redials at once.
export function probeRemoteConnections(): void {
  hubServer.probe();
  directPlane().probe();
}

// Quit's teardown beside stopHubConnection: closes the outbound links,
// or each remote host would keep a dead socket in its per-device slot
// and land the next start on the supersede path instead of a clean
// reconnect. The listener closes with its layer.
export function stopDirectHost(): void {
  directPlane().stop();
}

// Reconciles the listener with the account and the device's config: run
// from refreshHubConnection's tail and on every global-config change,
// so the directConnections opt-out applies without a restart. The
// config read runs inside the binding's serialized lifecycle. Dual-stack
// ("::") because connectInfo advertises IPv6 candidates too, on an
// ephemeral port read back from status. accountId rides the opts as an
// identity field, so an account switch restarts the listener and drops
// every socket authed under the old account.
export async function refreshDirectHost(): Promise<void> {
  await logFailure("[direct] listener refresh failed", () =>
    Graph.run(
      onLink((link) =>
        link.reconcile(
          Effect.promise(async () => {
            const inputs = hubConnectInputs();
            if (inputs === null) return null;
            // The device-scoped opt-out: absent means enrolled, explicit
            // false stops the listener.
            const config = await Graph.run(Ops.readGlobalConfig());
            if (config.directConnections === false) return null;
            return {
              port: 0,
              bindAddress: "::",
              deviceId: getDeviceId(),
              appVersion: hostFacts().appVersion,
              accountId: inputs.accountId,
              // The web client's origin, so a browser can dial the wss tunnel
              // candidate.
              allowedOrigin: allowedWebOrigin(),
            };
          }),
        ),
      ),
    ),
  );
  // The tunnel follows the listener: a running listener wants a tunnel
  // fronting its current port, and every condition that stopped the
  // listener stops the child through the same reconcile. A tunnel
  // problem must not fail the change that triggered the refresh.
  await logFailure("[tunnel] reconcile failed", () => {
    const listener = linkStatus();
    const wanted =
      listener.listening && listener.port !== null
        ? { port: listener.port }
        : null;
    // Nothing to reconcile once the app is quitting: the layer's close
    // has stopped the child.
    return Graph.run(onTunnel((tunnel) => tunnel.reconcile(wanted))).catch(
      () => undefined,
    );
  });
}
