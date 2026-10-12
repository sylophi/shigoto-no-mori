// Git's merges: bringing another branch's work into a worktree's
// branch, the four ways git has (a merge commit, a fast-forward, a
// squash into one new commit, or the branch's own commits replayed on
// top), and the preview that says beforehand how far apart the two are
// and which files would conflict. A merge, squash or rebase that
// conflicts stops there, for the Changes tab to settle and the banner
// to continue or abort (operation.ts).
import type {
  IntegrateMethod,
  MergePreview,
} from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { splitZ } from "../gitParse.ts";
import { GitRefusedError } from "./documents.ts";
import type { OperationArea } from "./operation.ts";
import type { RefsArea } from "./refs.ts";
import type { RunningArea } from "./running.ts";

export const makeMerging = ({
  running,
  refs,
  operation,
}: {
  readonly running: RunningArea;
  readonly refs: RefsArea;
  readonly operation: OperationArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { run, runLenient, onIndex } = running;
    const { resolveCommit, countCommits, ownCommitCounts } = refs;
    const { readOperation, refuseMidOperation, gitDir, hasStagedChanges } =
      operation;

    // `countsOnly` leaves out the merge's conflicts and the incoming
    // subject, for a move that makes no merge (a hard reset): the trial
    // merge is the slow part.
    const readMergePreview = Effect.fn("Git.readMergePreview")(function* (
      worktree: string,
      ref: string,
      countsOnly = false,
    ) {
      const target = yield* resolveCommit(worktree, ref);
      const [incoming, ownCounts, merged] = yield* Effect.all(
        [
          countCommits(worktree, [`HEAD..${target}`]),
          ownCommitCounts(worktree, target),
          // The tree a merge would make, then the paths it left
          // conflicted. Exit 1 on a conflict, so read leniently.
          // Unrelated histories fail outright, and the merge itself says
          // why.
          countsOnly
            ? Effect.succeed("")
            : runLenient(worktree, [
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
        incoming === 1 && !countsOnly
          ? (yield* run(worktree, [
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

    // Runs the move and reads a failure that left git waiting on the
    // user (a merge or rebase on conflicts, a squash's conflicted files)
    // as a stop rather than an error. Its callers refuse first while git
    // already waits, so the stop found is this move's. Anything else,
    // git's refusal over local edits in the way above all, still fails.
    const stopsOnConflict = (worktree: string, args: readonly string[]) =>
      run(worktree, args).pipe(
        Effect.as(false),
        Effect.catch((error) =>
          readOperation(worktree).pipe(
            Effect.flatMap(({ operation: under, conflicted }) =>
              under === null && conflicted === 0
                ? Effect.fail(error)
                : Effect.succeed(true),
            ),
          ),
        ),
      );

    // A plain merge of `ref`, left stopped on its conflicts: the way on
    // from a sync, from the primary branch or the upstream, that
    // conflicts. Whether it stopped.
    const mergeKeepingConflicts = Effect.fn("Git.mergeKeepingConflicts")(
      function* (worktree: string, ref: string) {
        return yield* onIndex(
          worktree,
          refuseMidOperation(worktree).pipe(
            Effect.andThen(
              stopsOnConflict(worktree, [
                "merge",
                "--no-edit",
                "--ff",
                "--end-of-options",
                ref,
              ]),
            ),
          ),
        );
      },
    );

    // Whether it stopped on conflicts. A squash commits with `message`
    // once its changes are in, the message kept in SQUASH_MSG for the
    // continue to commit with where the commit can't be made yet.
    const mergeBranch = Effect.fn("Git.mergeBranch")(function* (input: {
      readonly worktree: string;
      readonly ref: string;
      readonly method: IntegrateMethod;
      readonly message?: string | undefined;
    }) {
      const { worktree, ref, method, message } = input;
      return yield* onIndex(
        worktree,
        Effect.gen(function* () {
          yield* refuseMidOperation(worktree);
          yield* resolveCommit(worktree, ref);
          switch (method) {
            case "fastForward":
              yield* run(worktree, [
                "merge",
                "--ff-only",
                "--end-of-options",
                ref,
              ]);
              return false;
            case "merge":
              return yield* stopsOnConflict(worktree, [
                "merge",
                "--no-ff",
                "--no-edit",
                "--end-of-options",
                ref,
              ]);
            case "rebase":
              return yield* stopsOnConflict(worktree, [
                "rebase",
                "--end-of-options",
                ref,
              ]);
            case "squash": {
              if (!message) {
                return yield* new GitRefusedError({
                  reason: "A squash needs a commit message.",
                });
              }
              // `--ff` over a `merge.ff` setting, which `--squash` can't
              // take.
              const stopped = yield* stopsOnConflict(worktree, [
                "merge",
                "--squash",
                "--ff",
                "--end-of-options",
                ref,
              ]);
              // The message waits where the continue reads it, should the
              // commit stop too: on a conflict, or a hook refusing it.
              const squashMessage = path.join(
                yield* gitDir(worktree),
                "SQUASH_MSG",
              );
              yield* fs.writeFileString(squashMessage, `${message}\n`);
              if (stopped) return true;
              if (!(yield* hasStagedChanges(worktree))) {
                yield* run(worktree, ["reset", "--merge"]);
                return yield* new GitRefusedError({
                  reason: `Everything on ${ref} is already on this branch.`,
                });
              }
              yield* run(worktree, ["commit", "--file", squashMessage]);
              return false;
            }
          }
        }),
      );
    });

    return { readMergePreview, mergeKeepingConflicts, mergeBranch };
  });

export type MergingArea = Effect.Success<ReturnType<typeof makeMerging>>;
