// A worktree stopped in the middle of a git operation (a merge, a
// rebase, a cherry-pick, a revert or a squash waiting on conflicts),
// and the moves that see it through: settle each conflicted file one
// way or the other, then continue or abort. The Git section's banner and the
// changes page's conflicted rows drive these.
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { GitOperationState } from "@shigomori/contracts/schemas";
import { onIndex } from "./changes";
import * as Effect from "effect/Effect";
import { GitRefusal, run, splitZ } from "./core";

// The files git leaves in a worktree's own git dir while an operation
// waits on the user, in the order they are named when several are
// there (a cherry-pick sequence has both CHERRY_PICK_HEAD and the
// sequencer directory, and the first says more). rebase-apply is also
// `git am`'s, which marks itself with an `applying` file inside.
const OPERATION_MARKERS: { path: string; operation: string }[] = [
  { path: "rebase-merge", operation: "rebase" },
  { path: join("rebase-apply", "applying"), operation: "git am" },
  { path: "rebase-apply", operation: "rebase" },
  { path: "MERGE_HEAD", operation: "merge" },
  { path: "CHERRY_PICK_HEAD", operation: "cherry-pick" },
  { path: "REVERT_HEAD", operation: "revert" },
  { path: "sequencer", operation: "cherry-pick or revert" },
  { path: "BISECT_LOG", operation: "bisect" },
];

// The operation under way in the worktree whose git dir this is, or
// null. One listing of the git dir answers all of them, bar the one
// marker inside rebase-apply, looked at only when that is there.
export async function operationInProgress(
  gitDir: string,
): Promise<string | null> {
  const names = new Set(await readdir(gitDir).catch((): string[] => []));
  if (names.has("rebase-apply")) {
    names.add(
      await stat(join(gitDir, "rebase-apply", "applying")).then(
        () => join("rebase-apply", "applying"),
        () => "",
      ),
    );
  }
  return (
    OPERATION_MARKERS.find(({ path }) => names.has(path))?.operation ?? null
  );
}

// The kinds the banner can continue. The rest (`git am`, a bisect, a
// bare sequencer) it can only abort.
const CONTINUABLE = new Set([
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "squash",
]);

export const gitDirOf = (worktreePath: string) =>
  Effect.map(run(worktreePath, ["rev-parse", "--absolute-git-dir"]), (out) =>
    out.trim(),
  );

export const conflictedPaths = (worktreePath: string) =>
  Effect.map(
    run(worktreePath, ["diff", "--name-only", "--diff-filter=U", "-z"]),
    splitZ,
  );

// `merge --squash` leaves no MERGE_HEAD, only the message it made in
// SQUASH_MSG, which a commit or a reset clears but a discard of the
// files doesn't. So it is a squash under way only while the index holds
// one: conflicted, or staged and not yet committed. Otherwise the
// message is cleared here.
const squashPending = Effect.fnUntraced(function* (
  worktreePath: string,
  gitDir: string,
  conflicted: number,
) {
  const message = yield* Effect.promise(() =>
    stat(join(gitDir, "SQUASH_MSG")).then(
      () => true,
      () => false,
    ),
  );
  if (!message) return false;
  if (conflicted > 0 || (yield* hasStagedChanges(worktreePath))) return true;
  // Its changes gone (discarded file by file, which leaves the message
  // behind), the message is git's leftover, and staged work later on
  // would otherwise read as the squash.
  yield* Effect.promise(() => rm(join(gitDir, "SQUASH_MSG"), { force: true }));
  return false;
});

export const hasStagedChanges = (worktreePath: string) =>
  Effect.map(
    run(worktreePath, ["diff", "--cached", "--name-only", "-z"]),
    (staged) => staged !== "",
  );

// Refuses a move that rewrites history, makes a commit or starts a
// merge while git waits on the user mid-operation or over conflicted
// files, where git might go along with it, or refuse in a way that reads
// like the move's own stop.
export const refuseMidOperation = Effect.fnUntraced(function* (
  worktreePath: string,
) {
  const { operation, conflicted } = yield* readOperation(worktreePath);
  if (operation !== null) {
    return yield* new GitRefusal({
      reason: `Finish or abort the ${operation} first.`,
    });
  }
  if (conflicted > 0) {
    return yield* new GitRefusal({
      reason: "Resolve the conflicted files first.",
    });
  }
});

// The branch a rebase replays, which git keeps in its state dir while
// HEAD is detached for the replay.
async function rebasingBranch(gitDir: string): Promise<string | null> {
  const names = await Promise.all(
    ["rebase-merge", "rebase-apply"].map((dir) =>
      readFile(join(gitDir, dir, "head-name"), "utf8").then(
        (text) => text.trim(),
        () => "",
      ),
    ),
  );
  const name = names.find((n) => n.startsWith("refs/heads/"));
  return name === undefined ? null : name.slice("refs/heads/".length);
}

