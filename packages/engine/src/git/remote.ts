// Git's remote: fetching, pulling and pushing, and the syncs with the upstream and the primary branch.
import { SyncConflictsError } from "@shigomori/contracts/errors";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { GitRefusedError, NoRemoteError } from "./documents.ts";
import type { GitIndexArea } from "./gitIndex.ts";
import type { MergingArea } from "./merging.ts";
import type { OperationArea } from "./operation.ts";
import type { RefsArea } from "./refs.ts";
import type { RunningArea } from "./running.ts";
import type { WorktreeVerbsArea } from "./worktreeVerbs.ts";

export const makeRemote = ({
  running,
  worktreeVerbs,
  refs,
  operation,
  gitIndex,
  merging,
}: {
  readonly running: RunningArea;
  readonly worktreeVerbs: WorktreeVerbsArea;
  readonly refs: RefsArea;
  readonly operation: OperationArea;
  readonly gitIndex: GitIndexArea;
  readonly merging: MergingArea;
}) =>
  Effect.gen(function* () {
    const { run, runLenient } = running;
    const { listRemotes } = worktreeVerbs;
    // Overlapping callers share the one in flight, and nothing is kept
    // after it.
    const fetches = yield* Cache.make({
      lookup: (repo: string) =>
        run(repo, ["fetch", "--all", "--quiet", "--prune"]),
      capacity: Number.POSITIVE_INFINITY,
      timeToLive: 0,
    });
    const fetchAll = Effect.fn("Git.fetchAll")(function* (repo: string) {
      yield* Cache.get(fetches, repo);
    });

    // Whether a rebase onto `ref` only replays commits that exist nowhere
    // else, in one line: none of them a merge (a rebase would flatten it)
    // or on a remote already (replayed, the branch would split from its
    // pushed copy).
    const rebaseIsSafe = (worktree: string, ref: string) =>
      refs
        .ownCommitCounts(worktree, ref)
        .pipe(
          Effect.map(
            ({ own, merges, unpushed }) => merges === 0 && unpushed === own,
          ),
        );

    // The upstream by its name ("origin/feature"), for a merge to say it
    // by in its message and its conflict markers rather than as "@{u}".
    const upstreamRef = (worktree: string) =>
      refs
        .upstreamName(worktree)
        .pipe(Effect.map(Option.getOrElse(() => "@{u}")));

    // A rebase for linear history where that is safe (rebaseIsSafe), and
    // a whole-tree merge otherwise or on a per-commit conflict. Each
    // merge passes `--ff`, git's own default, over a `merge.ff` setting
    // that would refuse it. Both abort paths swallow the abort's failure
    // so the worktree isn't left half-rebased or half-merged when the
    // move fails. A merge that conflicts fails with SyncConflictsError,
    // which the page offers the merge kept on its conflicts for. Neither
    // command takes a trailing `--`, which it would read as a second
    // revision.
    const rebaseOrMerge = (worktree: string, ref: string) =>
      Effect.gen(function* () {
        if (yield* rebaseIsSafe(worktree, ref)) {
          const rebased = yield* run(worktree, [
            "rebase",
            "--end-of-options",
            ref,
          ]).pipe(
            Effect.as(true),
            Effect.catch(() =>
              runLenient(worktree, ["rebase", "--abort"]).pipe(
                Effect.as(false),
              ),
            ),
          );
          if (rebased) return;
        }
        yield* run(worktree, ["merge", "--ff", "--end-of-options", ref]).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              // Git reports conflicts on stdout, so the files say it.
              const conflicted =
                (yield* operation.conflictedPaths(worktree)).length > 0;
              yield* runLenient(worktree, ["merge", "--abort"]);
              return yield* conflicted
                ? Effect.fail(new SyncConflictsError({ ref }))
                : Effect.fail(error);
            }),
          ),
        );
      });

    // The diverged-but-mergeable resolution: fetch, rebase or merge onto
    // the upstream, push. The merge-tree probe that offers this already
    // found the whole-tree merge clean.
    const pullRebaseOrMergeAndPush = Effect.fn("Git.pullRebaseOrMergeAndPush")(
      function* (worktree: string) {
        yield* run(worktree, ["fetch"]);
        yield* rebaseOrMerge(worktree, yield* upstreamRef(worktree));
        yield* run(worktree, ["push"]);
      },
    );

    // Every remote is fetched from the project, not the worktree's
    // tracked upstream: the primary can live on another remote than the
    // branch tracks, and `git fetch` from the worktree would leave it
    // stale.
    const syncWithPrimary = Effect.fn("Git.syncWithPrimary")(function* (input: {
      readonly worktree: string;
      readonly repo: string;
      readonly primaryRef: string;
    }) {
      yield* fetchAll(input.repo);
      yield* rebaseOrMerge(input.worktree, input.primaryRef);
    });

    // The ways on from a sync that conflicts, from the upstream or from
    // the primary branch: the merge, left stopped on its conflicts for
    // the Changes tab to settle and the banner to continue or abort. Any
    // other refusal (local edits in the way) still fails. Whether it
    // stopped.
    const mergeUpstreamKeepingConflicts = Effect.fn(
      "Git.mergeUpstreamKeepingConflicts",
    )(function* (worktree: string) {
      yield* run(worktree, ["fetch"]);
      return yield* merging.mergeKeepingConflicts(
        worktree,
        yield* upstreamRef(worktree),
      );
    });

    const mergePrimaryKeepingConflicts = Effect.fn(
      "Git.mergePrimaryKeepingConflicts",
    )(function* (input: {
      readonly worktree: string;
      readonly repo: string;
      readonly primaryRef: string;
    }) {
      yield* fetchAll(input.repo);
      return yield* merging.mergeKeepingConflicts(
        input.worktree,
        input.primaryRef,
      );
    });

    // Uncommitted changes, untracked files included whatever the user's
    // `status.showUntrackedFiles` says: what a reset or a fast-forward
    // would land on.
    const hasUncommittedOrUntracked = Effect.fn(
      "Git.hasUncommittedOrUntracked",
    )(function* (worktree: string) {
      return (
        (yield* run(worktree, [
          "status",
          "--porcelain=v1",
          "--untracked-files=normal",
        ])).trim().length > 0
      );
    });

    // Throws away the local divergence and snaps to the upstream: fetch
    // first, so `@{u}` is the remote's tip, then look at the tree again
    // right before the reset. The page offers this on a clean worktree,
    // but decides that from a count another process can make stale, and
    // a `reset --hard` past uncommitted work leaves nothing to recover.
    // An ignored file the upstream tracks is resetHard's to refuse.
    const overwriteFromUpstream = Effect.fn("Git.overwriteFromUpstream")(
      function* (worktree: string) {
        yield* run(worktree, ["fetch"]);
        if (yield* hasUncommittedOrUntracked(worktree)) {
          return yield* new GitRefusedError({
            reason:
              "This worktree has uncommitted or untracked changes. Commit, stash, or discard them before overwriting from upstream.",
          });
        }
        // By its full name: a branch or tag called "origin/feature" would
        // shadow the short one.
        const upstream = (yield* run(worktree, [
          "rev-parse",
          "--symbolic-full-name",
          "@{u}",
        ])).trim();
        yield* gitIndex.resetHard({ worktree, ref: upstream });
      },
    );

    const publish = Effect.fn("Git.publish")(function* (input: {
      readonly worktree: string;
      readonly repo: string;
    }) {
      const [first] = yield* listRemotes(input.repo);
      if (first === undefined) return yield* new NoRemoteError();
      yield* run(input.worktree, ["push", "-u", first, "HEAD"]);
    });

    return {
      fetchAll,
      pullRebaseOrMergeAndPush,
      syncWithPrimary,
      mergeUpstreamKeepingConflicts,
      mergePrimaryKeepingConflicts,
      hasUncommittedOrUntracked,
      overwriteFromUpstream,
      publish,
    };
  });
