// Remote sync mutations. Each operates on a single worktree's checkout
// and lets `git` surface any failure as a non-zero exit (which `run`
// fails with git's own words, which the IPC layer relays verbatim into
// the renderer's toast).
import { SyncConflictsError } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import { chunked, GitRefusal, run, runLenient, splitZ } from "./core";
import { mergeKeepingConflicts } from "./merge";
import { conflictedPaths } from "./operation";
import { ownCommitCounts, upstreamName } from "./refs";
import { fetchAllRemotes, listRemotes } from "./remotes";

export const pushFastForward = (worktreePath: string) =>
  Effect.asVoid(run(worktreePath, ["push"]));

export const pullFastForward = (worktreePath: string) =>
  Effect.asVoid(run(worktreePath, ["pull", "--ff-only"]));

export const pushForceWithLease = (worktreePath: string) =>
  Effect.asVoid(run(worktreePath, ["push", "--force-with-lease"]));

// Fast-forward onto the already-fetched upstream, no network. What the
// auto-pull sweep runs right after the app's own fetch, where a `pull`
// would fetch a second time. `--ff-only` refuses anything but a plain
// fast-forward, so a commit that raced the caller's checks fails the
// merge rather than producing a merge commit nobody asked for.
export const fastForwardToUpstream = (worktreePath: string) =>
  Effect.asVoid(run(worktreePath, ["merge", "--ff-only", "@{u}"]));

