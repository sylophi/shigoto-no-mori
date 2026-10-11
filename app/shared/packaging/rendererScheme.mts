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
import { type Flavor, flavorNames } from "@shigomori/engine/flavor";

export const RENDERER_SCHEME_HOST = "app";

// The host inbound deep links use, `<scheme>://open/<route>` (see
// main/electron/deepLink.ts). Kept apart from RENDERER_SCHEME_HOST:
// Clerk's OAuth callback claims exactly `<scheme>://app/`, and the
// scheme handler serves the renderer only on that host.
export const DEEP_LINK_HOST = "open";

// Each flavor registers its own scheme with the OS: a shared spelling
// would let an installed copy swallow another build's OAuth callbacks.
export function rendererSchemeName(flavor: Flavor): string {
  return flavorNames(flavor).scheme;
}

export function rendererSchemeOrigin(flavor: Flavor): string {
  return `${rendererSchemeName(flavor)}://${RENDERER_SCHEME_HOST}`;
}
