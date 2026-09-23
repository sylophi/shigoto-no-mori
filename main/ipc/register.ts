// Transport wiring for the shared contract registrar: the Electron
// binding, the websocket binding (host/socket/server.ts), and the
// scope routing that decides which modules ride which wires. This
// module owns the only sanctioned calls to `webContents.send` in
// main/. Anything else that needs to push to the renderer should go
// through `broadcast` / `broadcastAll` below so the payload runs
// through the contract's payload schema before it crosses the bridge.
import { bundledBinaryPath } from "../electron/bundledBinary";
import { devDialKinds } from "../electron/devDialKinds";
import { coalesce } from "@host/lib/util/coalesce";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, type WebContents } from "electron";
import { Context, Effect, Fiber, Layer, PubSub, Stream } from "effect";
import { WebSocket as WsWebSocket } from "ws";
import { errorMessageOf } from "@shared/errors";
import type { ContractModule } from "@shared/ipc/contract";
import { gitContract } from "@shared/ipc/modules/git";
import { projectsContract } from "@shared/ipc/modules/projects";
import { hubContract } from "@shared/ipc/modules/hub";
import type { HubPeerPush } from "@shared/ipc/modules/hub";
import {
  broadcastAll as broadcastAllCore,
  registerContract as registerContractCore,
  resolveBroadcast,
} from "@shared/ipc/registerContract";
import {
  type HandlerContext,
  isRemoteCaller,
  type ServerTransport,
} from "@shared/ipc/transport";
import type {
  BroadcastKeys,
  BroadcastProducerPayload,
  Handlers,
} from "@shared/ipc/types";
import {
  CLOUDFLARED_BINARY_NAME,
  CLOUDFLARED_DIST_DIR,
} from "@shared/packaging/cloudflaredDist.mts";
import { getDeviceId } from "@host/lib/config/deviceId";
import {
  ensureSocketHostToken,
  readGlobalConfig,
  resolveSocketHostConfig,
} from "@host/lib/config/global";
import { recordProjectActionUsage } from "@host/lib/projects/usage";
import {
  createCloudflaredRunner,
  resolveCloudflaredBinary,
} from "@host/direct/cloudflared";
import {
  type ConnectTicketStore,
  createConnectTicketStore,
} from "@host/direct/tickets";
import {
  createHubConnection,
  type HubConnectionBinding,
} from "@host/hub/connection";
import {
  createWsServerBinding,
  type WsServerBinding,
} from "@host/socket/server";
import { dataDir } from "@host/lib/util/paths";
import { CONTROL_FILE_NAME, createControlServer } from "../core/control/server";
import { directContract } from "@shared/ipc/modules/direct";
import { brokerHandlerFor, makeDirectHandlers } from "@host/ipc/modules/direct";
import { createDirectPlane } from "@shared/hub/directPlane";
import {
  acceptsPeerCommands,
  allowedWebOrigin,
  provisionDeviceTunnel,
  hubConnectInputs,
} from "./modules/account";
import { settleEnvelope } from "@shared/ipc/wireError";
import { appRuntime, appService, runner } from "../services";

