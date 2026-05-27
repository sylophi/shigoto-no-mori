import { ipcRenderer } from "electron";
import type { Contract } from "@shared/ipc/contract";
import type { Client } from "@shared/ipc/types";

export function buildClient<C extends Contract>(contract: C): Client<C> {
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(contract)) {
    if (def.kind === "invoke") {
      out[key] = (input: unknown) => ipcRenderer.invoke(def.channel, input);
    } else {
      out[key] = (handler: (p: unknown) => void) => {
        const listener = (_e: unknown, payload: unknown) => handler(payload);
        ipcRenderer.on(def.channel, listener);
        return () => ipcRenderer.off(def.channel, listener);
      };
    }
  }
  return out as Client<C>;
}
