// Renderer-side declaration for the `api` surface exposed by preload.ts.
import type { RendererApi } from "../main/preload";

declare global {
  interface Window {
    api: RendererApi;
  }
}

export type { RendererApi };
