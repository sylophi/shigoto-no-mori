// Tracks when the app itself last wrote inside the shigomori root, so
// the state watcher can tell its own filesystem echo apart from a
// genuinely external change (a CLI run in a terminal). Every app-side
// writer that touches the root funnels through the chokepoints that
// call noteSelfWrite (store.ts, jsonFile.ts, the CLI runner); the
// watcher skips events landing within the echo window.
let lastSelfWrite = 0;

// How long after an app-side write its filesystem echo is still
// attributed to the app. Shared by both watchers.
export const SELF_ECHO_MS = 1000;

export function noteSelfWrite(): void {
  lastSelfWrite = Date.now();
}

export function selfWroteWithin(ms: number): boolean {
  return Date.now() - lastSelfWrite < ms;
}

// The same marker for the app's own MUTATING git commands (the git
// runner notes them, host/lib/git/core.ts), read by the git-directory
// watcher: a ref the app moved is already invalidated by its caller,
// while a ref an agent moved must still ping. Kept apart from the root
// marker so an app git command cannot swallow an external root write
// or the reverse.
let lastGitSelfWrite = 0;

export function noteGitSelfWrite(): void {
  lastGitSelfWrite = Date.now();
}

export function gitSelfWroteWithin(ms: number): boolean {
  return Date.now() - lastGitSelfWrite < ms;
}
