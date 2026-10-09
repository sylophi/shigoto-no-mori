// Preload script. Runs in an isolated context with access to Node + Electron APIs.
// Exposes the window's facts as `window.electronBridge`, and asks for
// the port the window's calls to its shell ride, which the renderer
// builds `window.api` over (renderer/electronApi.ts).
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge } from "electron";
import { exposeClerkBridge } from "@clerk/electron/preload";
import {
  APP_VERSION_FLAG,
  CLERK_PK_FLAG,
  DEV_BUILD_FLAG,
  optionalArgFlag,
  requireArgFlag,
} from "./argFlags";
import { requestShellPort } from "./preloadPort";

// The narrow bridge @clerk/electron/react rides for token storage and
// the system-browser OAuth transport, published beside window.api.
exposeClerkBridge();

// This build's version, on argv (main passes it via
// webPreferences.additionalArguments, which reaches sandboxed
// preloads). The renderer sends it in the link's hello and compares it
// against a remote host's welcome to flag a version skew. The device id
// is the host's, and comes with its address (renderer/electronApi.ts).
const appVersion = requireArgFlag(APP_VERSION_FLAG, "--sm-app-version");

const bridge = {
  appVersion,
  // The Clerk publishable key main resolved from the account config
  // (baked, .env.local or process env). Empty on an unconfigured
  // build, which the renderer reads as "mount no ClerkProvider".
  clerkPublishableKey: optionalArgFlag(CLERK_PK_FLAG),
  // Client fact delivered the same way as the version: dev-only
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
  // Asks for the page's shell port, which arrives as a window message
  // (SHELL_PORT_CHANNEL): the renderer listens first, then asks.
  requestShellPort,
} as const;

export type ElectronBridge = typeof bridge;

contextBridge.exposeInMainWorld("electronBridge", bridge);
