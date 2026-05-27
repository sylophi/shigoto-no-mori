// Remote sync mutations. Each operates on a single worktree's checkout
// and lets `git` surface any failure as a non-zero exit (which `run`
// turns into a thrown Error -- the IPC layer relays the message verbatim
// into the renderer's toast).
import { run, runLenient } from "./core";
import { listRemotes } from "./remotes";

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

// Combined resolution for the "diverged but mergeable" state. Tries
// rebase first for linear history; if a per-commit conflict strands the
// rebase, aborts and falls back to a whole-tree merge -- which the
// `merge-tree --write-tree` probe (gating this state) already validated
// as clean. If the fallback merge unexpectedly conflicts too (probe was
// wrong), aborts the merge before propagating so the worktree isn't
// left in a half-merged state.
export async function pullRebaseOrMergeAndPush(
  worktreePath: string,
): Promise<void> {
  await run(worktreePath, ["fetch"]);
  try {
    await run(worktreePath, ["rebase", "@{u}"]);
  } catch {
    // Rebase hit a per-commit conflict. Restore the pre-rebase HEAD and
    // try a whole-tree merge instead.
    await runLenient(worktreePath, ["rebase", "--abort"]);
    try {
      await run(worktreePath, ["merge", "@{u}"]);
    } catch (err) {
      await runLenient(worktreePath, ["merge", "--abort"]);
      throw err;
    }
  }
  await run(worktreePath, ["push"]);
}

// Bring this worktree's branch up to date with the project's primary
// ref (typically `origin/main`). Fetch first so the comparison is
// against the current remote tip, then rebase; on a per-commit
// conflict fall back to a whole-tree merge. Same abort-on-failure
// shape as `pullRebaseOrMergeAndPush` so a conflict at either step
// leaves the worktree clean instead of mid-rebase/mid-merge.
export async function syncWithPrimary(
  worktreePath: string,
  primaryRef: string,
): Promise<void> {
  await run(worktreePath, ["fetch"]);
  try {
    await run(worktreePath, ["rebase", primaryRef]);
  } catch {
    await runLenient(worktreePath, ["rebase", "--abort"]);
    try {
      await run(worktreePath, ["merge", primaryRef]);
    } catch (err) {
      await runLenient(worktreePath, ["merge", "--abort"]);
      throw err;
    }
  }
}
