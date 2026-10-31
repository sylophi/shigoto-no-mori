// Git's operation state: a worktree stopped in the middle of a merge, a
// rebase, a cherry-pick, a revert or a squash waiting on conflicts, and
// the moves that see it through (settle each conflicted file, then
// continue or abort).
import type { GitOperationState } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { splitZ } from "../gitParse.ts";
import { GitRefusedError, stderrOf } from "./documents.ts";
import { type RunningArea, waitingForIndex } from "./running.ts";

// The files git leaves in a worktree's own git dir while an operation
// waits on the user, in the order they are named when several are
// there (a cherry-pick sequence has both CHERRY_PICK_HEAD and the
// sequencer directory, and the first says more). rebase-apply is also
// `git am`'s, which marks itself with an `applying` file inside.
const OPERATION_MARKERS: { path: string; operation: string }[] = [
  { path: "rebase-merge", operation: "rebase" },
  { path: "rebase-apply/applying", operation: "git am" },
  { path: "rebase-apply", operation: "rebase" },
  { path: "MERGE_HEAD", operation: "merge" },
  { path: "CHERRY_PICK_HEAD", operation: "cherry-pick" },
  { path: "REVERT_HEAD", operation: "revert" },
  { path: "sequencer", operation: "cherry-pick or revert" },
  { path: "BISECT_LOG", operation: "bisect" },
];

// The kinds the banner can continue. The rest (`git am`, a bisect, a
// bare sequencer) it can only abort.
const CONTINUABLE = new Set([
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "squash",
]);

// The editor stays shut: a continue takes the message git prepared.
const NO_EDITOR = { env: { GIT_EDITOR: "true" } };