// Gates OUTPUT validation only. Input parsing in the shared registrar
// is unconditional in every build. In dev we re-run handler results
// through the contract's output schema so handler drift (or schemas
// with .transform / .default / .coerce that turn z.input into something
// subtly different from z.output) surfaces here instead of as a
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
    // A local window always commands its own machine, so the preflight
    // read answers granted:true over the Electron wire.
    isCallerCommandGranted: () => true,
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
    // Resolves an envelope rather than rejecting, so a typed error's
    // tag and fields reach the renderer (shared/ipc/wireError.ts). The
    // warn keeps the line Electron used to print for a rejected
    // handler, so a failure still shows in the main process log.
    ipcMain.handle(channel, (event, raw) =>
      settleEnvelope(() =>
        fn(contextFor(event.sender), raw).catch((error: unknown) => {
          console.warn(`[ipc] ${channel} failed: ${errorMessageOf(error)}`);
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

// The runners this module wires, each a service on the app runtime
// (main/runtime.ts composes their layers into AppLive). Every one is
// acquired by its factory when the runtime is built and released by
// its stop when the runtime is disposed on quit, in reverse
// acquisition order, which is the order the dependencies below give.

// The websocket binding exists unconditionally so registration can
// record handlers whether or not the device config ever enables the
// listener. Listening itself is gated in refreshSocketHost below.
export class SocketHost extends Context.Service<SocketHost, WsServerBinding>()(
  "sm/main/SocketHost",
) {
  static readonly layer = Layer.effect(
    SocketHost,
    runner(
      "the LAN listener",
      () => createWsServerBinding(),
      (binding) => binding.stop(),
    ),
  );
}

// The direct data plane: a SECOND ws listener
// instance in ticket mode. Auth consumes single-use connect tickets
// minted by direct:connectInfo over the device hub, and dispatch gates
// mutating channels on the host's live command-access switch
// (acceptsPeerCommands: every ticketed peer is a device of this
// account, so the switch is the whole verdict). Unconditional like the
// other bindings so
// registration records handlers at boot, while listening is gated on
// enrollment in refreshDirectHost below.
export class DirectListener extends Context.Service<
  DirectListener,
  { server: WsServerBinding; tickets: ConnectTicketStore }
>()("sm/main/DirectListener") {
  static readonly layer = Layer.effect(
    DirectListener,
    Effect.gen(function* () {
      const tickets = createConnectTicketStore();
      const server = yield* runner(
        "the direct listener",
        () =>
          createWsServerBinding({
            matchTicket: (deviceId, arrivedAs, matches) =>
              tickets.consumeProven(deviceId, arrivedAs, matches),
            isCommandGranted: acceptsPeerCommands,
          }),
        (binding) => binding.stop(),
      );
      return { server, tickets };
    }),
  );
}

// The control wire: the loopback listener the CLI drives the
// cross-device verbs through (main/core/control/server.ts). A wire of
// its own, outside hostServer's fan: it serves the control contract
// and nothing else, so no app channel is reachable from a terminal
// unless that contract names an op for it.
export class ControlServer extends Context.Service<
  ControlServer,
  ReturnType<typeof createControlServer>
>()("sm/main/ControlServer") {
  static readonly layer = Layer.effect(
    ControlServer,
    runner(
      "the control listener",
      () =>
        createControlServer({
          appVersion: () => app.getVersion(),
          filePath: () => join(dataDir(), CONTROL_FILE_NAME),
        }),
      // Synchronous, and the file goes first: a CLI run that starts
      // during the quit reads "not running" instead of dialing a
      // closing listener.
      (server) => server.stop(),
    ),
  );
}

// Main-side consumers of peer pushes (the mirror's git follower reacts
// to a peer's git:projectChanged and mirror:gitChanged), beside the
// renderer fan-out. onPeerPush below subscribes.
type PeerPushListener = (push: HubPeerPush) => void;
export class PeerPushes extends Context.Service<
  PeerPushes,
  PubSub.PubSub<HubPeerPush>
>()("sm/main/PeerPushes") {
  static readonly layer = Layer.effect(
    PeerPushes,
    Effect.acquireRelease(PubSub.unbounded<HubPeerPush>(), PubSub.shutdown),
  );
}

// A subscriber fiber on the app runtime, handing each item to a plain
// callback. A throw from the callback is contained and logged: a defect
// in a forked fiber is reported nowhere, and it would end the
// subscription for good. Returns the unsubscribe.
function follow<A>(
  pubsub: PubSub.PubSub<A>,
  what: string,
  listener: (item: A) => void,
): () => void {
  const fiber = appRuntime().runFork(
    Stream.fromPubSub(pubsub).pipe(
      Stream.runForEach((item) =>
        Effect.sync(() => {
          try {
            listener(item);
          } catch (error) {
            console.warn(
              `[ipc] a ${what} listener threw: ${errorMessageOf(error)}`,
            );
          }
        }),
      ),
    ),
  );
  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
}

export function onPeerPush(listener: PeerPushListener): () => void {
  return follow(appService(PeerPushes), "peer push", listener);
}

// The hub connection, the direct plane and the tunnel runner, which
// reference one another: the plane reads the connection's status and
// roster, the connection hands every transition to the plane, and the
// tunnel's state changes fan the plane's snapshot out. So the three
// are built in ONE layer effect, through the lazy getters the
// factories already take (the closures below read bindings that exist
// by the time any of them fires), rather than as layers a
// Layer.provide could order. Acquired tunnel, hub, plane, so on quit
// the plane stops first, the hub socket closes after it, and the
// tunnel goes before the direct listener it fronts (whose layer this
// one depends on). The direct broker is built here too, since every
// dep it reads is one of these.
export class HubConnection extends Context.Service<
  HubConnection,
  HubConnectionBinding
>()("sm/main/HubConnection") {}

export class DirectPlane extends Context.Service<
  DirectPlane,
  ReturnType<typeof createDirectPlane>
>()("sm/main/DirectPlane") {}

export class TunnelRunner extends Context.Service<
  TunnelRunner,
  ReturnType<typeof createCloudflaredRunner>
>()("sm/main/TunnelRunner") {}

export class DirectBroker extends Context.Service<
  DirectBroker,
  ReturnType<typeof makeDirectHandlers>
>()("sm/main/DirectBroker") {}

export const RemotePlaneLive = Layer.effectContext(
  Effect.gen(function* () {
    const { server: directWsServer, tickets: directTickets } =
      yield* DirectListener;
    const peerPushes = yield* PeerPushes;

    // The tunnel endpoint: a supervised cloudflared
    // child fronting the direct listener's loopback port through this
    // device's named Cloudflare tunnel. Reconciled from refreshDirectHost
    // so it follows the listener exactly (a new ephemeral port
    // re-provisions, a stopped listener stops the child), and sign-out, an
    // account switch and directConnections off land here as
    // reconcile(null) through the same path. Quit alone calls stop() (the
    // runner's terminal latch, this layer's finalizer when main/index.ts
    // disposes the runtime). The connector token stays inside the runner,
    // never here.
    const tunnelRunner = yield* runner(
      "the tunnel",
      () =>
        createCloudflaredRunner({
          // Resolved fresh per start attempt: the probe is one bounded
          // execFile, already rate-limited by the runner's ladder and its
          // reconcile no-op rules, and any memo here would leave the
          // install-cloudflared recovery path (any config write re-probes)
          // dead for the PATH case.
          resolveBinary: async () => {
            const config = await readGlobalConfig();
            // The connector the app ships (shared/packaging/cloudflaredDist.mts,
            // fetched by `pnpm start` in dev).
            return resolveCloudflaredBinary(
              config.cloudflaredPath,
              bundledBinaryPath(CLOUDFLARED_DIST_DIR, CLOUDFLARED_BINARY_NAME),
            );
          },
          provision: (port) => provisionDeviceTunnel(port),
          // Orphan-reap bookkeeping: the live child's pid, recorded so a
          // crashed Electron's leftover connector is killed on the next
          // launch. A getter because userData is an app-ready fact.
          pidFilePath: () => join(app.getPath("userData"), "cloudflared.pid"),
          // Tunnel state rides the same status snapshot the device hub and
          // direct transitions feed, so the devices page updates live.
          onChange: () => directPlane.notifyStatusChanged(),
        }),
      (tunnel) => tunnel.stop(),
    );

    // The hub connection, unconditional like the listener bindings:
    // handler registration is recorded at boot, connecting itself is gated
    // in refreshHubConnection below (signed out or unconfigured means no
    // socket). Its onChange hands status transitions to the direct plane,
    // which fans a fresh snapshot out to every window through the
    // client-scoped hub contract and reconciles direct-session presence
    // on each transition. Peer pushes arrive over direct sessions only
    // (the dialer's onAnyPush inside the plane), never over the device hub.
    // Its stop closes the socket so the DO sees a clean departure
    // instead of waiting out a dead connection.
    const hubServer = yield* runner(
      "the hub connection",
      () =>
        createHubConnection({
          // The one channel the wire brokers, named at creation so the client
          // role can dial before the handler pair below is registered.
          brokerChannel: directContract.calls.connectInfo.channel,
          onChange: () => directPlane.handleConnectionChange(),
        }),
      (hub) => hub.stop(),
    );

    // The direct plane's shared composition (shared/hub/directPlane.ts):
    // the dialer, the renderer-facing bridge handlers, the status snapshot
    // and the presence reconcile, assembled identically for the web bridge.
    // This side supplies the Electron facts and the host half: the direct
    // listener's roster close and the tunnel runner's state. Its stop
    // closes the cached outbound direct sessions (the keeper's latch
    // first, then the sessions, in the order that matters), or each
    // remote host would keep a dead socket in its per-device slot and
    // land our relaunch on the supersede path instead of a clean
    // reconnect.
    const directPlane = yield* runner(
      "the direct plane",
      () =>
        createDirectPlane({
          connection: () => hubServer,
          localDeviceId: () => getDeviceId(),
          localAppVersion: () => app.getVersion(),
          broadcastStatus: (status) =>
            broadcastAll(hubContract, "statusChanged", status),
          broadcastPeerPush: (push) => {
            broadcastAll(hubContract, "peerPush", push);
            PubSub.publishUnsafe(peerPushes, push);
          },
          // The candidate sockets ride the `ws` package so a failed dial names
          // its errno (see ClientSocket in wsClientTransport.ts). Neither ws
          // nor Node's global sends an Origin header, so the peer's upgrade
          // gate reads the two identically.
          openSocket: (url) =>
            new WsWebSocket(url, { perMessageDeflate: false }),
          dialableKinds: devDialKinds(),
          host: {
            closeHostPeersNotIn: (online) =>
              directWsServer.closePeersNotIn(online),
            tunnelState: () => tunnelRunner.status().state,
          },
        }),
      (plane) => plane.stop(),
    );

    // The direct broker (direct:connectInfo), constructed here like the
    // direct plane above because every dep is one of this layer's:
    // main/ipc/handlers.ts only registers it on the contract. The roster
    // predicate is what stops a peer that fell off the control plane
    // (revoked, account switch) from re-minting tickets over its own
    // still-open direct socket.
    const directBroker = makeDirectHandlers({
      listenerPort: () => {
        const current = directWsServer.status();
        return current.listening ? current.port : null;
      },
      mintTickets: (peerDeviceId, kinds) =>
        directTickets.mint(peerDeviceId, kinds),
      isPeerOnline: (peerDeviceId) =>
        hubServer.status().onlineDeviceIds.includes(peerDeviceId),
      // The tunnel candidate, advertised only while
      // the cloudflared child is currently healthy (probed routable).
      tunnelUrl: () => tunnelRunner.tunnelUrl(),
    });

    // The broker surface on the HUB wire: the binding exposes ONE slot
    // (not a ServerTransport), so direct:connectInfo is the only channel
    // it can ever serve and mounting anything else is a type error.
    // brokerHandlerFor supplies the channel-plus-handler pair, built on
    // the shared registrar's own per-call wrapper so the brokered path
    // serves the same dispatch policy as every other wire. The handler
    // registration still puts the same handlers on the Electron and
    // remote wires, where connectInfo fails closed without an
    // authenticated caller.
    hubServer.registerBroker(
      brokerHandlerFor(directBroker, { validateOutputs: VALIDATE_OUTPUTS }),
    );

    return Context.make(HubConnection, hubServer).pipe(
      Context.add(DirectPlane, directPlane),
      Context.add(TunnelRunner, tunnelRunner),
      Context.add(DirectBroker, directBroker),
    );
  }),
);

// The renderer-facing hub bridge, for the contract registration in
// main/ipc/handlers.ts, which also lends its invokePeer to the peer
// transports.
export function hubHandlers(): ReturnType<
  typeof createDirectPlane
>["handlers"] {
  return appService(DirectPlane).handlers;
}

// The remote wires (LAN socket, direct listener), looped wherever a
// channel or broadcast must reach them all so a new wire lands in one
// place. The device hub is deliberately NOT here:
// it is orchestration only, its wire serves nothing but the broker
// surface registered above, and host broadcasts and viewer pings reach
// remote peers over their direct sessions alone.
const remoteWires = (): readonly ServerTransport[] => [
  appService(SocketHost),
  appService(DirectListener).server,
];

// Host-scoped calls are served on every wire that may carry them.
// Client-scoped calls stay structurally unreachable over the remote
// wires: their channels are never registered on any remote binding,
// so a remote req gets a no-handler res instead of a native dialog or
// an app-menu mutation.
const hostServer: ServerTransport = {
  // The Electron wire always serves host calls. The remote wires (LAN
  // socket and direct listener) serve a call ONLY when its def opted
  // into remote exposure, so a host-scoped-but-not-remote channel
  // (runtime:nuke, launchers:launch, globalConfig:write) is
  // never even registered on them. A remote req for it gets the same
  // no-handler res a client-scoped channel does.
  handle(channel, fn, opts) {
    electronServer.handle(channel, fn);
    if (opts?.remote === true) {
      // Both remote wires receive the mutating flag. The direct
      // listener gates a mutating channel on a per-peer command grant.
      // The LAN binding has no grant model at all, so it enforces
      // read-only at dispatch, fail-closed: only channels explicitly
      // registered mutating:false are served over the LAN socket, and
      // everything else (mutating, or untagged) is refused with the
      // shared command-refused code before its handler runs
      // (host/socket/server.ts).
      for (const wire of remoteWires()) {
        wire.handle(channel, fn, { mutating: opts.mutating });
      }
    }
  },
  broadcastAll(channel, payload, opts) {
    electronServer.broadcastAll(channel, payload);
    if (opts?.remote === true) {
      for (const wire of remoteWires()) wire.broadcastAll(channel, payload);
    }
  },
};

const serverFor = (module: ContractModule): ServerTransport =>
  module.scope === "host" ? hostServer : electronServer;

// App-driven host mutations never reach viewers through the fs
// watcher: its self-write suppression exists precisely so the app's own
// writes don't echo (stateWatcher.ts). So after any mutating host
// invoke resolves (whichever wire carried it), ping the REMOTE wires
// with the existing git:externalChange broadcast, the same signal a
// truly external write produces. The Electron wire is pinged only when
// the acting client was a REMOTE peer: the acting local renderer is
// already fresh via its mutation's targeted invalidation and must not
// start paying a broad invalidation for every one of its own writes,
// while a change a peer drove is external to this window exactly like
// a CLI write, and would otherwise sit unseen until a focus refetch.
// A trailing coalesce
// folds a burst of mutations into one ping per wire set without
// re-arming, so a steady stream still pings at a bounded rate. If the
// watcher fires for the same change anyway, viewer-side invalidation
// is idempotent, so the overlap is harmless.
const MUTATION_PING_MS = 300;
let mutationPingLocal = false;
// Followers of "a host mutation settled", on the same coalesced
// cadence as the ping: the git-directory watcher tracks the project
// registry through this, because an app-side project add or remove
// runs as a CLI child whose registry write the state watcher drops as
// the app's own.
export class MutationsSettled extends Context.Service<
  MutationsSettled,
  PubSub.PubSub<void>
>()("sm/main/MutationsSettled") {
  static readonly layer = Layer.effect(
    MutationsSettled,
    Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown),
  );
}
export function onHostMutationSettled(listener: () => void): void {
  follow(appService(MutationsSettled), "mutation-settled", listener);
}
const flushMutationPing = coalesce(() => {
  const pingLocal = mutationPingLocal;
  mutationPingLocal = false;
  // resolveBroadcast runs the (void) payload through the contract
  // schema, exactly like the composite broadcastAll path.
  // externalChange is remote:true by contract, and must stay that
  // way: this path pushes to the remote wires unconditionally.
  const { channel, parsed } = resolveBroadcast(
    gitContract,
    "externalChange",
    undefined,
  );
  for (const wire of remoteWires()) wire.broadcastAll(channel, parsed);
  if (pingLocal) electronServer.broadcastAll(channel, parsed);
  PubSub.publishUnsafe(appService(MutationsSettled), undefined);
}, MUTATION_PING_MS);
function pingViewers(ctx: HandlerContext): void {
  if (isRemoteCaller(ctx)) mutationPingLocal = true;
  flushMutationPing();
}

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
      const bumpedProjectId = recordProjectActionUsage(parsedInput);
      if (bumpedProjectId) {
        broadcastAll(projectsContract, "usageBumped", {
          projectId: bumpedProjectId,
        });
      }
    },
    // Only host-scoped modules can move host state a viewer caches.
    // Client-scoped defs never tag mutating anyway, so this gate is
    // belt and braces.
    onMutationResolved: module.scope === "host" ? pingViewers : undefined,
  });
}

