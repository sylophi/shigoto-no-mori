// Electron binding of the renderer's transport. Runs in the preload,
// the only context where ipcRenderer is reachable. This file is the
// app's single ipcRenderer consumer. Everything above it speaks the
// envelope, so remoteness stays a transport concern.
//
// invoke resolves an InvokeEnvelope rather than rejecting: a value
// crossing contextBridge is copied, and a thrown Error is copied as
// message and stack only, which would drop the tag and fields a typed
// error carries. The renderer (renderer/electronApi.ts) unwraps the
// envelope into a real WireError on its side of the bridge.
import { ipcRenderer } from "electron";
import type { InvokeEnvelope } from "@shared/ipc/wireError";

// ipcMain.handle resolves the envelope itself, so a rejection here is
// Electron's own (no handler registered for the channel, a payload
// that failed to clone). ipcRenderer.invoke wraps it as "Error
// invoking remote method '<channel>': Error: <message>"; the wrapper
// is minted here and nowhere else, so it is removed here and nowhere
// else. The second group is the error's class name, whatever it is.
const INVOKE_WRAPPER = /^Error invoking remote method '[^']*': (?:\w+: )?/;

export type ElectronBridgeTransport = {
  invoke(channel: string, input: unknown): Promise<InvokeEnvelope>;
  subscribe(channel: string, handler: (payload: unknown) => void): () => void;
};

export const electronBridgeTransport: ElectronBridgeTransport = {
  invoke: (channel, input) =>
    ipcRenderer.invoke(channel, input).then(
      (envelope: InvokeEnvelope) => envelope,
      (error: unknown): InvokeEnvelope => ({
        ok: false,
        message:
          error instanceof Error
            ? error.message.replace(INVOKE_WRAPPER, "")
            : String(error),
      }),
    ),
  subscribe: (channel, handler) => {
    const listener = (_e: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },
};
