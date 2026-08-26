// Transport wiring for the shared contract registrar: the Electron
// binding, the websocket binding (host/socket/server.ts), and the
// scope routing that decides which modules ride which wires. This
// module owns the only sanctioned calls to `webContents.send` in
// main/. Anything else that needs to push to the renderer should go
// through `broadcast` / `broadcastAll` below so the payload runs
// through the contract's payload schema before it crosses the bridge.
import { app, BrowserWindow, ipcMain, type WebContents } from "electron";
import { errorMessageOf } from "@shared/errors";
import type { ContractModule } from "@shared/ipc/contract";
import { gitContract } from "@shared/ipc/modules/git";
import { projectsContract } from "@shared/ipc/modules/projects";
import { relayContract, type RelayStatus } from "@shared/ipc/modules/relay";
import type { ConnectPeerOpts, PeerConnection } from "@shared/relay/link";
import {
  broadcastAll as broadcastAllCore,
  registerContract as registerContractCore,
  resolveBroadcast,
} from "@shared/ipc/registerContract";
import type { HandlerContext, ServerTransport } from "@shared/ipc/transport";
import type {
  BroadcastKeys,
  BroadcastProducerPayload,
  Handlers,
} from "@shared/ipc/types";
import { getDeviceId } from "@host/lib/config/deviceId";
import {
  ensureSocketHostToken,
  readGlobalConfig,
  resolveSocketHostConfig,
} from "@host/lib/config/global";
import { recordProjectActionUsage } from "@host/lib/projects/usage";
import { createRelayConnection } from "@host/relay/connection";
import { createWsServerBinding } from "@host/socket/server";
import { isPeerCommandGranted, relayConnectInputs } from "./modules/account";

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
    ipcMain.handle(channel, (event, raw) => fn(contextFor(event.sender), raw));
  },
  // Payloads arrive already parsed from the shared fan-out path.
  broadcastAll(channel, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.isDestroyed()) continue;
      win.webContents.send(channel, payload);
    }
  },
};

// The websocket binding exists unconditionally so registration can
// record handlers whether or not the device config ever enables the
// listener. Listening itself is gated in refreshSocketHost below.
const wsServer = createWsServerBinding();

// The relay connection, unconditional for the same reason: handler
// registration is recorded at boot, connecting itself is gated in
// refreshRelayConnection below (signed out or unconfigured means no
// socket). Its callbacks fan status and peer pushes out to every
// window through the client-scoped relay contract.
const relayServer = createRelayConnection({
  onChange: () => {
    broadcastAll(relayContract, "statusChanged", relayStatus());
  },
  onPeerPush: (deviceId, channel, payload) => {
    broadcastAll(relayContract, "peerPush", { deviceId, channel, payload });
  },
  // The relay link refuses a peer's mutating call unless this host has
  // granted it command access. Read live from the account layer's grant
  // cache so a grant or revoke applies without a relay reconnect.
  isCommandGranted: isPeerCommandGranted,
});

// The two remote wires (LAN socket and relay), looped wherever a
// channel or broadcast must reach both so a third wire lands in one
// place.
const remoteWires: readonly ServerTransport[] = [wsServer, relayServer.server];

// Host-scoped calls are served on every wire that may carry them.
// Client-scoped calls stay structurally unreachable over the socket
// and the relay: their channels are never registered on either remote
// binding, so a remote req gets a no-handler res instead of a native
// dialog or an app-menu mutation.
const hostServer: ServerTransport = {
  // The Electron wire always serves host calls. The remote wires (LAN
  // socket and relay) serve a call ONLY when its def opted into remote
  // exposure, so a host-scoped-but-not-remote channel (runtime:nuke,
  // cli:*, launchers:launch, globalConfig:write) is never even
  // registered on them. A remote req for it gets the same no-handler
  // res a client-scoped channel does.
  handle(channel, fn, opts) {
    electronServer.handle(channel, fn);
    if (opts?.remote === true) {
      // Both remote wires receive the mutating flag. The relay binding
      // gates a mutating channel on a per-peer command grant. The LAN
      // binding has no grant model at all, so it enforces read-only at
      // dispatch, fail-closed: only channels explicitly registered
      // mutating:false are served over the LAN socket, and everything
      // else (mutating, or untagged) is refused with the shared
      // command-refused code before its handler runs
      // (host/socket/server.ts).
      for (const wire of remoteWires) {
        wire.handle(channel, fn, { mutating: opts.mutating });
      }
    }
  },
  broadcastAll(channel, payload, opts) {
    electronServer.broadcastAll(channel, payload);
    if (opts?.remote === true) {
      for (const wire of remoteWires) wire.broadcastAll(channel, payload);
    }
  },
};

const serverFor = (module: ContractModule): ServerTransport =>
  module.scope === "host" ? hostServer : electronServer;