// The control contract's registration, on the control wire alone. A
// mutation the CLI drove is external to every window here, exactly
// like one a peer drove (and its CLI children mute the state watcher
// the same way), so it pings the local windows along with the remote
// viewers.
export function registerControlContract<M extends ContractModule>(
  module: M,
  handlers: Handlers<M, HandlerContext>,
): void {
  registerContractCore(module, handlers, appService(ControlServer).transport, {
    validateOutputs: VALIDATE_OUTPUTS,
    onMutationResolved: () => {
      mutationPingLocal = true;
      flushMutationPing();
    },
  });
}

// Binds the control listener and publishes it in the data dir. Never
// throws: the app works without the CLI's cross-device verbs, which
// then report the app as unreachable.
export async function startControlHost(): Promise<void> {
  try {
    await appService(ControlServer).start();
  } catch (error) {
    console.warn(
      `[control] listener failed to start: ${errorMessageOf(error)}`,
    );
  }
}

// Synchronous: unpublishes first, so a CLI run that starts meanwhile
// reads "not running" instead of dialing a closing listener. The quit
// path gets the same stop from the control server's layer finalizer;
// this is for a data-dir move, whose control.json must not carry this
// process's address into the new folder.
export function stopControlHost(): void {
  appService(ControlServer).stop();
}

