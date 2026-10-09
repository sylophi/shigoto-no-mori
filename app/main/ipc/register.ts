// Transport wiring for the shared contract registrar: the Electron
// binding, the direct listener (host/socket/server.ts), and the
// scope routing that decides which modules ride which wires. This
// module owns the only sanctioned calls to `webContents.send` in
// main/. Anything else that needs to push to the renderer should go
// through `broadcast` / `broadcastAll` below so the payload runs
// through the contract's payload schema before it crosses the bridge.
import { bundledBinaryPath } from "../electron/bundledBinary";
import { devDialKinds } from "../electron/devDialKinds";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, type WebContents } from "electron";
import { WebSocket as WsWebSocket } from "ws";
import {
  type ContractModule,
  nameOf,
  scopeOf,
} from "@shigomori/contracts/contract";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import { hubContract } from "@shigomori/contracts/modules/hub";
import type { HubPeerPush } from "@shigomori/contracts/modules/hub";
import {
  broadcastAll as broadcastAllCore,
  registerContract as registerContractCore,
  resolveBroadcast,
} from "@shared/ipc/registerContract";
import {
  type HandlerContext,
  type ServerTransport,
  settle,
} from "@shared/ipc/transport";
import type {
  BroadcastKeys,
  BroadcastProducerPayload,
  Handlers,
  ViewHandlers,
} from "@shigomori/contracts/types";
import type * as Stream from "effect/Stream";
import type * as Views from "@host/lib/views";
import {
  CLOUDFLARED_BINARY_NAME,
  CLOUDFLARED_DIST_DIR,
} from "@shared/packaging/cloudflaredDist.mts";
import { getDeviceId } from "@host/lib/config/deviceId";
import { readGlobalConfig } from "@host/lib/config/global";
import { recordProjectActionUsage } from "@host/lib/projects/usage";
import * as TunnelService from "@host/direct/cloudflared";
import { createConnectTicketStore } from "@host/direct/tickets";
import { createHubConnection } from "@host/hub/connection";
import * as DeviceLink from "@host/socket/server";
import { mirrorInviteAdmits } from "@host/mirror/invites";
import { dataDir } from "@host/lib/util/paths";
import * as Loopback from "@host/socket/loopback";
import { makeConnectInfo } from "@host/direct/connectInfo";
import { publishPush } from "@host/lib/hostPushes";
import { createDirectPlane } from "@shared/hub/directPlane";
import {
  acceptsPeerCommands,
  allowedWebOrigin,
  provisionDeviceTunnel,
  hubConnectInputs,
} from "./modules/account";
import { log, logFailure } from "@shared/log";

// Gates OUTPUT validation only. Input parsing in the shared registrar
// is unconditional in every build. In dev we re-run handler results
// through the contract's output schema so handler drift (or schemas
// with transforms or defaults whose encoded shape differs subtly from
// the decoded one) surfaces here instead of as a
// confusing failure in the renderer. Packaged builds skip the extra
// parse to keep IPC latency at the per-handler return cost.
const VALIDATE_OUTPUTS = !app.isPackaged;

// One context per page generation, not per WebContents. A WebContents
// survives reload, so caching on it alone would carry the old page's
// signal and notifiers into the new document and accumulate listeners
// across reloads. Rotation aborts the old controller and drops the
// entry, so the next call from the new page mints a fresh generation.
const generations = new WeakMap<
  WebContents,
  { controller: AbortController; ctx: HandlerContext }
>();

// Senders whose lifecycle listeners are already attached. The listeners
// are per WebContents rather than per generation, so they must attach
// exactly once at first sighting.
const watched = new WeakSet<WebContents>();

function rotate(sender: WebContents): void {
  const generation = generations.get(sender);
  if (!generation) return;
  generation.controller.abort();
  generations.delete(sender);
}

function contextFor(sender: WebContents): HandlerContext {
  const cached = generations.get(sender);
  if (cached) return cached.ctx;
  if (!watched.has(sender)) {
    watched.add(sender);
    // 'did-navigate' fires only on cross-document main-frame
    // navigation, which is what reload is. Same-document changes fire
    // 'did-navigate-in-page' instead and must not abort in-flight work.
    sender.on("did-navigate", () => rotate(sender));
    sender.once("destroyed", () => rotate(sender));
  }
  const controller = new AbortController();
  const ctx: HandlerContext = {
    signal: controller.signal,
    connection: controller.signal,
    notifier: (module, key) => (payload) => {
      if (sender.isDestroyed()) return;
      broadcast(module, key, payload, sender);
    },
  };
  generations.set(sender, { controller, ctx });
  return ctx;
}

