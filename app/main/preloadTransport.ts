// Electron binding of the renderer's wire. Runs in the preload, the
// only context where ipcRenderer is reachable. This file is the app's
// single ipcRenderer consumer. An invoke resolves to its Settled
// outcome (main/ipc/register.ts settles every handler), since the IPC
// and the context bridge both keep only an error's message, and the
// renderer turns it back into a value or an error (renderer/electronApi.ts).
import { ipcRenderer } from "electron";
import type { Settled } from "@shared/ipc/transport";

// ipcRenderer.invoke rejects only when no handler answers the channel,
// wrapped as "Error invoking remote method '<channel>': Error:
// <message>". The wrapper is minted here and nowhere else, so it is
// removed here and nowhere else.
// The second group is the error's class name, whatever it is called.
const INVOKE_WRAPPER = /^Error invoking remote method '[^']*': (?:\w+: )?/;

export const electronBridgeTransport = {
  invoke: (channel: string, input: unknown): Promise<Settled> =>
    ipcRenderer.invoke(channel, input).catch((error: unknown) => {
      if (error instanceof Error) {
        throw new Error(error.message.replace(INVOKE_WRAPPER, ""));
      }
      throw error;
    }),
  subscribe: (
    channel: string,
    handler: (payload: unknown) => void,
  ): (() => void) => {
    const listener = (_e: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },
};
