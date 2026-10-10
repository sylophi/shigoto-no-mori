// Renderer-side declarations for the bridges on window: the preload's
// (main/preload.ts) and the `api` surface built over it, which the web
// and lab bridges provide as well.
import type { ClientApi } from "./lib/runtime/Api";
import type { ElectronBridge } from "../main/preload";

type RendererApi = Omit<ElectronBridge, "requestShellPort" | "route"> & {
  readonly deviceId: string;
} & ClientApi;

declare global {
  interface Window {
    // Only the desktop preload sets it.
    electronBridge?: ElectronBridge;
    api: RendererApi;
  }

  // The Battery Status API, which TypeScript's DOM lib leaves out.
  // Chromium has it, Safari and Firefox do not, hence optional.
  interface BatteryManager extends EventTarget {
    readonly charging: boolean;
  }
  interface Navigator {
    getBattery?: () => Promise<BatteryManager>;
  }
}

export type { RendererApi };
