// This module owns the only sanctioned calls to `webContents.send` in
// main/. Anything else that needs to push to the renderer should go
// through `broadcast` / `broadcastAll` below so the payload runs through
// the contract's payload schema before it crosses the bridge.
import {
  app,
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import type { Contract } from "@shared/ipc/contract";
import { projectsContract } from "@shared/ipc/modules/projects";
import type { BroadcastProducerPayload, Handlers } from "@shared/ipc/types";
import { recordProjectActionUsage } from "../lib/projects/usage";

export type HandlerContext = { event: IpcMainInvokeEvent };

// In dev we re-run handler results through the contract's output schema
// so handler drift (or schemas with .transform / .default / .coerce that
// turn z.input into something subtly different from z.output) surfaces
// here instead of as a confusing failure in the renderer. Packaged builds
// skip the extra parse to keep IPC latency at the per-handler return cost.
const VALIDATE_OUTPUTS = !app.isPackaged;

export function registerContract<C extends Contract>(
  contract: C,
  handlers: Handlers<C, HandlerContext>,
): void {
  for (const key of Object.keys(contract) as (keyof C & string)[]) {
    const def = contract[key];
    if (def.kind !== "invoke") continue;
    const handler = (
      handlers as unknown as Record<
        string,
        (i: unknown, ctx: HandlerContext) => unknown
      >
    )[key];
    ipcMain.handle(def.channel, async (event, raw) => {
      const input = def.input.parse(raw);
      const result = await handler(input, { event });
      // A successful project-scoped action ranks that project for the
      // sidebar "most used" / "most recently used" sorts. Reads are excluded.
      // Tell renderers so a usage-sorted sidebar reorders live.
      const bumpedProjectId = recordProjectActionUsage(def.channel, input);
      if (bumpedProjectId) {
        broadcastAll(projectsContract, "usageBumped", {
          projectId: bumpedProjectId,
        });
      }
      return VALIDATE_OUTPUTS ? def.output.parse(result) : result;
    });
  }
}

// Parse at source: a producer bug surfaces here rather than as a
// confusing shape mismatch in the renderer. Symmetric with input
// parsing at the registrar boundary for invoke calls.
export function broadcast<C extends Contract, K extends keyof C>(
  contract: C,
  key: K,
  payload: BroadcastProducerPayload<C, K>,
  webContents: WebContents,
): void {
  const def = contract[key];
  if (def.kind !== "broadcast") {
    throw new Error(`broadcast called on non-broadcast key: ${String(key)}`);
  }
  webContents.send(def.channel, def.payload.parse(payload));
}

// Fan-out broadcast: parses the payload once, then ships it to every
// open window. Used for state every window cares about (updater,
// background refreshes); single-window broadcasts go through `broadcast`.
export function broadcastAll<C extends Contract, K extends keyof C>(
  contract: C,
  key: K,
  payload: BroadcastProducerPayload<C, K>,
): void {
  const def = contract[key];
  if (def.kind !== "broadcast") {
    throw new Error(`broadcastAll called on non-broadcast key: ${String(key)}`);
  }
  const parsed = def.payload.parse(payload);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.isDestroyed()) continue;
    win.webContents.send(def.channel, parsed);
  }
}