const electronServer: ServerTransport = {
  handle(channel, fn) {
    ipcMain.handle(channel, (event, raw) =>
      settle(
        fn(contextFor(event.sender), raw).catch((error: unknown) => {
          // What Electron logged for a rejected handler before the
          // failure became a settled value.
          log.error(`Error occurred in handler for '${channel}':`, error);
          throw error;
        }),
      ),
    );
  },
  // Payloads arrive already parsed from the shared fan-out path.
  broadcastAll(channel, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.isDestroyed()) continue;
      win.webContents.send(channel, payload);
    }
  },
};

// The device link's listener (host/socket/server.ts). Its hello
// consumes the single-use connect tickets connectInfo mints over the
// device hub, and its gate runs every call not annotated gated:false
// only under the host's live command switch (acceptsPeerCommands:
// every ticketed peer is a device of this account, so the switch is
// the whole verdict). That gate is the only enforcement; everything
// else that shows the switch is a reading of it. The registrar records
// the handlers at boot, while listening follows enrollment in
// refreshDirectHost below.
const directTickets = createConnectTicketStore();
const linkRegistrar = DeviceLink.createLinkRegistrar();
export const deviceLinkLayer = DeviceLink.adapter.pipe(
  Layer.provideMerge(
    DeviceLink.layer({
      registrar: linkRegistrar,
      auth: {
        matchTicket: (deviceId, arrivedAs, matches) =>
          directTickets.consumeProven(deviceId, arrivedAs, matches),
        isCommandGranted: acceptsPeerCommands,
        // The switch's one exception: the mirrors this device asked for.
        isInvited: mirrorInviteAdmits,
      },
    }),
  ),
);
const directLink = DeviceLink.deviceLink;

// The tunnel endpoint: a supervised cloudflared child fronting the
// direct listener's loopback port through this device's named
// Cloudflare tunnel. Reconciled from refreshDirectHost so it follows
// the listener exactly (a new ephemeral port re-provisions, a stopped
// listener stops the child), and sign-out, an account switch and
// directConnections off land here as reconcile(null) through the same
// path. The connector token stays inside the Tunnel, never here.
export const tunnelLayer = TunnelService.adapter.pipe(
  Layer.provideMerge(
    TunnelService.layer({
      // Resolved fresh per start attempt: the probe is one bounded
      // spawn, already rate-limited by the restart ladder and the
      // reconcile no-op rules, and any memo here would leave the
      // install-cloudflared recovery path (any config write re-probes)
      // dead for the PATH case.
      resolveBinary: Effect.promise(readGlobalConfig).pipe(
        Effect.flatMap((config) =>
          // The connector the app ships
          // (shared/packaging/cloudflaredDist.mts, fetched by `pnpm
          // start` in dev).
          TunnelService.resolveCloudflaredBinary(
            config.cloudflaredPath,
            bundledBinaryPath(CLOUDFLARED_DIST_DIR, CLOUDFLARED_BINARY_NAME),
          ),
        ),
      ),
      provision: (port) =>
        Effect.tryPromise({
          try: () => provisionDeviceTunnel(port),
          catch: (cause) => new TunnelService.TunnelProvisionError({ cause }),
        }),
      // Orphan-reap bookkeeping: the live child's pid, recorded so a
      // crashed Electron's leftover connector is killed on the next
      // launch. A getter because userData is an app-ready fact.
      pidFilePath: () => join(app.getPath("userData"), "cloudflared.pid"),
      // Tunnel state rides the same status snapshot the device hub and
      // direct transitions feed, so the account page updates live.
      onChange: () => directPlane.notifyStatusChanged(),
    }),
  ),
);

// The device link again, on loopback, for the processes on this
// machine (host/socket/loopback.ts): the terminal's control ops, and
// every host call beside them. Its registrar records the handlers at
// boot; it listens from the host's start.
const loopbackRegistrar = DeviceLink.createLinkRegistrar();
export const loopbackLayer = Loopback.adapter.pipe(
  Layer.provideMerge(
    Loopback.layer({
      registrar: loopbackRegistrar,
      deviceId: () => getDeviceId(),
      appVersion: app.getVersion(),
      file: () => join(dataDir(), Loopback.LOOPBACK_FILE),
    }),
  ),
);