// Uncommitted changes, untracked files included. Pinned to
// `--untracked-files=normal` against a user-level
// `status.showUntrackedFiles = no`: the guards below decide whether a
// tree can be overwritten or fast-forwarded, and an untracked file the
// upstream now tracks is exactly what those would land on.
// The row's change count (Git.workingTreeChanges in the engine)
// deliberately does NOT pin it. It runs per worktree on every window
// focus, and `-uno` is a
// setting people choose to make exactly that scan cheap. The only cost
// of the mismatch is a button showing when the guard will refuse, and
// the guard still refuses.
export const hasUncommittedOrUntracked = (worktreePath: string) =>
  Effect.map(
    run(worktreePath, ["status", "--porcelain=v1", "--untracked-files=normal"]),
    (status) => status.trim().length > 0,
  );

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
export const overwriteFromUpstream = Effect.fnUntraced(function* (
  worktreePath: string,
) {
  yield* run(worktreePath, ["fetch"]);
  if (yield* hasUncommittedOrUntracked(worktreePath)) {
    return yield* new GitRefusal({
      reason:
        "This worktree has uncommitted or untracked changes. Commit, stash, or discard them before overwriting from upstream.",
    });
  }
  const addedUpstream = splitZ(
    yield* run(worktreePath, [
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
      run(worktreePath, [
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
    return yield* new GitRefusal({
      reason: `Overwriting would replace ignored local file(s) the upstream branch tracks: ${shown}${rest}. Move them aside first.`,
    });
  }
  yield* run(worktreePath, ["reset", "--hard", "@{u}"]);
});

// Publish: push the current branch to the first configured remote with
// upstream tracking. `HEAD` resolves to whatever's checked out, and `-u`
// wires up `branch.<name>.{remote,merge}` so subsequent pulls/pushes
// don't need an explicit remote.
export const publishCurrentBranch = Effect.fnUntraced(function* (
  worktreePath: string,
  projectPath: string,
) {
  const remotes = yield* listRemotes(projectPath);
  const first = remotes[0];
  if (!first) {
    return yield* new GitRefusal({ reason: "No git remote configured" });
  }
  yield* run(worktreePath, ["push", "-u", first, "HEAD"]);
});

// Whether a rebase onto `ref` only replays commits that exist nowhere
// else, in one line: none of them a merge (a rebase would flatten it)
// or on a remote already (replayed, the branch would split from its
// pushed copy).
const rebaseIsSafe = (worktreePath: string, ref: string) =>
  Effect.map(
    ownCommitCounts(worktreePath, ref),
    ({ own, merges, unpushed }) => merges === 0 && unpushed === own,
  );

// The upstream by its name ("origin/feature"), for a merge to say it
// by in its message and its conflict markers rather than as "@{u}".
const upstreamRef = (worktreePath: string) =>
  Effect.map(upstreamName(worktreePath), (name) => name ?? "@{u}");

// A rebase for linear history where that is safe (rebaseIsSafe), and a
// whole-tree merge otherwise or on a per-commit conflict. Each merge
// here passes `--ff`, git's own default, over a `merge.ff` setting that
// would refuse it. Both abort paths swallow the abort failure so the
// worktree isn't left half-rebased or half-merged when the action
// propagates an error. `--end-of-options` keeps the ref out of the flag
// slot. Neither command accepts a
// trailing `--`, which they would read as a second revision argument.
const rebaseOrMergeAgainst = Effect.fnUntraced(function* (
  worktreePath: string,
  ref: string,
) {
  if (yield* rebaseIsSafe(worktreePath, ref)) {
    const rebased = yield* run(worktreePath, [
      "rebase",
      "--end-of-options",
      ref,
    ]).pipe(
      Effect.as(true),
      Effect.catch(() =>
        Effect.as(runLenient(worktreePath, ["rebase", "--abort"]), false),
      ),
    );
    if (rebased) return;
  }
  yield* run(worktreePath, ["merge", "--ff", "--end-of-options", ref]).pipe(
    Effect.catch((err) =>
      Effect.gen(function* () {
        // Git reports conflicts on stdout, so the files say it instead.
        const conflicted = (yield* conflictedPaths(worktreePath)).length > 0;
        yield* runLenient(worktreePath, ["merge", "--abort"]);
        return yield* conflicted ? new SyncConflictsError({ ref }) : err;
      }),
    ),
  );
});

// Combined resolution for the "diverged but mergeable" state. The
// `merge-tree --write-tree` probe (gating this state) already validated
// the whole-tree merge as clean, which is what makes the merge fallback
// safe. Fetch, then rebase or merge, then push, in that order.
export const pullRebaseOrMergeAndPush = Effect.fnUntraced(function* (
  worktreePath: string,
) {
  yield* run(worktreePath, ["fetch"]);
  yield* rebaseOrMergeAgainst(worktreePath, yield* upstreamRef(worktreePath));
  yield* run(worktreePath, ["push"]);
});

// Fetch *all* remotes from the project root, not the worktree's tracked
// upstream: primaryRef can live on a different remote than the branch
// tracks (e.g. branch tracks fork/feat while primary is origin/main), so
// `git fetch` from the worktree would leave the rebase target stale.
// The coalescing helper also dedupes against the focus-driven sweep.
export const syncWithPrimary = (
  worktreePath: string,
  projectPath: string,
  primaryRef: string,
) =>
  Effect.andThen(
    fetchAllRemotes(projectPath),
    rebaseOrMergeAgainst(worktreePath, primaryRef),
  );

// The ways on from a sync that conflicts, from the upstream or from
// the primary branch: the merge, left stopped on its conflicts for the
// Changes tab to settle and the banner to continue or abort. Any other
// refusal (local edits in the way) still fails. Whether it stopped.
export const mergeUpstreamKeepingConflicts = Effect.fnUntraced(function* (
  worktreePath: string,
) {
  yield* run(worktreePath, ["fetch"]);
  return yield* mergeKeepingConflicts(
    worktreePath,
    yield* upstreamRef(worktreePath),
  );
});

export const mergePrimaryKeepingConflicts = (
  worktreePath: string,
  projectPath: string,
  primaryRef: string,
) =>
  Effect.andThen(
    fetchAllRemotes(projectPath),
    mergeKeepingConflicts(worktreePath, primaryRef),
  );
