// Electron binding of the shared contract registrar. This module owns
// the only sanctioned calls to `webContents.send` in main/. Anything
// else that needs to push to the renderer should go through `broadcast`
// / `broadcastAll` below so the payload runs through the contract's
// payload schema before it crosses the bridge.
import { app, BrowserWindow, ipcMain, type WebContents } from "electron";
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
import { recordProjectActionUsage } from "@host/lib/projects/usage";

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

export function registerContract<M extends ContractModule>(
  module: M,
  handlers: Handlers<M, HandlerContext>,
): void {
  registerContractCore(module, handlers, electronServer, {
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
// background refreshes). Rides the shared transport seam so host-scoped
// broadcasts keep flowing when the host side moves behind a socket.
// This wrapper only pins the Electron server transport for the existing
// call sites.
export function broadcastAll<
  M extends ContractModule,
  K extends BroadcastKeys<M>,
>(module: M, key: K, payload: BroadcastProducerPayload<M, K>): void {
  broadcastAllCore(module, key, payload, electronServer);
}
