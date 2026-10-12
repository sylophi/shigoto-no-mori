// Git's remote: fetching, pulling and pushing.
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import { splitZ } from "../gitParse.ts";
import { NoRemoteError, OverwriteRefusedError, SHOWN } from "./documents.ts";
import type { RunningArea } from "./running.ts";
import type { WorktreeVerbsArea } from "./worktreeVerbs.ts";
import type { WorkingTreeArea } from "./workingTree.ts";

export const makeRemote = ({
  running,
  worktreeVerbs,
  workingTree,
}: {
  readonly running: RunningArea;
  readonly worktreeVerbs: WorktreeVerbsArea;
  readonly workingTree: WorkingTreeArea;
}) =>
  Effect.gen(function* () {
    const { run, runChunked } = running;
    const { listRemotes } = worktreeVerbs;
    const { status } = workingTree;
    // --- the remote ---

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

    // Tries a rebase first for linear history. A conflicting commit
    // aborts it for a whole-tree merge, and a failed merge is aborted
    // too, so the worktree is never left half done. Uninterruptible for
    // the same reason: a rebase killed midway leaves the worktree in one,
    // and this is local work that ends on its own. Neither command takes
    // a trailing `--`, which they would read as a second revision.
    const rebaseOrMerge = (worktree: string, ref: string) =>
      run(worktree, ["rebase", "--end-of-options", ref]).pipe(
        Effect.catch(() =>
          Effect.ignore(run(worktree, ["rebase", "--abort"])).pipe(
            Effect.andThen(run(worktree, ["merge", "--end-of-options", ref])),
            Effect.tapError(() =>
              Effect.ignore(run(worktree, ["merge", "--abort"])),
            ),
          ),
        ),
        Effect.asVoid,
        Effect.uninterruptible,
      );

    const overwriteFromUpstream = Effect.fn("Git.overwriteFromUpstream")(
      function* (worktree: string) {
        yield* run(worktree, ["fetch"]);
        // The page offers this on a clean worktree, but decides that from a
        // count another process can make stale, and `reset --hard` past
        // uncommitted work leaves nothing to recover.
        const dirty = yield* status(worktree, "normal");
        if (dirty.length > 0) {
          return yield* new OverwriteRefusedError({
            reason: "uncommitted",
            paths: [],
            count: dirty.length,
          });
        }
        // Ignored files never show in status, but `reset --hard` overwrites
        // one wherever the upstream tracks a file at its path, and its
        // content was never in git. With the tree clean, the paths that can
        // collide are the upstream's added files. git says which of those
        // are ignored files here, which a plain exists check would get
        // wrong for a case-only rename on a case-insensitive disk.
        // --no-renames: an upstream rename's destination is an addition.
        const added = splitZ(
          yield* run(worktree, [
            "diff",
            "--name-only",
            "--no-renames",
            "--diff-filter=A",
            "-z",
            "HEAD",
            "@{u}",
          ]),
        );
        const collisions = (yield* runChunked(
          worktree,
          ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"],
          added,
        )).flatMap(splitZ);
        if (collisions.length > 0) {
          return yield* new OverwriteRefusedError({
            reason: "ignored-files",
            paths: collisions.slice(0, SHOWN),
            count: collisions.length,
          });
        }
        // A reset killed midway leaves a half-written tree.
        yield* Effect.uninterruptible(
          run(worktree, ["reset", "--hard", "@{u}"]),
        );
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

    return { fetchAll, rebaseOrMerge, overwriteFromUpstream, publish };
  });

export type RemoteArea = Effect.Success<ReturnType<typeof makeRemote>>;
