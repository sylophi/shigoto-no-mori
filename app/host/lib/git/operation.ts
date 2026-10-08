// A worktree stopped in the middle of a git operation (a merge, a
// rebase, a cherry-pick, a revert or a squash waiting on conflicts),
// and the moves that see it through: settle each conflicted file one
// way or the other, then continue or abort. The Git section's banner and the
// changes page's conflicted rows drive these.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { GitOperationState } from "@shared/schemas";
import { onIndex } from "./changes";
import { run, splitZ } from "./core";

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

export async function gitDirOf(worktreePath: string): Promise<string> {
  return (await run(worktreePath, ["rev-parse", "--absolute-git-dir"])).trim();
}

export async function conflictedPaths(worktreePath: string): Promise<string[]> {
  return splitZ(
    await run(worktreePath, ["diff", "--name-only", "--diff-filter=U", "-z"]),
  );
}

// `merge --squash` leaves no MERGE_HEAD, only the message it made in
// SQUASH_MSG, which a commit or a reset clears but a discard of the
// files doesn't. So it is a squash under way only while the index holds
// one: conflicted, or staged and not yet committed.
async function squashPending(
  worktreePath: string,
  gitDir: string,
  conflicted: number,
): Promise<boolean> {
  const message = await stat(join(gitDir, "SQUASH_MSG")).then(
    () => true,
    () => false,
  );
  if (!message) return false;
  return conflicted > 0 || (await hasStagedChanges(worktreePath));
}

export async function hasStagedChanges(worktreePath: string): Promise<boolean> {
  const staged = await run(worktreePath, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
  ]);
  return staged !== "";
}

// Refuses a move that rewrites history or makes a commit of its own
// while git waits on the user mid-operation, where git itself might go
// along with it.
export async function refuseMidOperation(worktreePath: string): Promise<void> {
  const { operation } = await readOperation(worktreePath);
  if (operation !== null) {
    throw new Error(`Finish or abort the ${operation} first.`);
  }
}

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

export async function readOperation(
  worktreePath: string,
): Promise<GitOperationState> {
  const [gitDir, conflictedList] = await Promise.all([
    gitDirOf(worktreePath),
    conflictedPaths(worktreePath),
  ]);
  const conflicted = conflictedList.length;
  const operation =
    (await operationInProgress(gitDir)) ??
    ((await squashPending(worktreePath, gitDir, conflicted)) ? "squash" : null);
  return {
    operation,
    continuable: operation !== null && CONTINUABLE.has(operation),
    conflicted,
    rebasing: operation === "rebase" ? await rebasingBranch(gitDir) : null,
  };
}

// The editor stays shut: a continue takes the message git prepared.
const NO_EDITOR = { env: { GIT_EDITOR: "true" } };

export function continueOperation(worktreePath: string): Promise<void> {
  return onIndex(worktreePath, async () => {
    const { operation, conflicted } = await readOperation(worktreePath);
    if (conflicted > 0) {
      throw new Error("Resolve the conflicted files first.");
    }
    switch (operation) {
      // Strip, or the "# Conflicts:" list git adds to the message
      // stays in it, as an editor would have dropped it.
      case "merge":
        await run(
          worktreePath,
          ["commit", "--no-edit", "--cleanup=strip"],
          NO_EDITOR,
        );
        return;
      case "squash":
        await run(worktreePath, [
          "commit",
          "--file",
          join(await gitDirOf(worktreePath), "SQUASH_MSG"),
        ]);
        return;
      case "rebase":
      case "cherry-pick":
      case "revert":
        await run(worktreePath, [operation, "--continue"], NO_EDITOR);
        return;
      default:
        throw new Error("There is nothing here to continue.");
    }
  });
}

export function abortOperation(worktreePath: string): Promise<void> {
  return onIndex(worktreePath, async () => {
    const { operation } = await readOperation(worktreePath);
    switch (operation) {
      case "merge":
      case "rebase":
      case "cherry-pick":
      case "revert":
        await run(worktreePath, [operation, "--abort"]);
        return;
      case "git am":
        await run(worktreePath, ["am", "--abort"]);
        return;
      case "squash":
        await run(worktreePath, ["reset", "--merge"]);
        return;
      case "bisect":
        await run(worktreePath, ["bisect", "reset"]);
        return;
      case "cherry-pick or revert":
        await run(worktreePath, ["cherry-pick", "--abort"]);
        return;
      default:
        throw new Error("There is nothing here to abort.");
    }
  });
}

// Settles one conflicted file with one side's version and stages it.
// The path came out of `git status`, so it is a filename and never a
// pattern. "mine" is the branch the worktree is on, which git calls "ours"
// everywhere but a rebase: there HEAD is the branch being replayed onto
// and "theirs" is the worktree's own commit. A side that deleted the
// file settles it as a removal.
export function resolveConflict(
  worktreePath: string,
  path: string,
  side: "mine" | "theirs",
): Promise<void> {
  return onIndex(worktreePath, async () => {
    const operation = await operationInProgress(await gitDirOf(worktreePath));
    const ours = (side === "mine") !== (operation === "rebase");
    try {
      await run(worktreePath, [
        "--literal-pathspecs",
        "checkout",
        ours ? "--ours" : "--theirs",
        "--",
        path,
      ]);
    } catch (err) {
      if (!/does not have (our|their) version/.test((err as Error).message)) {
        throw err;
      }
      await run(worktreePath, [
        "--literal-pathspecs",
        "rm",
        "--quiet",
        "--",
        path,
      ]);
      return;
    }
    await run(worktreePath, ["--literal-pathspecs", "add", "--", path]);
  });
}
