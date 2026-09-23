// Preload script. Runs in an isolated context with access to Node + Electron APIs.
// Exposes the raw bridge the renderer builds its typed `window.api` from.
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
// the system-browser OAuth transport, published beside the app bridge.
exposeClerkBridge();

// What the preload hands the renderer: the argv facts and the raw
// transport. The renderer assembles window.api from these itself
// (renderer/electronApi.ts) rather than receiving the finished api
// across contextBridge, because a rejection crossing the bridge keeps
// only its message and stack: the tag and fields of a typed error
// would be lost before any matcher saw them. The transport therefore
// resolves an envelope, and the renderer rebuilds the error on its
// own side, where custom properties survive.
const bridge = {
  // The device id arrives on argv (main passes --sm-device-id=<uuid> via
  // webPreferences.additionalArguments, which reaches sandboxed preloads)
  // so the renderer can read it synchronously at module scope. Unreachable
  // as empty in practice: main's ready handler resolves the id (minting or
  // throwing) before any window is created.
  deviceId: requireArgFlag(DEVICE_ID_FLAG, "--sm-device-id"),
  // This build's version, on argv beside the device id. The renderer
  // sends it in the socket hello and compares it against a remote host's
  // welcome to flag a version skew.
  appVersion: requireArgFlag(APP_VERSION_FLAG, "--sm-app-version"),
  // The Clerk publishable key main resolved from the account config
  // (baked, .env.local or process env). Empty on an unconfigured
  // build, which the renderer reads as "mount no ClerkProvider".
  clerkPublishableKey: optionalArgFlag(CLERK_PK_FLAG),
  // Client fact delivered the same way as the device id: dev-only
  // affordances key off the build showing the window, never the host
  // (a packaged client on a dev host must not grow dev hotkeys).
  isDev: process.argv.includes(DEV_BUILD_FLAG),
  invoke: electronBridgeTransport.invoke,
  subscribe: electronBridgeTransport.subscribe,
};

export type ElectronBridge = typeof bridge;

contextBridge.exposeInMainWorld("smBridge", bridge);
