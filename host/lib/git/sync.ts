// Remote sync mutations. Each operates on a single worktree's checkout
// and lets `git` surface any failure as a non-zero exit (a GitError,
// whose message the IPC layer relays into the renderer's toast).
//
// A caller that leaves interrupts what is still waiting (a fetch, a
// push), but a step that rewrites the working tree (a merge, a reset,
// a rebase and its abort) runs uninterruptible: killing git halfway
// through one leaves a checkout nobody asked for.
import { Effect } from "effect";
import { chunked, runEffect, runLenientEffect, splitZ } from "./core";
import { fetchAllRemotesEffect, listRemotesEffect } from "./remotes";

export const pushFastForwardEffect = Effect.fn("sync.pushFastForward")(
  function* (worktreePath: string) {
    yield* runEffect(worktreePath, ["push"]);
  },
);

// A fetch, then the fast-forward. `git pull --ff-only` does the same in
// one process, but as one process the whole thing would have to be
// uninterruptible for the sake of the merge step, and a caller who
// left could not end the network wait. Split, the fetch stops with the
// caller and only the merge, which rewrites the tree, runs to the end.
export const pullFastForwardEffect = Effect.fn("sync.pullFastForward")(
  function* (worktreePath: string) {
    yield* runEffect(worktreePath, ["fetch"]);
    yield* fastForwardToUpstreamEffect(worktreePath);
  },
);

export const pushForceWithLeaseEffect = Effect.fn("sync.pushForceWithLease")(
  function* (worktreePath: string) {
    yield* runEffect(worktreePath, ["push", "--force-with-lease"]);
  },
);

// Fast-forward onto the already-fetched upstream, no network. What the
// auto-pull sweep runs right after the app's own fetch, where a `pull`
// would fetch a second time. `--ff-only` refuses anything but a plain
// fast-forward, so a commit that raced the caller's checks fails the
// merge rather than producing a merge commit nobody asked for.
export const fastForwardToUpstreamEffect = Effect.fn(
  "sync.fastForwardToUpstream",
)(function* (worktreePath: string) {
  yield* Effect.uninterruptible(
    runEffect(worktreePath, ["merge", "--ff-only", "@{u}"]),
  );
});

