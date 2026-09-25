// Renderer-side declaration for the `api` surface exposed by preload.ts.
import type { RendererApi } from "../main/preload";

declare global {
  interface Window {
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