// Main-side consumers of peer pushes (the mirror's git follower reacts
// to a peer's git:projectChanged and mirror:gitChanged), beside the
// renderer fan-out. Returns the unsubscribe.
type PeerPushListener = (push: HubPeerPush) => void;
const peerPushListeners = new Set<PeerPushListener>();

export function onPeerPush(listener: PeerPushListener): () => void {
  peerPushListeners.add(listener);
  return () => {
    peerPushListeners.delete(listener);
  };
}

// The direct plane's shared composition (shared/hub/directPlane.ts):
// the dialer, the renderer-facing bridge handlers, the status snapshot
// and the presence reconcile, assembled identically for the web bridge.
// This side supplies the Electron facts and the host half: the direct
// listener's roster close and the tunnel runner's state.
const directPlane = createDirectPlane({
  connection: () => hubServer,
  localDeviceId: () => getDeviceId(),
  localAppVersion: () => app.getVersion(),
  broadcastStatus: (status) =>
    broadcastAll(hubContract, "statusChanged", status),
  broadcastPeerPush: (push) => {
    broadcastAll(hubContract, "peerPush", push);
    for (const listener of peerPushListeners) listener(push);
  },
  // The candidate sockets ride the `ws` package so a failed dial names
  // its errno (see OpenClientSocket in shared/remote/deviceLink.ts).
  // Neither ws nor Node's global sends an Origin header, so the peer's
  // upgrade gate reads the two identically. Deflate only through the
  // tunnel: a LAN link outruns it.
  openSocket: (url) =>
    new WsWebSocket(url, { perMessageDeflate: url.startsWith("wss:") }),
  dialableKinds: devDialKinds(),
  host: {
    closeHostPeersNotIn: (online) => void directLink.closePeersNotIn(online),
    tunnelState: () => TunnelService.tunnel.state(),
  },
});

// The renderer-facing hub bridge, exported so index.ts can register
// it on the contract and lend its invokePeer to the peer transports.
export const hubHandlers = directPlane.handlers;

// The answer to a peer's connectInfo ask (host/direct/connectInfo.ts),
// the one question the device hub carries, built from deps this module
// owns: the listener's port, the ticket store and the tunnel runner,
// plus the switch the listener's gate reads, reported to the asker.
const serveConnectInfo = makeConnectInfo({
  listenerPort: () => {
    const current = directLink.status();
    return current.listening ? current.port : null;
  },
  mintTickets: (peerDeviceId, kinds) => directTickets.mint(peerDeviceId, kinds),
  // The tunnel candidate, advertised only while
  // the cloudflared child is currently healthy (probed routable).
  tunnelUrl: () => TunnelService.tunnel.tunnelUrl(),
  acceptsCommands: acceptsPeerCommands,
});

// The hub connection, unconditional like the listener bindings:
// connecting itself is gated in refreshHubConnection below (signed out
// or unconfigured means no socket). Its onChange hands status
// transitions to the direct plane, which fans a fresh snapshot out to
// every window through the client-scoped hub contract and reconciles
// direct-session presence on each transition. Peer pushes arrive over
// direct sessions only (the dialer's onAnyPush inside the plane), never
// over the device hub.
const hubServer = createHubConnection({
  serveConnectInfo,
  onChange: () => directPlane.handleConnectionChange(),
});

// Host-scoped calls are served on every wire that may carry them.
// Client-scoped calls stay structurally unreachable over the remote
// wires: their channels are never registered on any remote binding,
// so a remote req gets a no-handler res instead of a native dialog or
// an app-menu mutation.
const hostServer: ServerTransport = {
  // The Electron wire always serves host calls. The direct listener,
  // the one remote wire, serves a call ONLY when it opted into
  // remote exposure, so a host-scoped-but-not-remote channel
  // (runtime:nuke, launchers:launch) is never even registered on it. A
  // remote req for it gets the same no-handler res a client-scoped
  // channel does. The device hub is deliberately NOT a wire here: it
  // answers connectInfo and nothing else (serveConnectInfo above), and
  // host broadcasts and viewer pings reach remote peers over their
  // direct sessions alone.
  handle(channel, fn, opts) {
    electronServer.handle(channel, fn);
    loopbackRegistrar.handle(channel, fn);
    // The link's gate reads each call's own annotations
    // (host/socket/server.ts, CommandGate).
    if (opts?.remote === true) linkRegistrar.handle(channel, fn);
  },
  broadcastAll(channel, payload, opts) {
    electronServer.broadcastAll(channel, payload);
    // The device link serves the remote ones off the host's pushes.
    publishPush({ channel, payload, remote: opts?.remote === true });
  },
};

