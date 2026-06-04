// Remote sync mutations. Each operates on a single worktree's checkout
// and lets `git` surface any failure as a non-zero exit (which `run`
// turns into a thrown Error -- the IPC layer relays the message verbatim
// into the renderer's toast).
import { checkoutBranch } from "./branches";
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

// Switch a worktree onto the primary branch and snap it to the remote.
// Used by the "delete branch and switch to <primary>" cleanup on the repo
// root after a PR merges: the local primary is typically behind the just-
// merged remote tip, and the user wants the root to land on an up-to-date
// primary, not a stale local copy. When the primary resolves to a remote
// ref we fetch and hard-reset the local branch onto it, fully replacing
// any local state (the user explicitly asked for "the remote"). A purely
// local primary has no remote to sync to, so we just check it out.
export async function switchToPrimaryBranch(
  worktreePath: string,
  projectPath: string,
  primaryRef: string,
): Promise<void> {
  const remotes = await listRemotes(projectPath);
  // DWIM remote refs into the local tracking branch (also avoids landing
  // on a detached HEAD); a local primaryRef is checked out as-is.
  await checkoutBranch(worktreePath, primaryRef, remotes);
  if (splitRemoteRefSync(primaryRef, remotes)) {
    await fetchAllRemotes(projectPath);
    await run(worktreePath, ["reset", "--hard", primaryRef]);
  }
}
