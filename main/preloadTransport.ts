// Electron binding of ClientTransport. Runs in the preload, the only
// context where ipcRenderer is reachable. This file is the app's single
// ipcRenderer consumer. Everything above it speaks ClientTransport, so
// remoteness stays a transport concern.
import { ipcRenderer } from "electron";
import type { ClientTransport } from "@shared/ipc/transport";

// ipcRenderer.invoke wraps a main-process rejection as "Error invoking
// remote method '<channel>': Error: <message>". The wrapper is minted
// here and nowhere else, so it is removed here and nowhere else: what
// crosses into the renderer is the handler's own message, the same
// text the websocket transport delivers, and no layer above this one
// has to know the Electron wire exists.
// The second group is the error's class name, whatever it is called.
const INVOKE_WRAPPER = /^Error invoking remote method '[^']*': (?:\w+: )?/;

export const electronClientTransport: ClientTransport = {
  invoke: (channel, input) =>
    ipcRenderer.invoke(channel, input).catch((error: unknown) => {
      if (error instanceof Error) {
        throw new Error(error.message.replace(INVOKE_WRAPPER, ""));
      }
      throw error;
    }),
  subscribe: (channel, handler) => {
    const listener = (_e: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },
};