// Uncommitted changes, untracked files included. Pinned to
// `--untracked-files=normal` against a user-level
// `status.showUntrackedFiles = no`: the guards below decide whether a
// tree can be overwritten or fast-forwarded, and an untracked file the
// upstream now tracks is exactly what those would land on.
// getWorkingTreeChanges (git/worktrees.ts) deliberately does NOT pin
// it. It runs per worktree on every window focus, and `-uno` is a
// setting people choose to make exactly that scan cheap. The only cost
// of the mismatch is a button showing when the guard will refuse, and
// the guard still refuses.
export const hasUncommittedOrUntrackedEffect = Effect.fnUntraced(function* (
  worktreePath: string,
) {
  const status = yield* runEffect(worktreePath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  return status.trim().length > 0;
});

// "Overwrite": throw away the local divergence and snap to the upstream.
// Fetch first so `@{u}` reflects the current remote tip, then re-check
// the tree right before the reset. The renderer only offers this action
// on a clean worktree, but it decides that from a cached `changedCount`
// that another process (an agent, an editor) can invalidate without the
// window ever losing focus. A `reset --hard` past uncommitted work
// leaves nothing to recover from, so the guard has to live here.
// Untracked files count as dirty too: `reset --hard` silently
// overwrites any untracked file whose path exists in the upstream tree
// (see hasUncommittedOrUntracked).
//
// Ignored files never appear in `status`, but `reset --hard` overwrites
// them all the same when the upstream tree tracks a file at their path
// (e.g. a carried-over `.env` colliding with a committed one), and
// their content was never in git, so nothing can recover it. After a
// clean status the only paths that can collide are upstream-tracked
// ones with no local tracked counterpart, and (tree clean, so tracked
// == HEAD) those are exactly the upstream side's added files versus
// HEAD: one divergence-sized listing instead of two whole-tree ones.
// `--no-renames` matters because rename detection would report an
// upstream rename as R, not A, and its destination path would slip
// through.
// git itself then says which candidates are ignored files on disk
// (`ls-files -o -i` with the candidates as pathspecs): a plain
// exists-check would false-positive on case-insensitive APFS, where an
// upstream case-only rename "exists" locally as the tracked file under
// its old casing. That is a state `reset --hard` handles fine, and this
// guard must not turn into a dead end.
export const overwriteFromUpstreamEffect = Effect.fn(
  "sync.overwriteFromUpstream",
)(function* (worktreePath: string) {
  yield* runEffect(worktreePath, ["fetch"]);
  if (yield* hasUncommittedOrUntrackedEffect(worktreePath)) {
    return yield* Effect.fail(
      new Error(
        "This worktree has uncommitted or untracked changes. Commit, stash, or discard them before overwriting from upstream.",
      ),
    );
  }
  const addedUpstream = splitZ(
    yield* runEffect(worktreePath, [
      "diff",
      "--name-only",
      "--no-renames",
      "--diff-filter=A",
      "-z",
      "HEAD",
      "@{u}",
    ]),
  );
  // Chunked: a badly-behind branch can carry enough added files to
  // brush the OS arg-length limit.
  const collisions = (yield* Effect.forEach(
    chunked(addedUpstream),
    (chunk) =>
      runEffect(worktreePath, [
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--",
        ...chunk,
      ]),
    { concurrency: "unbounded" },
  )).flatMap(splitZ);
  if (collisions.length > 0) {
    const shown = collisions.slice(0, 3).join(", ");
    const rest =
      collisions.length > 3 ? ` (+${collisions.length - 3} more)` : "";
    return yield* Effect.fail(
      new Error(
        `Overwriting would replace ignored local file(s) the upstream branch tracks: ${shown}${rest}. Move them aside first.`,
      ),
    );
  }
  yield* Effect.uninterruptible(
    runEffect(worktreePath, ["reset", "--hard", "@{u}"]),
  );
});

// Publish: push the current branch to the first configured remote with
// upstream tracking. `HEAD` resolves to whatever's checked out, and `-u`
// wires up `branch.<name>.{remote,merge}` so subsequent pulls/pushes
// don't need an explicit remote.
export const publishCurrentBranchEffect = Effect.fn(
  "sync.publishCurrentBranch",
)(function* (worktreePath: string, projectPath: string) {
  const remotes = yield* listRemotesEffect(projectPath);
  const first = remotes[0];
  if (!first) {
    return yield* Effect.fail(new Error("No git remote configured"));
  }
  yield* runEffect(worktreePath, ["push", "-u", first, "HEAD"]);
});

// Try rebase first for linear history; on a per-commit conflict abort
// and fall back to a whole-tree merge. Both abort paths swallow the
// abort failure so the worktree isn't left half-rebased or half-merged
// when the action propagates an error. `--end-of-options` keeps the ref
// out of the flag slot. Neither command accepts a trailing `--`, which
// they would read as a second revision argument. One uninterruptible
// step, since stopping between the rebase and its abort is exactly the
// half-rebased worktree the aborts exist to prevent.
function rebaseOrMergeAgainst(worktreePath: string, ref: string) {
  const merge = runEffect(worktreePath, [
    "merge",
    "--end-of-options",
    ref,
  ]).pipe(
    Effect.tapError(() =>
      Effect.ignore(runLenientEffect(worktreePath, ["merge", "--abort"])),
    ),
  );
  return runEffect(worktreePath, ["rebase", "--end-of-options", ref]).pipe(
    Effect.catch(() =>
      Effect.ignore(runLenientEffect(worktreePath, ["rebase", "--abort"])).pipe(
        Effect.andThen(merge),
      ),
    ),
    Effect.asVoid,
    Effect.uninterruptible,
  );
}

// Combined resolution for the "diverged but mergeable" state. The
// `merge-tree --write-tree` probe (gating this state) already validated
// the whole-tree merge as clean, which is what makes the merge fallback
// safe. fetch, then rebase/merge, then push: sequential by nature. The
// rebase or merge is the uninterruptible step; the push is a network
// wait a caller who left may end, and a branch rebased but not yet
// pushed is the ordinary "ahead" state the next sync resolves.
export const pullRebaseOrMergeAndPushEffect = Effect.fn(
  "sync.pullRebaseOrMergeAndPush",
)(function* (worktreePath: string) {
  yield* runEffect(worktreePath, ["fetch"]);
  yield* rebaseOrMergeAgainst(worktreePath, "@{u}");
  yield* runEffect(worktreePath, ["push"]);
});

// Fetch *all* remotes from the project root, not the worktree's tracked
// upstream: primaryRef can live on a different remote than the branch
// tracks (e.g. branch tracks fork/feat while primary is origin/main), so
// `git fetch` from the worktree would leave the rebase target stale.
// The shared in-flight fetch also dedupes against the focus-driven sweep.
export const syncWithPrimaryEffect = Effect.fn("sync.syncWithPrimary")(
  function* (worktreePath: string, projectPath: string, primaryRef: string) {
    yield* fetchAllRemotesEffect(projectPath);
    yield* rebaseOrMergeAgainst(worktreePath, primaryRef);
  },
);
