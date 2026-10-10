// Bringing another branch's work into a worktree's branch, the four
// ways git has: a merge commit, a fast-forward, a squash into one new
// commit, or the branch's own commits replayed on top (a rebase). The
// preview says beforehand how far apart the two are and which files
// would conflict. A merge, squash or rebase that conflicts stops there,
// for the Changes tab to settle and the banner to continue or abort
// (operation.ts).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  IntegrateMethod,
  MergePreview,
} from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import { onIndex } from "./changes";
import { GitRefusal, run, runLenient, splitZ } from "./core";
import {
  gitDirOf,
  hasStagedChanges,
  readOperation,
  refuseMidOperation,
} from "./operation";
import { countCommits, ownCommitCounts, refTip } from "./refs";

const resolveCommit = (worktreePath: string, ref: string) =>
  Effect.flatMap(refTip(worktreePath, `${ref}^{commit}`), (hash) =>
    hash
      ? Effect.succeed(hash)
      : Effect.fail(
          new GitRefusal({
            reason: `There is no branch or commit named ${ref}.`,
          }),
        ),
  );

export const readMergePreview = Effect.fnUntraced(function* (
  worktreePath: string,
  ref: string,
) {
  const target = yield* resolveCommit(worktreePath, ref);
  const [incoming, ownCounts, merged] = yield* Effect.all(
    [
      countCommits(worktreePath, [`HEAD..${target}`]),
      ownCommitCounts(worktreePath, target),
      // The tree a merge would make, then the paths it left conflicted.
      // Exit 1 on a conflict, so read leniently. Unrelated histories fail
      // outright, and the merge itself says why.
      runLenient(worktreePath, [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        "-z",
        "HEAD",
        target,
      ]),
    ],
    { concurrency: "unbounded" },
  );
  const incomingSubject =
    incoming === 1
      ? (yield* run(worktreePath, [
          "log",
          "-1",
          "--format=%s",
          target,
          "--",
        ])).trim()
      : null;
  const { own, merges, unpushed } = ownCounts;
  return {
    incoming,
    own,
    pushed: own - unpushed,
    ownMerges: merges,
    // Nothing printed, not even a tree: no merge to make at all.
    conflicts: merged === "" ? null : splitZ(merged).slice(1),
    incomingSubject,
  } satisfies MergePreview;
});

// Runs the move and reads a failure that left git waiting on the user
// (a merge or rebase on conflicts, a squash's conflicted files) as a
// stop rather than an error. Its callers refuse first while git already
// waits, so the stop found is this move's. Anything else, git's refusal over local
// edits in the way above all, still fails.
const stopsOnConflict = (worktreePath: string, args: string[]) =>
  run(worktreePath, args).pipe(
    Effect.as(false),
    Effect.catch((err) =>
      Effect.flatMap(readOperation(worktreePath), ({ operation, conflicted }) =>
        operation === null && conflicted === 0
          ? Effect.fail(err)
          : Effect.succeed(true),
      ),
    ),
  );

// A plain merge of `ref`, left stopped on its conflicts: the way on
// from a sync, from the primary branch or the upstream, that conflicts.
// Whether it stopped.
export const mergeKeepingConflicts = (worktreePath: string, ref: string) =>
  onIndex(
    worktreePath,
    Effect.andThen(
      refuseMidOperation(worktreePath),
      stopsOnConflict(worktreePath, [
        "merge",
        "--no-edit",
        "--ff",
        "--end-of-options",
        ref,
      ]),
    ),
  );

// Whether it stopped on conflicts. A squash commits with `message`
// once its changes are in, the message kept in SQUASH_MSG for the
// continue to commit with where the commit can't be made yet.
export const mergeBranch = (
  worktreePath: string,
  ref: string,
  method: IntegrateMethod,
  message: string | undefined,
) =>
  onIndex(
    worktreePath,
    Effect.gen(function* () {
      yield* refuseMidOperation(worktreePath);
      yield* resolveCommit(worktreePath, ref);
      switch (method) {
        case "fastForward":
          yield* run(worktreePath, [
            "merge",
            "--ff-only",
            "--end-of-options",
            ref,
          ]);
          return false;
        case "merge":
          return yield* stopsOnConflict(worktreePath, [
            "merge",
            "--no-ff",
            "--no-edit",
            "--end-of-options",
            ref,
          ]);
        case "rebase":
          return yield* stopsOnConflict(worktreePath, [
            "rebase",
            "--end-of-options",
            ref,
          ]);
        case "squash": {
          if (!message) {
            return yield* new GitRefusal({
              reason: "A squash needs a commit message.",
            });
          }
          // `--ff` over a `merge.ff` setting, which `--squash` can't take.
          const stopped = yield* stopsOnConflict(worktreePath, [
            "merge",
            "--squash",
            "--ff",
            "--end-of-options",
            ref,
          ]);
          // The message waits where the continue reads it, should the
          // commit stop too: on a conflict, or a hook refusing it.
          const squashMessage = join(
            yield* gitDirOf(worktreePath),
            "SQUASH_MSG",
          );
          yield* Effect.promise(() => writeFile(squashMessage, `${message}\n`));
          if (stopped) return true;
          if (!(yield* hasStagedChanges(worktreePath))) {
            yield* run(worktreePath, ["reset", "--merge"]);
            return yield* new GitRefusal({
              reason: `Everything on ${ref} is already on this branch.`,
            });
          }
          yield* run(worktreePath, ["commit", "--file", squashMessage]);
          return false;
        }
      }
    }),
  );
