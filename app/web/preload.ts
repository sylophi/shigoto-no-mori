// The browser's preload: the twin of main/preload.ts. Installs the web
// bridge as window.api once, reading the real browser globals and Vite
// build facts (the factory itself stays injectable for the headless
// check), and wires the page-level events the bridge cannot see from
// inside (other tabs, the network coming back). The window.api
// assignment doubles as the compile-time proof that the web bridge
// satisfies the preload's RendererApi surface, since window.api is
// declared with that exact type (renderer/window.d.ts).
import { viteEnv } from "./account/config";
import { browserHintsOf } from "./account/deviceName";
import { ACCOUNT_KEY } from "./account/store";
import { createWebBridge, type WebBridge } from "./ipc/register";

let installed: WebBridge | null = null;

// The vite define is only substituted in web builds; under any other
// context the typeof guard keeps this module importable.
function buildVersion(): string {
  return typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__;
}

export function installWebBridge(): WebBridge {
  if (installed !== null) return installed;
  const bridge = createWebBridge({
    localStorage: window.localStorage,
    env: viteEnv(),
    userAgent: navigator.userAgent,
    browserHints: browserHintsOf(navigator),
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    isDev: import.meta.env.DEV,
    appVersion: buildVersion(),
  });
  window.api = bridge.api;
  installed = bridge;
  // Boot reconcile: connect the hub socket when a credential is
  // already stored, mirroring the desktop's ready-handler refresh.
  void bridge.refreshHub();
  // Cross-tab correction: sign-in/out in another tab rewrites the
  // shared localStorage key, and the storage event fires only in the
  // OTHER tabs. Fan it out like a local transition so every tab's
  // shell follows without a reload (key === null is a full clear).
  window.addEventListener("storage", (event) => {
    if (event.key === ACCOUNT_KEY || event.key === null) {
      bridge.notifyAccountChanged();
    }
  });
  // A tab coming back to the foreground, or the browser reporting the
  // network back, is when a socket that died meanwhile should be found
  // out at once: probe both planes so dead sessions redial in seconds
  // (the desktop does the same on the power monitor's resume).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") bridge.probe();
  });
  window.addEventListener("online", () => bridge.probe());
  return bridge;
}
