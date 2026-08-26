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
import { projectsContract } from "@shared/ipc/modules/projects";
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
import { createWsServerBinding } from "@host/socket/server";

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

// Host-scoped calls are served on both wires. Client-scoped calls stay
// structurally unreachable over the socket: their channels are never
// registered on the ws binding, so a remote req gets a no-handler res
// instead of a native dialog or an app-menu mutation.
const hostServer: ServerTransport = {
  // The Electron wire always serves host calls. The socket wire serves
  // a call ONLY when its def opted into remote exposure, so a
  // host-scoped-but-not-remote channel (runtime:nuke, cli:*,
  // launchers:launch, globalConfig:write) is never even registered on
  // the socket. A remote req for it gets the same no-handler res a
  // client-scoped channel does.
  handle(channel, fn, opts) {
    electronServer.handle(channel, fn);
    if (opts?.remote === true) wsServer.handle(channel, fn);
  },
  broadcastAll(channel, payload, opts) {
    electronServer.broadcastAll(channel, payload);
    if (opts?.remote === true) wsServer.broadcastAll(channel, payload);
  },
};

const serverFor = (module: ContractModule): ServerTransport =>
  module.scope === "host" ? hostServer : electronServer;

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
      ensureSocketHostToken();
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
