// Preload script. Runs in an isolated context with access to Node + Electron APIs.
// Exposes the window's facts and its wire as `window.electronBridge`,
// which the renderer builds `window.api` over (renderer/electronApi.ts).
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge } from "electron";
import { exposeClerkBridge } from "@clerk/electron/preload";
import {
  APP_VERSION_FLAG,
  CLERK_PK_FLAG,
  DEV_BUILD_FLAG,
  DEVICE_ID_FLAG,
  optionalArgFlag,
  requireArgFlag,
} from "./argFlags";
import { electronBridgeTransport } from "./preloadTransport";

// The narrow bridge @clerk/electron/react rides for token storage and
// the system-browser OAuth transport, published beside window.api.
exposeClerkBridge();

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

const bridge = {
  deviceId,
  appVersion,
  // The Clerk publishable key main resolved from the account config
  // (baked, .env.local or process env). Empty on an unconfigured
  // build, which the renderer reads as "mount no ClerkProvider".
  clerkPublishableKey: optionalArgFlag(CLERK_PK_FLAG),
  // Client fact delivered the same way as the device id: dev-only
  // affordances key off the build showing the window, never the host
  // (a packaged client on a dev host must not grow dev hotkeys).
  isDev: process.argv.includes(DEV_BUILD_FLAG),
  // Client fact, constant per bridge: true here, false on the web
  // bridge. App-only UI (the port-forward controls, which need a real
  // local TCP listener) gates its mount on it, since the shared pages
  // render on both shells and cannot tell the bridges apart otherwise.
  // Widened past the `as const` below so RendererApi says boolean and
  // the web bridge's false assigns.
  isElectron: true as boolean,
  ...electronBridgeTransport,
} as const;

export type ElectronBridge = typeof bridge;

contextBridge.exposeInMainWorld("electronBridge", bridge);
