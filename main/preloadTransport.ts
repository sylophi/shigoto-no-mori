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
//
// Both functions take a channel name, so they are gated to the
// contract channels: the renderer can reach exactly the invokes and
// broadcasts buildApi would have exposed as methods, and nothing else
// that happens to ride ipcRenderer.
import { ipcRenderer } from "electron";
import { allContractModules } from "@shared/ipc/client";
import type { InvokeEnvelope } from "@shared/ipc/wireError";

// ipcMain.handle resolves the envelope itself, so a rejection here is
// Electron's own (no handler registered for the channel, a payload
// that failed to clone). ipcRenderer.invoke wraps it as "Error
// invoking remote method '<channel>': Error: <message>"; the wrapper
// is minted here and nowhere else, so it is removed here and nowhere
// else. The second group is the error's class name, whatever it is.
const INVOKE_WRAPPER = /^Error invoking remote method '[^']*': (?:\w+: )?/;

const invokeChannels = new Set<string>();
const broadcastChannels = new Set<string>();
for (const module of allContractModules) {
  for (const def of Object.values(module.calls)) {
    (def.kind === "invoke" ? invokeChannels : broadcastChannels).add(
      def.channel,
    );
  }
}

export type ElectronBridgeTransport = {
  invoke(channel: string, input: unknown): Promise<InvokeEnvelope>;
  subscribe(channel: string, handler: (payload: unknown) => void): () => void;
};

export const electronBridgeTransport: ElectronBridgeTransport = {
  invoke: (channel, input) => {
    if (!invokeChannels.has(channel)) {
      return Promise.resolve({
        ok: false,
        message: `No handler registered for channel "${channel}"`,
      });
    }
    return ipcRenderer.invoke(channel, input).then(
      (envelope: InvokeEnvelope) => envelope,
      (error: unknown): InvokeEnvelope => ({
        ok: false,
        message:
          error instanceof Error
            ? error.message.replace(INVOKE_WRAPPER, "")
            : String(error),
      }),
    );
  },
  subscribe: (channel, handler) => {
    if (!broadcastChannels.has(channel)) {
      throw new Error(`No broadcast registered for channel "${channel}"`);
    }
    const listener = (_e: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },
};
