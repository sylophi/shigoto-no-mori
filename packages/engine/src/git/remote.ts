// Git's remote: fetching, pulling and pushing.
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { splitZ } from "../gitParse.ts";
import {
  CloneDestinationError,
  GitCommandError,
  NoRemoteError,
  OverwriteRefusedError,
  SHOWN,
  redactUserinfo,
  stderrOf,
} from "./documents.ts";
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
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
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

    const clone = Effect.fn("Git.clone")(function* (input: {
      readonly url: string;
      readonly parentDir: string;
      readonly name: string;
    }) {
      // Both checks are for the message: git would refuse either, in
      // words about its own argv.
      const parent = yield* fs.stat(input.parentDir).pipe(Effect.option);
      if (Option.isNone(parent) || parent.value.type !== "Directory") {
        return yield* new CloneDestinationError({
          path: input.parentDir,
          reason: "not-a-folder",
        });
      }
      const dest = path.join(input.parentDir, input.name);
      if (yield* fs.exists(dest).pipe(Effect.orElseSucceed(() => false))) {
        return yield* new CloneDestinationError({
          path: dest,
          reason: "exists",
        });
      }
      // Nobody may be at a terminal to answer a credential prompt (least
      // of all for a clone asked for from another device), so git's own
      // is off and an unauthenticated remote fails rather than waits.
      yield* run(input.parentDir, ["clone", "--", input.url, input.name], {
        env: { GIT_TERMINAL_PROMPT: "0" },
      }).pipe(
        Effect.mapError((error) =>
          error instanceof GitCommandError
            ? new GitCommandError({
                subcommand: error.subcommand,
                exitCode: error.exitCode,
                cause: new Error(redactUserinfo(stderrOf(error))),
              })
            : error,
        ),
      );
      return dest;
    });

    return { fetchAll, rebaseOrMerge, overwriteFromUpstream, publish, clone };
  });

export type RemoteArea = Effect.Success<ReturnType<typeof makeRemote>>;
