// Preload script. Runs in an isolated context with access to Node + Electron APIs.
// Exposes the window's facts as `window.electronBridge`, and asks for
// the port the window's calls to its shell ride, which the renderer
// builds its page api over (renderer/lib/runtime/desktop.ts).
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge } from "electron";
import { exposeClerkBridge } from "@clerk/electron/preload";
import {
  APP_VERSION_FLAG,
  CLERK_PK_FLAG,
  DEV_BUILD_FLAG,
  LAB_FLAG,
  optionalArgFlag,
  requireArgFlag,
  ROUTE_FLAG,
} from "./argFlags";
import { requestShellPort } from "./preloadPort";

// The narrow bridge @clerk/electron/react rides for token storage and
// the system-browser OAuth transport, published beside the bridge.
exposeClerkBridge();

// The window's facts, on argv (argFlags.ts).
const bridge = {
  appVersion: requireArgFlag(APP_VERSION_FLAG),
  clerkPublishableKey: optionalArgFlag(CLERK_PK_FLAG),
  route: requireArgFlag(ROUTE_FLAG),
  isDev: process.argv.includes(DEV_BUILD_FLAG),
  isLab: process.argv.includes(LAB_FLAG),
  // Client fact, constant per bridge: true here, false on the web
  // bridge. App-only UI (the port-forward controls, which need a real
  // local TCP listener) gates its mount on it, since the shared pages
  // render on both shells and cannot tell the bridges apart otherwise.
  // Widened past the `as const` below so RendererApi says boolean and
  // the web bridge's false assigns.
  isElectron: true as boolean,
  // What this machine enrolls under (os.platform()), so its own row
  // draws without the hub's copy. Widened like isElectron.
  platform: process.platform as string,
  // Asks for the page's shell port, which arrives as a window message
  // (SHELL_PORT_CHANNEL): the renderer listens first, then asks.
  requestShellPort,
} as const;

export type ElectronBridge = typeof bridge;

contextBridge.exposeInMainWorld("electronBridge", bridge);
