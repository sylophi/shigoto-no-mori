// Single source of truth for the renderer-origin custom scheme. The
// spelling must agree across the runtime protocol handler and Clerk
// bridge (main/electron/clerk.ts), the packaged Info.plist registration
// (forge.config.ts protocols), the dev per-worktree bundle
// registration (scripts/lib/devBundle.mts), and the Clerk instance's
// allowed_origins (hub/README.md).
// A divergence breaks packaged OAuth deep links with no build error,
// so every consumer derives from here. Constant-only module aside from
// the flavor switch: forge config, main and check scripts all import
// it.
import type { CliFlavor } from "./cliDist.mts";

export const RENDERER_SCHEME_HOST = "app";

// The host inbound deep links use, `<scheme>://open/<route>` (see
// main/electron/deepLink.ts). Kept apart from RENDERER_SCHEME_HOST:
// Clerk's OAuth callback claims exactly `<scheme>://app/`, and the
// scheme handler serves the renderer only on that host.
export const DEEP_LINK_HOST = "open";

// Dev and prod register separate schemes with the OS, mirroring the
// dev userData split: a shared spelling would let an installed copy
// swallow a dev build's OAuth callbacks (or vice versa).
export function rendererSchemeName(flavor: CliFlavor): string {
  return flavor === "prod" ? "shigomori" : "shigomori-dev";
}

export function rendererSchemeOrigin(flavor: CliFlavor): string {
  return `${rendererSchemeName(flavor)}://${RENDERER_SCHEME_HOST}`;
}

// Where deep links start. The sm CLI gets it baked in at build time
// (scripts/build-cli.mts) for `sm link`.
export function deepLinkOrigin(flavor: CliFlavor): string {
  return `${rendererSchemeName(flavor)}://${DEEP_LINK_HOST}`;
}