const serverFor = (module: ContractModule): ServerTransport =>
  scopeOf(module) === "host" ? hostServer : electronServer;

export function registerContract<M extends ContractModule>(
  module: M,
  handlers: Handlers<M, HandlerContext>,
): void {
  registerContractCore(module, handlers, serverFor(module), {
    validateOutputs: VALIDATE_OUTPUTS,
    // Actions that opt in via `tracksProjectUsage` rank their project for
    // the sidebar "most used" / "most recently used" sorts. Tell renderers
    // so a usage-sorted sidebar reorders live.
    onUsageTracked: (parsedInput) => {
      void recordProjectActionUsage(parsedInput).then((bumpedProjectId) => {
        if (bumpedProjectId) {
          broadcastAll(projectsContract, "usageBumped", {
            projectId: bumpedProjectId,
          });
        }
      });
    },
  });
}

type View = (input: unknown) => Stream.Stream<unknown, unknown, Views.Services>;

// A module's views (contract.ts, view), served on the device link to
// the peers its annotations admit, and on the loopback.
export function registerViews<M extends ContractModule>(
  module: M,
  views: ViewHandlers<M, Views.Services>,
): void {
  for (const [key, view] of Object.entries(views)) {
    const channel = `${nameOf(module)}:${key}`;
    linkRegistrar.view(channel, view as View);
    loopbackRegistrar.view(channel, view as View);
  }
}

// The control contract, on the loopback alone: its ops as calls, and
// its transfers as the streams of their progress and answer.
export function registerControlContract<M extends ContractModule>(
  module: M,
  handlers: Handlers<M, HandlerContext>,
  transfers: Readonly<Record<string, View>>,
): void {
  registerContractCore(
    module,
    handlers,
    {
      handle: (channel, fn) => loopbackRegistrar.handle(channel, fn),
      broadcastAll: () => {},
    },
    { validateOutputs: VALIDATE_OUTPUTS },
  );
  for (const [key, transfer] of Object.entries(transfers)) {
    loopbackRegistrar.view(`${nameOf(module)}:${key}`, transfer);
  }
}

// Single-window broadcast for client-scoped window and menu events. A
// specific window is an Electron concept, so this stays in the binding
// rather than on the transport seam.
export function broadcast<M extends ContractModule, K extends BroadcastKeys<M>>(
  module: M,
  key: K,
  payload: BroadcastProducerPayload<M, K>,
  webContents: WebContents,
): void {
  const { channel, parsed } = resolveBroadcast(module, key, payload);
  webContents.send(channel, parsed);
}

// Fan-out broadcast for state every window cares about (updater,
// background refreshes). Every broadcast reaches every window, and one
// tagged remote reaches every authenticated direct peer too. That tag
// is the whole rule, whatever the module's scope: host-scoped fan-outs
// (git refresh, script events, updater state) carry it where a peer
// caches the state, and a client-scoped one carries it only when it is
// this host's answer to its peers (account:commandAccessChanged). The
// rest of the client-scoped ones (port forwards, account changes) are
// about THIS install and stay on the Electron wire.
export function broadcastAll<
  M extends ContractModule,
  K extends BroadcastKeys<M>,
>(module: M, key: K, payload: BroadcastProducerPayload<M, K>): void {
  broadcastAllCore(module, key, payload, hostServer);
}

