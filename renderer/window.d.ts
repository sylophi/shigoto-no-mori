// Renderer-side declaration for the `api` surface every shell installs
// (shared/ipc/rendererApi.ts), and for the desktop preload's raw
// bridge the Electron shell builds it from.
import type { ElectronBridge } from "../main/preload";
import type { RendererApi } from "@shared/ipc/rendererApi";

declare global {
  interface Window {
    api: RendererApi;
    // Present in the desktop window only (main/preload.ts). Read once,
    // by renderer/electronApi.ts, to assemble window.api.
    smBridge: ElectronBridge;
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
