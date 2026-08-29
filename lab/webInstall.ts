// Lab stand-in for web/bridge/install.ts, swapped in by the lab vite
// config's resolver for imports coming from web/ modules: the web app
// boots on the fixture window.api instead of the real relay-backed
// bridge, and the singleton the web pages reach for answers with
// harmless lab shims (access ok, refresh a no-op).
import { createWebAccessStore } from "../web/account/webAccess";
import { installLabBridge } from "./bridge";

type LabWebBridge = {
  api: unknown;
  webAccess: ReturnType<typeof createWebAccessStore>;
  notifyAccountChanged(): void;
  refreshRelay(): Promise<void>;
  stop(): Promise<void>;
};

let installed: LabWebBridge | null = null;

export function installWebBridge(): LabWebBridge {
  if (installed !== null) return installed;
  installLabBridge({ webShell: true });
  installed = {
    api: (window as { api?: unknown }).api,
    webAccess: createWebAccessStore(),
    notifyAccountChanged: () => {},
    refreshRelay: async () => {},
    stop: async () => {},
  };
  return installed;
}

export function webBridge(): LabWebBridge {
  if (installed === null) {
    throw new Error(
      "lab web bridge not installed, call installWebBridge first",
    );
  }
  return installed;
}
