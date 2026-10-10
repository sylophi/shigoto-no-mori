// The pull behind the auto-pull mark (`sm worktrees autopull`, which
// the engine keeps in its registry and reports on every identity): after
// the app's
// background fetch, every marked worktree in the project that has
// nothing of its own fast-forwards onto its upstream, so a checkout
// that only follows the remote never sits behind. "Nothing of its
// own" is checked right before the merge, not read from a cached row:
// the mark is a standing permission and the row can be a focus old.
//
// Every check is a reason to leave the worktree exactly as it is. A
// local commit means the pull is no longer a plain fast-forward, and
// whatever the user meant by that commit is theirs to resolve with the
// header's own pull-and-push. A dirty tree, untracked files included,
// is what `git merge` would refuse to touch or, for an untracked file
// the upstream now tracks, refuse on. A worktree with a script the
// app started in it is left alone too: the tree moving under a running
// dev server is the one way a pull the user never clicked could bite.
import * as Effect from "effect/Effect";
import { fastForwardToUpstream, hasUncommittedOrUntracked } from "../git/sync";
import { getUpstreamCounts, type WorktreeIdentity } from "../git/worktrees";

type AutoPullSkipReason =
  | "detached"
  | "no-upstream"
  | "synced"
  | "ahead"
  | "dirty"
  | "busy";

export type AutoPullOutcome =
  | { kind: "pulled"; commits: number }
  | { kind: "skipped"; reason: AutoPullSkipReason }
  | { kind: "failed"; message: string };

const skipped = (reason: AutoPullSkipReason): AutoPullOutcome => ({
  kind: "skipped",
  reason,
});

// Fast-forward one worktree onto its (already fetched) upstream when
// nothing local stands in the way. `busy` is the caller's knowledge of
// processes the app started in this worktree. Git cannot see those,
// and it is required so no caller forgets to ask.
export const autoPullWorktree = Effect.fnUntraced(function* (
  worktree: Pick<WorktreeIdentity, "path" | "detached">,
  options: { busy: boolean },
) {
  if (worktree.detached) return skipped("detached");
  const counts = yield* getUpstreamCounts(worktree.path);
  if (counts === null) return skipped("no-upstream");
  if (counts.behind === 0) return skipped("synced");
  if (counts.ahead > 0) return skipped("ahead");
  if (options.busy) return skipped("busy");
  return yield* Effect.gen(function* () {
    if (yield* hasUncommittedOrUntracked(worktree.path)) {
      return skipped("dirty");
    }
    yield* fastForwardToUpstream(worktree.path);
    return { kind: "pulled", commits: counts.behind } as AutoPullOutcome;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed<AutoPullOutcome>({
        kind: "failed",
        message: error.message,
      }),
    ),
  );
});

export interface AutoPullSweepResult {
  pulled: { worktree: WorktreeIdentity; commits: number }[];
  failed: { worktree: WorktreeIdentity; message: string }[];
}

// Every marked worktree of one project's `identities`, sequentially: a marked
// worktree is rare (the primary, maybe a release branch), and one git
// at a time keeps the sweep from stacking onto the row probes the same
// fetch just triggered. `busyWorktreeIds` are the worktrees with an
// app-started process in them. Marks for worktrees that no longer
// exist simply match nothing, so an `sm rm` in a terminal leaves no
// pull behind.
export const sweepAutoPull = Effect.fnUntraced(function* (
  identities: readonly WorktreeIdentity[],
  busyWorktreeIds: ReadonlySet<string>,
) {
  const result: AutoPullSweepResult = { pulled: [], failed: [] };
  for (const worktree of identities) {
    if (!worktree.autoPull) continue;
    const outcome = yield* autoPullWorktree(worktree, {
      busy: busyWorktreeIds.has(worktree.id),
    });
    if (outcome.kind === "pulled") {
      result.pulled.push({ worktree, commits: outcome.commits });
    } else if (outcome.kind === "failed") {
      result.failed.push({ worktree, message: outcome.message });
    }
  }
  return result;
});
