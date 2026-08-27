// Browser-side singleton install of the web bridge. This is the one
// module that reads the real browser globals and Vite build facts; the
// factory itself stays injectable for the headless check. The
// window.api assignment doubles as the compile-time proof that the web
// bridge satisfies the preload's RendererApi surface, since window.api
// is declared with that exact type (renderer/window.d.ts).
import { viteEnv } from "../account/config";
import { ACCOUNT_KEY } from "../account/store";
import { createWebBridge, type WebBridge } from "./createWebBridge";

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
    sessionStorage: window.sessionStorage,
    env: viteEnv(),
    userAgent: navigator.userAgent,
    origin: window.location.origin,
    navigate: (url) => window.location.assign(url),
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    isDev: import.meta.env.DEV,
    appVersion: buildVersion(),
  });
  window.api = bridge.api;
  installed = bridge;
  // Boot reconcile: connect the relay socket when a credential is
  // already stored, mirroring the desktop's ready-handler refresh.
  void bridge.refreshRelay();
  // Cross-tab correction: sign-in/out in another tab rewrites the
  // shared localStorage key, and the storage event fires only in the
  // OTHER tabs. Fan it out like a local transition so every tab's
  // shell follows without a reload (key === null is a full clear).
  window.addEventListener("storage", (event) => {
    if (event.key === ACCOUNT_KEY || event.key === null) {
      bridge.notifyAccountChanged();
    }
  });
  return bridge;
}

// The installed bridge for view code (the callback page, the devices
// page's revoke). Throws rather than lazily installing so a missed
// install order (bridge after app modules) fails loudly at the first
// use instead of silently double-building.
export function webBridge(): WebBridge {
  if (installed === null) {
    throw new Error("web bridge not installed, call installWebBridge first");
  }
  return installed;
}
