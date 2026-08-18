// Remote sync mutations. Each operates on a single worktree's checkout
// and lets `git` surface any failure as a non-zero exit (which `run`
// turns into a thrown Error -- the IPC layer relays the message verbatim
// into the renderer's toast).
import { run, runLenient } from "./core";
import { fetchAllRemotes, listRemotes } from "./remotes";

export async function pushFastForward(worktreePath: string): Promise<void> {
  await run(worktreePath, ["push"]);
}

export async function pullFastForward(worktreePath: string): Promise<void> {
  await run(worktreePath, ["pull", "--ff-only"]);
}

export async function pushForceWithLease(worktreePath: string): Promise<void> {
  await run(worktreePath, ["push", "--force-with-lease"]);
}

// "Overwrite": throw away the local divergence and snap to the upstream.
// Fetch first so `@{u}` reflects the current remote tip, then re-check
// the tree right before the reset. The renderer only offers this action
// on a clean worktree, but it decides that from a cached `changedCount`
// that another process (an agent, an editor) can invalidate without the
// window ever losing focus. A `reset --hard` past uncommitted work
// leaves nothing to recover from, so the guard has to live here.
// Untracked files count as dirty too: `reset --hard` silently
// overwrites any untracked file whose path exists in the upstream tree.
// Same command as getChangedCount, so this refuses in exactly the
// states where the renderer already hides the button (ignored files are
// excluded, so build output doesn't trip it).
export async function overwriteFromUpstream(
  worktreePath: string,
): Promise<void> {
  await run(worktreePath, ["fetch"]);
  const status = await run(worktreePath, ["status", "--porcelain=v1"]);
  if (status.trim().length > 0) {
    throw new Error(
      "This worktree has uncommitted or untracked changes. Commit, stash, or discard them before overwriting from upstream.",
    );
  }
  await run(worktreePath, ["reset", "--hard", "@{u}"]);
}

// Publish: push the current branch to the first configured remote with
// upstream tracking. `HEAD` resolves to whatever's checked out, and `-u`
// wires up `branch.<name>.{remote,merge}` so subsequent pulls/pushes
// don't need an explicit remote.
export async function publishCurrentBranch(
  worktreePath: string,
  projectPath: string,
): Promise<void> {
  const remotes = await listRemotes(projectPath);
  const first = remotes[0];
  if (!first) throw new Error("No git remote configured");
  await run(worktreePath, ["push", "-u", first, "HEAD"]);
}

// Try rebase first for linear history; on a per-commit conflict abort
// and fall back to a whole-tree merge. Both abort paths swallow the
// abort failure so the worktree isn't left half-rebased or half-merged
// when the action propagates an error.
async function rebaseOrMergeAgainst(
  worktreePath: string,
  ref: string,
): Promise<void> {
  try {
    await run(worktreePath, ["rebase", ref]);
  } catch {
    await runLenient(worktreePath, ["rebase", "--abort"]);
    try {
      await run(worktreePath, ["merge", ref]);
    } catch (err) {
      await runLenient(worktreePath, ["merge", "--abort"]);
      throw err;
    }
  }
}

// Combined resolution for the "diverged but mergeable" state. The
// `merge-tree --write-tree` probe (gating this state) already validated
// the whole-tree merge as clean, which is what makes the merge fallback
// safe.
export async function pullRebaseOrMergeAndPush(
  worktreePath: string,
): Promise<void> {
  // react-doctor-disable-next-line react-doctor/async-parallel -- fetch → rebase/merge → push is a sequential domain operation
  await run(worktreePath, ["fetch"]);
  await rebaseOrMergeAgainst(worktreePath, "@{u}");
  await run(worktreePath, ["push"]);
}

// Fetch *all* remotes from the project root, not the worktree's tracked
// upstream: primaryRef can live on a different remote than the branch
// tracks (e.g. branch tracks fork/feat while primary is origin/main), so
// `git fetch` from the worktree would leave the rebase target stale.
// The coalescing helper also dedupes against the focus-driven sweep.
export async function syncWithPrimary(
  worktreePath: string,
  projectPath: string,
  primaryRef: string,
): Promise<void> {
  await fetchAllRemotes(projectPath);
  await rebaseOrMergeAgainst(worktreePath, primaryRef);
}
