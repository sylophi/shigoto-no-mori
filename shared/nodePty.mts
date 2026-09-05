// Where node-pty keeps the prebuilt addon and the helper it starts PTY
// children through, relative to the repo root. Three places depend on
// this layout -- the packager allowlist and post-copy check in
// forge.config.ts, and the postinstall step that restores the helper's
// executable bit (scripts/fix-node-pty-helper.mjs) -- so a node-pty
// release that moves things is a one-file change.
//
// .mts with no imports: plain `node scripts/*.mjs` must be able to
// load it without a bundler. Never import this from the renderer.
export const NODE_PTY_PACKAGE = "node_modules/node-pty";
export const NODE_PTY_PREBUILDS = `${NODE_PTY_PACKAGE}/prebuilds`;
export const NODE_PTY_ADDON = "pty.node";
export const NODE_PTY_SPAWN_HELPER = "spawn-helper";

// The prebuild directory for one platform/arch pair, e.g. darwin-arm64.
export function nodePtyPrebuildDir(platform: string, arch: string): string {
  return `${NODE_PTY_PREBUILDS}/${platform}-${arch}`;
}
