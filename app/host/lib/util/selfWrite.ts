// Tracks when the app itself last wrote inside the shigomori data dir, so
// the state watcher can tell its own filesystem echo apart from a
// genuinely external change (a CLI run in a terminal). Every app-side
// writer that touches the data dir funnels through the chokepoints that
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

// The same idea for the app's own MUTATING git commands, scoped to the
// repository the command ran in: the git runner (host/lib/git/core.ts)
// marks a command in flight and then its completion, and the
// git-directory watcher asks whether any such command touched the
// repository an event came from. A ref the app moved is already
// invalidated by its caller, while a ref an agent moved must still
// ping, which is why the scope is the repository and not the process:
// a slow fetch in one project must not swallow a commit in another.
// Kept apart from the data dir marker so an app git command cannot
// swallow an external data dir write or the reverse.
const inFlightGitWrites = new Map<string, number>();
const completedGitWrites = new Map<string, number>();

// Marks a mutating git command in `cwd` as running. The returned
// function marks it done.
export function beginGitSelfWrite(cwd: string): () => void {
  inFlightGitWrites.set(cwd, (inFlightGitWrites.get(cwd) ?? 0) + 1);
  return () => {
    const count = (inFlightGitWrites.get(cwd) ?? 1) - 1;
    if (count <= 0) inFlightGitWrites.delete(cwd);
    else inFlightGitWrites.set(cwd, count);
    completedGitWrites.set(cwd, Date.now());
  };
}

// Whether an app-run mutating git command whose cwd `matches` is in
// flight now or completed within `ms`.
export function gitSelfWroteWithin(
  ms: number,
  matches: (cwd: string) => boolean,
): boolean {
  for (const cwd of inFlightGitWrites.keys()) {
    if (matches(cwd)) return true;
  }
  const since = Date.now() - ms;
  for (const [cwd, at] of completedGitWrites) {
    if (at < since) {
      completedGitWrites.delete(cwd);
      continue;
    }
    if (matches(cwd)) return true;
  }
  return false;
}
