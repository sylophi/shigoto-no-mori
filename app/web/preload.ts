// The browser's preload: the twin of main/preload.ts. Makes the web
// bridge once, on the profile's device id (settled under a lock, so it
// may wait on another tab), reading the real browser globals and Vite
// build facts, and wires another tab's writes, which the bridge cannot
// see from inside.
// Its api is the page's, which the entry hands to the boot (main.tsx).
import { viteEnv } from "./account/config";
import { browserHintsOf } from "./account/deviceName";
import { disposeWithPage } from "@/lib/runtime/client";
import {
  CLIENT_CONFIG_KEY,
  createWebBridge,
  establishWebDeviceId,
  PROFILE_KEY,
  SHARED_SETTINGS_KEY,
  type WebBridge,
} from "./ipc/register";

export function installWebBridge(): Promise<WebBridge> {
  // A storage the page can't open throws on its first read: rejected,
  // so the entry's handler says so.
  return Promise.resolve()
    .then(() => establishWebDeviceId(window.localStorage))
    .then(install);
}

async function install(deviceId: string): Promise<WebBridge> {
  const bridge = await createWebBridge({
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
  // Another tab's rename, client config or shared settings rewrite a
  // shared localStorage key, and the storage event fires only in the
  // OTHER tabs. Fan it out like a local change so every tab follows
  // without a reload (key === null is a full clear). The device follows
  // its own.
  window.addEventListener("storage", (event) => {
    if (event.key === PROFILE_KEY || event.key === null) {
      bridge.notifyProfileChanged();
    }
    if (event.key === CLIENT_CONFIG_KEY || event.key === null) {
      bridge.notifyClientConfigChanged();
    }
    if (event.key === SHARED_SETTINGS_KEY || event.key === null) {
      bridge.notifySharedSettingsChanged();
    }
  });
  return bridge;
}
