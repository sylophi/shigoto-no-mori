// Remote sync mutations. Each operates on a single worktree's checkout
// and lets `git` surface any failure as a non-zero exit (which `run`
// turns into a thrown Error -- the IPC layer relays the message verbatim
// into the renderer's toast).
import { run, runLenient, splitZ } from "./core";
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
// `--untracked-files=normal` pins that protection against a user-level
// `status.showUntrackedFiles = no`. getChangedCount deliberately does
// NOT pin it -- it runs per worktree on every window focus, and `-uno`
// is a setting people choose to make exactly that scan cheap. The only
// cost of the mismatch is the overwrite button showing when this guard
// will refuse, and the guard still refuses.
//
// Ignored files never appear in `status`, but `reset --hard` overwrites
// them all the same when the upstream tree tracks a file at their path
// (e.g. a carried-over `.env` colliding with a committed one) -- and
// their content was never in git, so nothing can recover it. After a
// clean status the only paths that can collide are upstream-tracked
// ones with no local tracked counterpart, and (tree clean, so tracked
// == HEAD) those are exactly the upstream side's added files versus
// HEAD: one divergence-sized listing instead of two whole-tree ones.
// `--no-renames` matters -- rename detection would report an upstream
// rename as R, not A, and its destination path would slip through.
// git itself then says which candidates are ignored files on disk
// (`ls-files -o -i` with the candidates as pathspecs): a plain
// exists-check would false-positive on case-insensitive APFS, where an
// upstream case-only rename "exists" locally as the tracked file under
// its old casing -- a state `reset --hard` handles fine and this guard
// must not turn into a dead end.
export async function overwriteFromUpstream(
  worktreePath: string,
): Promise<void> {
  await run(worktreePath, ["fetch"]);
  const status = await run(worktreePath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  if (status.trim().length > 0) {
    throw new Error(
      "This worktree has uncommitted or untracked changes. Commit, stash, or discard them before overwriting from upstream.",
    );
  }
  const addedUpstream = splitZ(
    await run(worktreePath, [
      "diff",
      "--name-only",
      "--no-renames",
      "--diff-filter=A",
      "-z",
      "HEAD",
      "@{u}",
    ]),
  );
  // Chunked: pathspecs travel as argv, and a badly-behind branch can
  // carry enough added files to brush the OS arg-length limit.
  const chunks: string[][] = [];
  for (let i = 0; i < addedUpstream.length; i += 500) {
    chunks.push(addedUpstream.slice(i, i + 500));
  }
  const collisions = (
    await Promise.all(
      chunks.map((chunk) =>
        run(worktreePath, [
          "ls-files",
          "-z",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--",
          ...chunk,
        ]),
      ),
    )
  ).flatMap(splitZ);
  if (collisions.length > 0) {
    const shown = collisions.slice(0, 3).join(", ");
    const rest =
      collisions.length > 3 ? ` (+${collisions.length - 3} more)` : "";
    throw new Error(
      `Overwriting would replace ignored local file(s) the upstream branch tracks: ${shown}${rest}. Move them aside first.`,
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
// when the action propagates an error. `--end-of-options` keeps the ref
// out of the flag slot. Neither command accepts a trailing `--`, which
// they would read as a second revision argument.
async function rebaseOrMergeAgainst(
  worktreePath: string,
  ref: string,
): Promise<void> {
  try {
    await run(worktreePath, ["rebase", "--end-of-options", ref]);
  } catch {
    await runLenient(worktreePath, ["rebase", "--abort"]);
    try {
      await run(worktreePath, ["merge", "--end-of-options", ref]);
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
