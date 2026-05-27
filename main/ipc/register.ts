import {
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import type { Contract } from "@shared/ipc/contract";
import type { BroadcastProducerPayload, Handlers } from "@shared/ipc/types";

export type HandlerContext = { event: IpcMainInvokeEvent };

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
      return handler(input, { event });
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