// Reconciles the hub socket with the account state. Runs at boot and
// after every account change (sign-in, sign-out, rename), so the
// socket follows the credential without a relaunch. The account read
// runs INSIDE the binding's serialized lifecycle, so an overlapping
// refresh can never apply a stale read last, and a failure degrades to
// a log line because a connect problem must never fail the account
// write that triggered it.
export async function refreshHubConnection(): Promise<void> {
  await logFailure("[hub] connection refresh failed", () =>
    hubServer.refresh(async () => {
      const inputs = hubConnectInputs();
      if (inputs === null) return null;
      return {
        hubUrl: inputs.hubUrl,
        // A DIFFERENT account rotates the credential, so accountId is in
        // HubConnectOpts/sameOpts to force a reconnect onto the new
        // account's DO instead of leaving the old socket live (C7).
        accountId: inputs.accountId,
        mintTicket: inputs.mintTicket,
        deviceId: getDeviceId(),
      };
    }),
  );
  // The direct listener follows the same enrollment condition (it
  // reads hubConnectInputs too), so it reconciles on exactly the
  // hub's cadence: boot and every account change. Folded here so
  // call sites cannot forget one half.
  await refreshDirectHost();
}

// Tickets are account-scoped where the listener is not: the account
// change restarts the listener (dropping every authed socket), and
// this drops what could still auth one. Called from the account
// fan-out's teardown (main/ipc/handlers.ts leaveAccount).
export function clearDirectTickets(): void {
  directTickets.clear();
}

// Closes the hub socket at quit, so the DO sees a clean departure
// instead of waiting out a dead connection.
export function stopHubConnection(): Promise<void> {
  return hubServer.stop();
}

// The wake-time liveness probe for both remote planes (the hub socket
// and every established direct session), wired to the power monitor's
// resume in main/index.ts. A socket that died while the machine slept
// gets its verdict within the probe window and redials at once,
// instead of reading as connected until the next heartbeat tick or,
// without heartbeats, until the OS gave up on the dead flow.
export function probeRemoteConnections(): void {
  hubServer.probe();
  directPlane.probe();
}

// Quit's teardown, alongside stopHubConnection: closes the outbound
// links, or each remote host would keep a dead socket in its
// per-device slot and land our relaunch on the supersede path instead
// of a clean reconnect. The plane's own stop() latches the keeper
// first. The listener closes with its layer (deviceLinkLayer).
export function stopDirectHost(): void {
  directPlane.stop();
}

// Reconciles the direct data-plane listener with the account and
// device state: run from refreshHubConnection's tail (enrollment is
// exactly the device hub's condition: a device with no hub peers has
// nobody to serve directly) and on every global-config change (the
// hostImpls subscriber), so the directConnections opt-out applies
// without a relaunch. The config read runs INSIDE the binding's
// serialized lifecycle (the resolver below), so an overlapping refresh
// can never apply a stale read last. Dual-stack bind ("::", both families accept)
// because connectInfo advertises IPv6 candidates too, on an ephemeral
// port read back from status. accountId rides the opts as an identity
// field, so an account switch restarts the listener and drops every
// socket authed under the old account. A failure degrades to a log
// line like the other refresh functions.
export async function refreshDirectHost(): Promise<void> {
  await logFailure("[direct] listener refresh failed", () =>
    directLink.refresh(async () => {
      const inputs = hubConnectInputs();
      if (inputs === null) return null;
      // The device-scoped opt-out: absent means enrolled, explicit
      // false stops the listener (peers then get available:false, so
      // this device serves no peers).
      const config = await readGlobalConfig();
      if (config.directConnections === false) return null;
      return {
        port: 0,
        bindAddress: "::",
        deviceId: getDeviceId(),
        // appVersion is an Electron fact, injected here so host/socket
        // never imports electron.
        appVersion: app.getVersion(),
        accountId: inputs.accountId,
        // Admit the configured web client origin so a browser can dial
        // the wss tunnel candidate. Undefined means no extra origin.
        allowedOrigin: allowedWebOrigin(),
      };
    }),
  );
  // The tunnel follows the listener: a running
  // listener wants a tunnel fronting its CURRENT ephemeral port (the
  // runner no-ops when nothing changed and re-provisions when the port
  // did), and every condition that stopped the listener stops the
  // child through the same reconcile. Serialized inside the runner.
  // The runner classifies its own failures onto retry-or-park rails,
  // and the belt here keeps this function's never-throws contract even
  // if that classification ever leaks: a tunnel problem must not fail
  // the config write or account change that triggered the refresh.
  await logFailure("[tunnel] reconcile failed", () => {
    const listener = directLink.status();
    return TunnelService.tunnel.reconcile(
      listener.listening && listener.port !== null
        ? { port: listener.port }
        : null,
    );
  });
}