// App-driven host mutations never reach remote viewers through the fs
// watcher: its self-write suppression exists precisely so the app's own
// writes don't echo (stateWatcher.ts). So after any mutating host
// invoke resolves (whichever wire carried it, this window's own
// Electron calls included), ping the REMOTE wires with the existing
// git:externalChange broadcast, the same signal a truly external write
// produces. Deliberately not the Electron wire: the acting local
// renderer is already fresh via its mutation's targeted invalidation
// and must not start paying a broad invalidation for every one of its
// own writes. Known asymmetry: when the acting client is a REMOTE
// peer, this window is neither the actor nor pinged, so the local view
// of a peer-driven change waits for focus refetch. A trailing coalesce
// folds a burst of mutations into one ping without re-arming, so a
// steady stream still pings at a bounded rate. If the watcher fires
// for the same change anyway, viewer-side invalidation is idempotent,
// so the overlap is harmless.
const MUTATION_PING_MS = 300;
let mutationPingTimer: NodeJS.Timeout | null = null;
function pingRemoteViewers(): void {
  if (mutationPingTimer !== null) return;
  mutationPingTimer = setTimeout(() => {
    mutationPingTimer = null;
    // resolveBroadcast runs the (void) payload through the contract
    // schema, exactly like the composite broadcastAll path.
    // externalChange is remote:true by contract, and must stay that
    // way: this path pushes to the remote wires unconditionally.
    const { channel, parsed } = resolveBroadcast(
      gitContract,
      "externalChange",
      undefined,
    );
    for (const wire of remoteWires) wire.broadcastAll(channel, parsed);
  }, MUTATION_PING_MS);
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
    // Only host-scoped modules can move host state a remote viewer
    // caches. Client-scoped defs never tag mutating anyway, so this
    // gate is belt and braces.
    onMutationResolved: module.scope === "host" ? pingRemoteViewers : undefined,
  });
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
// fan-outs (git refresh, script events, nuke progress) reach every
// window AND every authenticated socket peer, while client-scoped ones
// (updater state) stay on the Electron wire -- an update prompt is
// about THIS install, not the host a remote client is looking at.
export function broadcastAll<
  M extends ContractModule,
  K extends BroadcastKeys<M>,
>(module: M, key: K, payload: BroadcastProducerPayload<M, K>): void {
  broadcastAllCore(module, key, payload, serverFor(module));
}

// Reconciles the websocket listener with the device config. Runs at
// boot (the ready handler) and on every config change (the host-side
// onGlobalConfigChange subscriber, wired in installHostImpls), so
// toggling the setting through the app, the CLI or a nuke needs no
// relaunch. The config read runs INSIDE the binding's serialized
// lifecycle (the resolver below), so a token rotation can never be
// reverted by an overlapping refresh applying a stale read last.
// Never throws -- a bind failure must not fail the write that requested
// it, so it degrades to a log line (the binding also records status).
export async function refreshSocketHost(): Promise<void> {
  try {
    await wsServer.refresh(async () => {
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

// The relay bridge's status snapshot, shared by the status handler and
// the statusChanged fan-out so both always report the same shape.
export function relayStatus(): RelayStatus {
  const current = relayServer.status();
  return {
    socket: current.socket,
    onlineDeviceIds: current.onlineDeviceIds,
    // Folded into the snapshot so the renderer stops polling peerInfo per
    // device on every reconcile (M3).
    peerAppVersions: current.peerAppVersions,
  };
}

// The relay's client role, exposed for the bridge handlers so they
// never hold the binding itself.
export function relayConnectPeer(
  deviceId: string,
  opts?: ConnectPeerOpts,
): Promise<PeerConnection> {
  return relayServer.connectPeer(deviceId, opts);
}

// Reconciles the relay socket with the account state. Runs at boot and
// after every account change (sign-in, sign-out, rename), so the
// socket follows the credential without a relaunch. The account read
// runs INSIDE the binding's serialized lifecycle, mirroring
// refreshSocketHost, and a failure degrades to a log line because a
// connect problem must never fail the account write that triggered it.
export async function refreshRelayConnection(): Promise<void> {
  try {
    await relayServer.refresh(async () => {
      const inputs = relayConnectInputs();
      if (inputs === null) return null;
      return {
        relayUrl: inputs.relayUrl,
        // A DIFFERENT account rotates the credential, so accountId is in
        // RelayConnectOpts/sameOpts to force a reconnect onto the new
        // account's DO instead of leaving the old socket live (C7).
        accountId: inputs.accountId,
        mintTicket: inputs.mintTicket,
        deviceId: getDeviceId(),
        // appVersion is an Electron fact, injected here so host/relay
        // never imports electron.
        appVersion: app.getVersion(),
      };
    });
  } catch (error) {
    console.warn(`[relay] connection refresh failed: ${errorMessageOf(error)}`);
  }
}

// Teardown for before-quit: closes the relay socket so the DO sees a
// clean departure instead of waiting out a dead connection.
export function stopRelayConnection(): Promise<void> {
  return relayServer.stop();
}