export const makeOperation = ({ running }: { readonly running: RunningArea }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { run, onIndex, refreshIndex } = running;

    const there = (file: string) =>
      fs.exists(file).pipe(Effect.orElseSucceed(() => false));

    const gitDir = Effect.fn("Git.gitDir")(function* (worktree: string) {
      return (yield* run(worktree, ["rev-parse", "--absolute-git-dir"])).trim();
    });

    const conflictedPaths = Effect.fn("Git.conflictedPaths")(function* (
      worktree: string,
    ) {
      return splitZ(
        // diff-files, which never writes the index back (see the runner).
        yield* run(worktree, [
          "diff-files",
          "--name-only",
          "--diff-filter=U",
          "-z",
        ]),
      );
    });

    const hasStagedChanges = Effect.fn("Git.hasStagedChanges")(function* (
      worktree: string,
    ) {
      return (
        (yield* run(worktree, ["diff", "--cached", "--name-only", "-z"])) !== ""
      );
    });

    // The operation under way in the worktree whose git dir this is, or
    // null. One listing of the git dir answers all of them, bar the one
    // marker inside rebase-apply, looked at only when that is there.
    const operationInProgress = Effect.fn("Git.operationInProgress")(function* (
      dir: string,
    ) {
      const names = new Set(
        yield* fs
          .readDirectory(dir)
          .pipe(Effect.orElseSucceed((): string[] => [])),
      );
      if (
        names.has("rebase-apply") &&
        (yield* there(path.join(dir, "rebase-apply", "applying")))
      ) {
        names.add("rebase-apply/applying");
      }
      return (
        OPERATION_MARKERS.find(({ path: marker }) => names.has(marker))
          ?.operation ?? null
      );
    });

    // A command of the app's that git stopped part-way (a conflict, or
    // another program's git holding index.lock) is undone, the abort
    // waiting a held lock out as a one-step write does. One refused
    // before it began has nothing to undo, and one that can't be undone
    // is left for the banner. Callers refuse an operation already under way
    // first (refuseMidOperation), so the stop is theirs.
    const undoStopped = Effect.fn("Git.undoStopped")(function* (
      worktree: string,
      verb: "rebase" | "merge" | "revert" | "cherry-pick",
    ) {
      if ((yield* operationInProgress(yield* gitDir(worktree))) !== verb) {
        return;
      }
      yield* refreshIndex(worktree);
      yield* waitingForIndex(run(worktree, [verb, "--abort"])).pipe(
        Effect.mapError(
          () =>
            new GitRefusedError({
              reason: `The ${verb} stopped part-way and couldn't be undone, so the worktree is still in it. Continue or abort it from the banner.`,
            }),
        ),
      );
    });

    // `merge --squash` leaves no MERGE_HEAD, only the message it made in
    // SQUASH_MSG, which a commit or a reset clears but a discard of the
    // files doesn't. So it is a squash under way only while the index
    // holds one: conflicted, or staged and not yet committed. Otherwise
    // the message is git's leftover, and is cleared here so staged work
    // later on doesn't read as the squash.
    const squashPending = (worktree: string, dir: string, conflicted: number) =>
      Effect.gen(function* () {
        const message = path.join(dir, "SQUASH_MSG");
        if (!(yield* there(message))) return false;
        if (conflicted > 0 || (yield* hasStagedChanges(worktree))) return true;
        yield* fs.remove(message, { force: true });
        return false;
      });

    // The branch a rebase replays, which git keeps in its state dir while
    // HEAD is detached for the replay. Null when none is under way.
    const rebasingBranch = (dir: string) =>
      Effect.gen(function* () {
        const names = yield* Effect.forEach(
          ["rebase-merge", "rebase-apply"],
          (state) =>
            fs.readFileString(path.join(dir, state, "head-name")).pipe(
              Effect.map((text) => text.trim()),
              Effect.orElseSucceed(() => ""),
            ),
          { concurrency: 2 },
        );
        const name = names.find((n) => n.startsWith("refs/heads/"));
        return name === undefined ? null : name.slice("refs/heads/".length);
      });

    const readOperation = Effect.fn("Git.readOperation")(function* (
      worktree: string,
    ) {
      const [dir, conflictedList] = yield* Effect.all(
        [gitDir(worktree), conflictedPaths(worktree)],
        { concurrency: 2 },
      );
      const conflicted = conflictedList.length;
      const operation =
        (yield* operationInProgress(dir)) ??
        ((yield* squashPending(worktree, dir, conflicted)) ? "squash" : null);
      return {
        operation,
        continuable: operation !== null && CONTINUABLE.has(operation),
        conflicted,
        rebasing: operation === "rebase" ? yield* rebasingBranch(dir) : null,
      } satisfies GitOperationState;
    });

    // Refuses a move that rewrites history, makes a commit or starts a
    // merge while git waits on the user mid-operation or over conflicted
    // files, where git might go along with it, or refuse in a way that
    // reads like the move's own stop.
    const refuseMidOperation = Effect.fn("Git.refuseMidOperation")(function* (
      worktree: string,
    ) {
      const { operation, conflicted } = yield* readOperation(worktree);
      if (operation !== null) {
        return yield* new GitRefusedError({
          reason: `Finish or abort the ${operation} first.`,
        });
      }
      if (conflicted > 0) {
        return yield* new GitRefusedError({
          reason: "Resolve the conflicted files first.",
        });
      }
    });

    const continueOperation = Effect.fn("Git.continueOperation")(function* (
      worktree: string,
    ) {
      yield* onIndex(
        worktree,
        Effect.gen(function* () {
          const { operation, conflicted } = yield* readOperation(worktree);
          if (conflicted > 0) {
            return yield* new GitRefusedError({
              reason: "Resolve the conflicted files first.",
            });
          }
          switch (operation) {
            // Strip, or the "# Conflicts:" list git adds to the message
            // stays in it, as an editor would have dropped it.
            case "merge":
              yield* run(
                worktree,
                ["commit", "--no-edit", "--cleanup=strip"],
                NO_EDITOR,
              );
              return;
            case "squash":
              yield* run(worktree, [
                "commit",
                "--file",
                path.join(yield* gitDir(worktree), "SQUASH_MSG"),
              ]);
              return;
            case "rebase":
              yield* run(worktree, ["rebase", "--continue"], NO_EDITOR);
              return;
            // A pick or revert that came out empty once its conflicts
            // were settled is skipped, as a rebase drops one: git won't
            // commit it.
            case "cherry-pick":
            case "revert":
              if (!(yield* hasStagedChanges(worktree))) {
                yield* run(worktree, [operation, "--skip"]);
                return;
              }
              yield* run(worktree, [operation, "--continue"], NO_EDITOR);
              return;
            default:
              return yield* new GitRefusedError({
                reason: "There is nothing here to continue.",
              });
          }
        }),
      );
    });

    const abortOperation = Effect.fn("Git.abortOperation")(function* (
      worktree: string,
    ) {
      yield* onIndex(
        worktree,
        Effect.gen(function* () {
          const { operation } = yield* readOperation(worktree);
          yield* refreshIndex(worktree);
          switch (operation) {
            case "merge":
            case "rebase":
            case "cherry-pick":
            case "revert":
              yield* run(worktree, [operation, "--abort"]);
              return;
            case "git am":
              yield* run(worktree, ["am", "--abort"]);
              return;
            case "squash":
              yield* run(worktree, ["reset", "--merge"]);
              return;
            case "bisect":
              yield* run(worktree, ["bisect", "reset"]);
              return;
            case "cherry-pick or revert":
              yield* run(worktree, ["cherry-pick", "--abort"]);
              return;
            default:
              return yield* new GitRefusedError({
                reason: "There is nothing here to abort.",
              });
          }
        }),
      );
    });

    // Settles one conflicted file with one side's version, or as it
    // stands, and stages it. The path came out of `git status`, so it is
    // a filename and never a pattern. "mine" is the branch the worktree
    // is on, which git calls "ours" everywhere but a rebase: there HEAD
    // is the branch being replayed onto and "theirs" is the worktree's
    // own commit. A side that deleted the file settles it as a removal.
    const resolveConflict = Effect.fn("Git.resolveConflict")(function* (input: {
      readonly worktree: string;
      readonly path: string;
      readonly side: "mine" | "theirs" | "as-is";
    }) {
      const { worktree, path: file, side } = input;
      yield* onIndex(
        worktree,
        Effect.gen(function* () {
          const add = run(worktree, ["--literal-pathspecs", "add", "--", file]);
          if (side === "as-is") {
            yield* add;
            return;
          }
          const operation = yield* operationInProgress(yield* gitDir(worktree));
          const ours = (side === "mine") !== (operation === "rebase");
          // A side that deleted the file has no version to check out.
          const checkedOut = yield* run(worktree, [
            "--literal-pathspecs",
            "checkout",
            ours ? "--ours" : "--theirs",
            "--",
            file,
          ]).pipe(
            Effect.as(true),
            Effect.catchTags({
              GitCommandError: (error) =>
                /does not have (our|their) version/.test(stderrOf(error))
                  ? run(worktree, [
                      "--literal-pathspecs",
                      "rm",
                      "--quiet",
                      "--",
                      file,
                    ]).pipe(Effect.as(false))
                  : Effect.fail(error),
            }),
          );
          if (checkedOut) yield* add;
        }),
      );
    });

    return {
      gitDir,
      rebasingBranch,
      conflictedPaths,
      hasStagedChanges,
      operationInProgress,
      undoStopped,
      readOperation,
      refuseMidOperation,
      continueOperation,
      abortOperation,
      resolveConflict,
    };
  });

export type OperationArea = Effect.Success<ReturnType<typeof makeOperation>>;
