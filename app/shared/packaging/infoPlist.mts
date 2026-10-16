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

// The Automation prompt's sentence, shown the first time a terminal
// tool (Claude Code, Neovim, …) opens in the user's terminal, which
// the engine drives over AppleScript (Open.ts).
export const APPLE_EVENTS_USAGE_DESCRIPTION =
  "Shigoto no Mori opens terminal tools like Claude Code in a new window of your terminal.";

// The Files and Folders prompts' sentences, shown the first time the
// host reads a project or worktree kept on an external disk or a
// network share (watching it among the first reads). Until the prompt
// is answered, macOS holds that read.
export const REMOVABLE_VOLUMES_USAGE_DESCRIPTION =
  "Shigoto no Mori follows the projects and worktrees you keep on external disks.";
export const NETWORK_VOLUMES_USAGE_DESCRIPTION =
  "Shigoto no Mori follows the projects and worktrees you keep on network volumes.";
