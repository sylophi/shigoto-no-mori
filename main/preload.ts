// Preload script — runs in an isolated context with access to Node + Electron APIs.
// Exposes a typed `window.api` to the renderer.
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge } from "electron";
import { buildApi } from "@shared/ipc/client";
import { DEVICE_ID_FLAG } from "@shared/deviceIdFlag.mts";
import { electronClientTransport } from "./preloadTransport";

// The device id arrives on argv (main passes --sm-device-id=<uuid> via
// webPreferences.additionalArguments, which reaches sandboxed preloads)
// so the renderer can read it synchronously at module scope. Missing or
// empty means main and preload disagree on the flag, so fail loudly
// rather than hand out keys scoped to nothing. Unreachable in practice:
// main's ready handler resolves the id (minting or throwing) before
// any window is created.
const deviceIdArg = process.argv.find((arg) => arg.startsWith(DEVICE_ID_FLAG));
const deviceId = deviceIdArg?.slice(DEVICE_ID_FLAG.length) ?? "";
if (!deviceId) {
  throw new Error("preload started without --sm-device-id");
}

const api = {
  deviceId,
  // Both scopes ride the same IPC bridge while host and client live in
  // one process. Step 3 swaps the host entry for a socket transport and
  // nothing else changes.
  ...buildApi({
    host: electronClientTransport,
    client: electronClientTransport,
  }),
} as const;

export type RendererApi = typeof api;

contextBridge.exposeInMainWorld("api", api);
