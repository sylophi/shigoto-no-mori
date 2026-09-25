// Info.plist entries both bundles share: forge.config.ts writes them
// into the packaged app (packagerConfig.extendInfo) and
// scripts/dev-electron.mts into the per-worktree dev clone, so the two
// cannot drift.
//
// .mts with no imports, loadable by plain `node scripts/*` and by the
// forge config. Never import this from the renderer.

// macOS 15+ gates outbound connections to local-network addresses
// behind a one-time Local Network prompt, and shows this sentence on
// it. Without the key the first direct dial to a LAN peer fails with
// EHOSTUNREACH and nothing tells the user why.
export const LOCAL_NETWORK_USAGE_DESCRIPTION =
  "Shigoto no Mori connects directly to your other devices on this network to show and manage their worktrees.";
