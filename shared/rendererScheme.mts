// Single source of truth for the renderer-origin custom scheme. The
// spelling must agree across the runtime protocol handler and Clerk
// bridge (main/electron/clerk.ts), the packaged Info.plist registration
// (forge.config.ts protocols), the socket host's Origin gate
// (host/socket/server.ts, the renderer's WebSocket dials carry this
// origin), and the Clerk instance's allowed_origins (relay/README.md)
// — a divergence breaks packaged OAuth deep links or direct dials with
// no build error, so every consumer derives from here. Constant-only
// module aside from the flavor switch: forge config, main, host and
// check scripts all import it.
import type { CliFlavor } from "./cliDist.mts";

export const RENDERER_SCHEME_HOST = "app";

// Dev and prod register separate schemes with the OS, mirroring the
// dev userData split: a shared spelling would let an installed copy
// swallow a dev build's OAuth callbacks (or vice versa).
export function rendererSchemeName(flavor: CliFlavor): string {
  return flavor === "prod" ? "shigomori" : "shigomori-dev";
}

export function rendererSchemeOrigin(flavor: CliFlavor): string {
  return `${rendererSchemeName(flavor)}://${RENDERER_SCHEME_HOST}`;
}

// Both flavors' origins, for gates that must admit the app's own
// renderer regardless of which build is dialing.
export function rendererSchemeOrigins(): string[] {
  return (["prod", "dev"] as const).map(rendererSchemeOrigin);
}
