// Preload script — runs in an isolated context with access to Node + Electron APIs.
// Exposes a typed `window.api` to the renderer.
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge } from "electron";
import { APP_VERSION_FLAG } from "@shared/appVersionFlag.mts";
import { buildApi } from "@shared/ipc/client";
import { DEV_BUILD_FLAG } from "@shared/devBuildFlag.mts";
import { DEVICE_ID_FLAG } from "@shared/deviceIdFlag.mts";
import { requireArgFlag } from "./argFlags";
import { electronClientTransport } from "./preloadTransport";

// The device id arrives on argv (main passes --sm-device-id=<uuid> via
// webPreferences.additionalArguments, which reaches sandboxed preloads)
// so the renderer can read it synchronously at module scope. Unreachable
// as empty in practice: main's ready handler resolves the id (minting or
// throwing) before any window is created.
const deviceId = requireArgFlag(DEVICE_ID_FLAG, "--sm-device-id");

// This build's version, on argv beside the device id. The renderer
// sends it in the socket hello and compares it against a remote host's
// welcome to flag a version skew.
const appVersion = requireArgFlag(APP_VERSION_FLAG, "--sm-app-version");

const api = {
  deviceId,
  appVersion,
  // Client fact delivered the same way as the device id: dev-only
  // affordances key off the build showing the window, never the host
  // (a packaged client on a dev host must not grow dev hotkeys).
  isDev: process.argv.includes(DEV_BUILD_FLAG),
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