// After a data wipe took control.json along with the data dir.
export function republishControlHost(): void {
  appService(ControlServer).republish();
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
// background refreshes). Scope picks the wire set: host-scoped
// fan-outs (git refresh, script events, nuke progress, updater state)
// reach every window AND every authenticated socket peer, while
// client-scoped ones (port forwards, account changes) stay on the
// Electron wire -- they are about THIS install, not the host a remote
// client is looking at.
export function broadcastAll<
  M extends ContractModule,
  K extends BroadcastKeys<M>,
>(module: M, key: K, payload: BroadcastProducerPayload<M, K>): void {
  broadcastAllCore(module, key, payload, serverFor(module));
}

// Reconciles the websocket listener with the device config. Runs at
// boot (the ready handler) and on every config change (the host-side
// onGlobalConfigChange subscriber, wired in HostImplsLive), so
// toggling the setting through the app, the CLI or a nuke needs no
// relaunch. The config read runs INSIDE the binding's serialized
// lifecycle (the resolver below), so a token rotation can never be
// reverted by an overlapping refresh applying a stale read last.
// Never throws -- a bind failure must not fail the write that requested
// it, so it degrades to a log line (the binding also records status).
export async function refreshSocketHost(): Promise<void> {
  try {
    await appService(SocketHost).refresh(async () => {
      // Secure by default at enable time: generate and persist a token
      // if hosting is on without one. ensureSocketHostToken drops the
      // module cache itself, so the read below sees the fresh document.
      // Awaited because the mint serializes on the global-config write
      // lock, and the read below must see the post-mint document.
      await ensureSocketHostToken();
      const config = await readGlobalConfig();
      const resolved = resolveSocketHostConfig(config);
      if (resolved === null) return null;
      return {
        port: resolved.port,
        bindAddress: resolved.bindAddress,
        token: resolved.token,
        deviceId: getDeviceId(),
        // appVersion is an Electron fact, injected here so host/socket
        // never imports electron.
        appVersion: app.getVersion(),
      };
    });
  } catch (error) {
    console.warn(`[socket] listener refresh failed: ${errorMessageOf(error)}`);
  }
}

// Reconciles the hub socket with the account state. Runs at boot and
// after every account change (sign-in, sign-out, rename), so the
// socket follows the credential without a relaunch. The account read
// runs INSIDE the binding's serialized lifecycle, mirroring
// refreshSocketHost, and a failure degrades to a log line because a
// connect problem must never fail the account write that triggered it.
export async function refreshHubConnection(): Promise<void> {
  try {
    await appService(HubConnection).refresh(async () => {
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
        // appVersion is an Electron fact, injected here so host/hub
        // never imports electron.
        appVersion: app.getVersion(),
      };
    });
  } catch (error) {
    console.warn(`[hub] connection refresh failed: ${errorMessageOf(error)}`);
  }
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
  appService(DirectListener).tickets.clear();
}

