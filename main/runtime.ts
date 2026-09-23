// The desktop process's one Effect runtime. Every service the host and
// the Electron binding provide is composed into AppLive here, and the
// non-Effect edges (ipcMain handlers, ws callbacks, Electron events)
// run their work through `runtime`. Disposing it on quit runs every
// layer's finalizers in reverse acquisition order, which is the
// teardown ordering main/index.ts used to sequence by hand.
import { Layer, ManagedRuntime } from "effect";

// Shared across every ManagedRuntime this process builds so a layer is
// memoized once even when a second runtime provides it.
export const appMemoMap = Layer.makeMemoMapUnsafe();

export const AppLive = Layer.empty;

export const runtime = ManagedRuntime.make(AppLive, { memoMap: appMemoMap });
