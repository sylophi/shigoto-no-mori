// The page's api for tools outside the page (the lab's harness and
// scripts, a weblab step, a script on a debugging port), handed over by
// an entry only in a dev build or when the app was started for the lab
// (main/argFlags.ts LAB_FLAG). No module of the app reads it
// (test/host-boundary.mts).
import type { RendererApi } from "./pageApi";

export function exposeToLab(api: RendererApi): void {
  window.__smLab = { api };
}