export const readOperation = Effect.fnUntraced(function* (
  worktreePath: string,
) {
  const [gitDir, conflictedList] = yield* Effect.all(
    [gitDirOf(worktreePath), conflictedPaths(worktreePath)],
    { concurrency: 2 },
  );
  const conflicted = conflictedList.length;
  const operation =
    (yield* Effect.promise(() => operationInProgress(gitDir))) ??
    ((yield* squashPending(worktreePath, gitDir, conflicted))
      ? "squash"
      : null);
  return {
    operation,
    continuable: operation !== null && CONTINUABLE.has(operation),
    conflicted,
    rebasing:
      operation === "rebase"
        ? yield* Effect.promise(() => rebasingBranch(gitDir))
        : null,
  } satisfies GitOperationState;
});

// The editor stays shut: a continue takes the message git prepared.
const NO_EDITOR = { env: { GIT_EDITOR: "true" } };

export const continueOperation = (worktreePath: string) =>
  onIndex(
    worktreePath,
    Effect.gen(function* () {
      const { operation, conflicted } = yield* readOperation(worktreePath);
      if (conflicted > 0) {
        return yield* new GitRefusal({
          reason: "Resolve the conflicted files first.",
        });
      }
      switch (operation) {
        // Strip, or the "# Conflicts:" list git adds to the message
        // stays in it, as an editor would have dropped it.
        case "merge":
          yield* run(
            worktreePath,
            ["commit", "--no-edit", "--cleanup=strip"],
            NO_EDITOR,
          );
          return;
        case "squash":
          yield* run(worktreePath, [
            "commit",
            "--file",
            join(yield* gitDirOf(worktreePath), "SQUASH_MSG"),
          ]);
          return;
        case "rebase":
          yield* run(worktreePath, ["rebase", "--continue"], NO_EDITOR);
          return;
        // A pick or revert that came out empty once its conflicts were
        // settled is skipped, as a rebase drops one: git won't commit it.
        case "cherry-pick":
        case "revert":
          if (!(yield* hasStagedChanges(worktreePath))) {
            yield* run(worktreePath, [operation, "--skip"]);
            return;
          }
          yield* run(worktreePath, [operation, "--continue"], NO_EDITOR);
          return;
        default:
          return yield* new GitRefusal({
            reason: "There is nothing here to continue.",
          });
      }
    }),
  );

export const abortOperation = (worktreePath: string) =>
  onIndex(
    worktreePath,
    Effect.gen(function* () {
      const { operation } = yield* readOperation(worktreePath);
      switch (operation) {
        case "merge":
        case "rebase":
        case "cherry-pick":
        case "revert":
          yield* run(worktreePath, [operation, "--abort"]);
          return;
        case "git am":
          yield* run(worktreePath, ["am", "--abort"]);
          return;
        case "squash":
          yield* run(worktreePath, ["reset", "--merge"]);
          return;
        case "bisect":
          yield* run(worktreePath, ["bisect", "reset"]);
          return;
        case "cherry-pick or revert":
          yield* run(worktreePath, ["cherry-pick", "--abort"]);
          return;
        default:
          return yield* new GitRefusal({
            reason: "There is nothing here to abort.",
          });
      }
    }),
  );

// Settles one conflicted file with one side's version, or as it stands,
// and stages it.
// The path came out of `git status`, so it is a filename and never a
// pattern. "mine" is the branch the worktree is on, which git calls "ours"
// everywhere but a rebase: there HEAD is the branch being replayed onto
// and "theirs" is the worktree's own commit. A side that deleted the
// file settles it as a removal.
export const resolveConflict = (
  worktreePath: string,
  path: string,
  side: "mine" | "theirs" | "as-is",
) =>
  onIndex(
    worktreePath,
    Effect.gen(function* () {
      const add = run(worktreePath, ["--literal-pathspecs", "add", "--", path]);
      if (side === "as-is") {
        yield* add;
        return;
      }
      const gitDir = yield* gitDirOf(worktreePath);
      const operation = yield* Effect.promise(() =>
        operationInProgress(gitDir),
      );
      const ours = (side === "mine") !== (operation === "rebase");
      // A side that deleted the file has no version to check out.
      const checkedOut = yield* run(worktreePath, [
        "--literal-pathspecs",
        "checkout",
        ours ? "--ours" : "--theirs",
        "--",
        path,
      ]).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => /does not have (our|their) version/.test(error.reason),
          () =>
            run(worktreePath, [
              "--literal-pathspecs",
              "rm",
              "--quiet",
              "--",
              path,
            ]).pipe(Effect.as(false)),
        ),
      );
      if (checkedOut) yield* add;
    }),
  );