// Closes the hub socket so the DO sees a clean departure instead of
// waiting out a dead connection. The quit path gets this from the
// remote plane layer's finalizer.
export function stopHubConnection(): Promise<void> {
  return appService(HubConnection).stop();
}

// The wake-time liveness probe for both remote planes (the hub socket
// and every established direct session), wired to the power monitor's
// resume in main/index.ts. A socket that died while the machine slept
// gets its verdict within the probe window and redials at once,
// instead of reading as connected until the next heartbeat tick or,
// without heartbeats, until the OS gave up on the dead flow.
export function probeRemoteConnections(): void {
  appService(HubConnection).probe();
  appService(DirectPlane).probe();
}

// Teardown alongside stopHubConnection: closes the direct listener so
// connected peers see a clean going-away instead of a dead socket, AND
// the cached outbound direct sessions, or each remote host would keep
// a dead socket in its per-device slot and land our relaunch on the
// supersede path instead of a clean reconnect. The plane's own stop()
// owns both halves of that (the keeper's latch and the session close,
// in the order that matters). The quit path gets the same stops, in
// the same order, from the layers' finalizers.
export function stopDirectHost(): Promise<void> {
  appService(DirectPlane).stop();
  // The cloudflared child stops with the listener it fronts, so quit
  // never leaves an orphan tunnel process behind.
  return Promise.all([
    appService(TunnelRunner).stop(),
    appService(DirectListener).server.stop(),
  ]).then(() => undefined);
}

