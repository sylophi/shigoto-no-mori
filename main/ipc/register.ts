import { ipcMain, type WebContents } from "electron";
import type { Contract } from "@shared/ipc/contract";
import type { BroadcastProducerPayload, Handlers } from "@shared/ipc/types";

export function registerContract<C extends Contract>(
  contract: C,
  handlers: Handlers<C>,
): void {
  for (const key of Object.keys(contract) as (keyof C & string)[]) {
    const def = contract[key];
    if (def.kind !== "invoke") continue;
    const handler = (handlers as Record<string, (i: unknown) => unknown>)[key];
    ipcMain.handle(def.channel, async (_event, raw) => {
      const input = def.input.parse(raw);
      return handler(input);
    });
  }
}

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
  // Parse at source: a producer bug surfaces here rather than as a
  // confusing shape mismatch in the renderer. Symmetric with input
  // parsing at the registrar boundary for invoke calls.
  webContents.send(def.channel, def.payload.parse(payload));
}
