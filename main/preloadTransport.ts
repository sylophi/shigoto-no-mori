// Electron binding of ClientTransport. Runs in the preload, the only
// context where ipcRenderer is reachable. This file is the app's single
// ipcRenderer consumer. Everything above it speaks ClientTransport, so
// remoteness stays a transport concern.
import { ipcRenderer } from "electron";
import type { ClientTransport } from "@shared/ipc/transport";

export const electronClientTransport: ClientTransport = {
  invoke: (channel, input) => ipcRenderer.invoke(channel, input),
  subscribe: (channel, handler) => {
    const listener = (_e: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },
};
