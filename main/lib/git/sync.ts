// Remote sync mutations. Each operates on a single worktree's checkout
// and lets `git` surface any failure as a non-zero exit (which `run`
// turns into a thrown Error -- the IPC layer relays the message verbatim
// into the renderer's toast).
import { checkoutBranch, deleteAnyLocalBranch } from "./branches";
import { run, runLenient } from "./core";
import { fetchAllRemotes, listRemotes, splitRemoteRefSync } from "./remotes";

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
// Fetch first so `@{u}` reflects the current remote tip.
export async function overwriteFromUpstream(
  worktreePath: string,
): Promise<void> {
  await run(worktreePath, ["fetch"]);
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

// Switch a worktree onto the primary branch and bring it up to date with
// the remote. Used by the "delete branch and switch to <primary>" cleanup
// on the repo root after a PR merges: the local primary is typically behind
// the just-merged remote tip. When the primary tracks a remote we
// fast-forward the local branch onto it with `pull --ff-only`, which is
// non-destructive — it refuses (surfacing git's error in the UI) rather
// than discarding local commits or uncommitted work when a clean
// fast-forward isn't possible. A purely local primary has no remote to sync
// to, so we just check it out.
export async function switchToPrimaryBranch(
  worktreePath: string,
  projectPath: string,
  primaryRef: string,
): Promise<void> {
  const remotes = await listRemotes(projectPath);
  // Checking out the qualified ref creates/lands on the local tracking
  // branch (never a detached HEAD); a local primaryRef is checked out as-is.
  await checkoutBranch(worktreePath, primaryRef, remotes);
  const split = splitRemoteRefSync(primaryRef, remotes);
  if (split) {
    // `pull` fetches the ref itself, so no separate fetch is needed.
    await run(worktreePath, ["pull", "--ff-only", split.remote, split.branch]);
  }
}

// Post-merge cleanup for the repo root: land it back on the primary branch
// and delete the now-merged branch it was sitting on. This MUST be one
// main-side operation rather than two chained renderer mutations: the switch
// flips the root's branch to the primary, which unmounts the cleanup box,
// and React Query silently drops a `mutate()` callback whose component has
// unmounted — so a renderer-chained delete is lost to that race. The
// checkout frees the merged branch (git refuses to delete a checked-out
// branch), so order matters: switch first, then delete. We never delete the
// branch we just landed on.
export async function switchToPrimaryAndDeleteBranch(
  worktreePath: string,
  projectPath: string,
  primaryRef: string,
  mergedBranch: string,
): Promise<void> {
  await switchToPrimaryBranch(worktreePath, projectPath, primaryRef);
  const remotes = await listRemotes(projectPath);
  const localPrimary =
    splitRemoteRefSync(primaryRef, remotes)?.branch ?? primaryRef;
  if (mergedBranch !== localPrimary) {
    // Force: after a squash merge the branch's own commits are never
    // reachable from the primary, so safe delete would always refuse.
    await deleteAnyLocalBranch(projectPath, mergedBranch, true);
  }
}