// Reconciles the direct data-plane listener with the account and
// device state: run from refreshHubConnection's tail (enrollment is
// exactly the device hub's condition: a device with no hub peers has
// nobody to serve directly) and on every global-config change (the
// hostImpls subscriber), so the directConnections opt-out applies
// without a relaunch. Dual-stack bind ("::", both families accept)
// because connectInfo advertises IPv6 candidates too, on an ephemeral
// port read back from status. accountId rides the opts as an identity
// field, so an account switch restarts the listener and drops every
// socket authed under the old account. A failure degrades to a log
// line like the other refresh functions.
export async function refreshDirectHost(): Promise<void> {
  try {
    const directWsServer = appService(DirectListener).server;
    await directWsServer.refresh(async () => {
      const inputs = hubConnectInputs();
      if (inputs === null) return null;
      // The device-scoped opt-out: absent means enrolled, explicit
      // false stops the listener (peers then get available:false and
      // stay on the device hub).
      const config = await readGlobalConfig();
      if (config.directConnections === false) return null;
      return {
        port: 0,
        bindAddress: "::",
        // Ticket mode has no static token, the injected verifier is
        // the auth.
        token: "",
        deviceId: getDeviceId(),
        appVersion: app.getVersion(),
        accountId: inputs.accountId,
        // Admit the configured web client origin so a browser can dial the wss tunnel candidate.
        // Undefined means no extra origin, the slice A behavior.
        allowedOrigin: allowedWebOrigin(),
      };
    });
  } catch (error) {
    console.warn(`[direct] listener refresh failed: ${errorMessageOf(error)}`);
  }
  // The tunnel follows the listener: a running
  // listener wants a tunnel fronting its CURRENT ephemeral port (the
  // runner no-ops when nothing changed and re-provisions when the port
  // did), and every condition that stopped the listener stops the
  // child through the same reconcile. Serialized inside the runner.
  // The runner classifies its own failures onto retry-or-park rails,
  // and the belt here keeps this function's never-throws contract even
  // if that classification ever leaks: a tunnel problem must not fail
  // the config write or account change that triggered the refresh.
  try {
    const listener = appService(DirectListener).server.status();
    await appService(TunnelRunner).reconcile(
      listener.listening && listener.port !== null
        ? { port: listener.port }
        : null,
    );
  } catch (error) {
    console.warn(`[tunnel] reconcile failed: ${errorMessageOf(error)}`);
  }
}

// The direct broker (direct:connectInfo), built with the remote plane
// above, for the contract registration in main/ipc/handlers.ts.
export function directHandlers(): ReturnType<typeof makeDirectHandlers> {
  return appService(DirectBroker);
}
