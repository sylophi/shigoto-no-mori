// The browser's preload: the twin of main/preload.ts. Makes the web
// bridge once, on the profile's device id (settled under the account
// lock, so it may wait on another tab), reading the real browser
// globals and Vite build facts, and wires the page-level events the
// bridge cannot see from inside (other tabs, the network coming back).
// Its api is the page's, which the entry hands to the boot (main.tsx).
import { viteEnv } from "./account/config";
import { browserHintsOf } from "./account/deviceName";
import { ACCOUNT_KEY } from "./account/store";
import { disposeWithPage } from "@/lib/runtime/client";
import {
  CLIENT_CONFIG_KEY,
  createWebBridge,
  establishWebDeviceId,
  SHARED_SETTINGS_KEY,
  type WebBridge,
} from "./ipc/register";

let installed: Promise<WebBridge> | null = null;

export function installWebBridge(): Promise<WebBridge> {
  // A storage the page can't open throws on its first read: rejected,
  // so the entry's handler says so.
  installed ??= Promise.resolve()
    .then(() => establishWebDeviceId(window.localStorage))
    .then(install);
  return installed;
}

function install(deviceId: string): WebBridge {
  const bridge = createWebBridge({
    localStorage: window.localStorage,
    deviceId,
    env: viteEnv(),
    userAgent: navigator.userAgent,
    browserHints: browserHintsOf(navigator),
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    isDev: import.meta.env.DEV,
    appVersion: __APP_VERSION__,
  });
  disposeWithPage({ dispose: bridge.stop });
  // Boot reconcile: connect the hub socket when a credential is
  // already stored, mirroring the desktop's ready-handler refresh.
  void bridge.refreshHub();
  // Cross-tab correction: another tab's sign-in or sign-out, client
  // config or shared settings rewrite a shared localStorage key, and the
  // storage event fires only in the OTHER tabs. Fan it out like a local
  // change so every tab follows without a reload (key === null is a
  // full clear).
  window.addEventListener("storage", (event) => {
    if (event.key === ACCOUNT_KEY || event.key === null) {
      bridge.notifyAccountChanged();
    }
    if (event.key === CLIENT_CONFIG_KEY || event.key === null) {
      bridge.notifyClientConfigChanged();
    }
    if (event.key === SHARED_SETTINGS_KEY || event.key === null) {
      bridge.notifySharedSettingsChanged();
    }
  });
  // A tab coming back to the foreground, or the browser reporting the
  // network gone or back, is when a socket that died meanwhile should be
  // found out at once: probe both planes so dead sessions redial in
  // seconds (the desktop does the same on the power monitor's resume),
  // and a network the browser knows is gone reads as reconnecting
  // within the probe's window rather than as connected until the
  // heartbeat gives up.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") bridge.probe();
  });
  window.addEventListener("online", () => bridge.probe());
  window.addEventListener("offline", () => bridge.probe());
  return bridge;
}
