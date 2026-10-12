// Renderer-side declarations for what is on window: the desktop
// preload's bridge (main/preload.ts), which only the desktop entry
// reads (renderer/index.tsx).
import type { ElectronBridge } from "../main/preload";
import type { RendererApi } from "./lib/runtime/pageApi";

declare global {
  interface Window {
    // Only the desktop preload sets it.
    electronBridge?: ElectronBridge;
    // The page's api for the lab's tools, in a dev build or under the
    // lab only (lib/runtime/labHandle.ts). The app never reads it.
    __smLab?: { readonly api: RendererApi };
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
