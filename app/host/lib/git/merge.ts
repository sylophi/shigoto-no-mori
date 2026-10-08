// Bringing another branch's work into a worktree's branch, the four
// ways git has: a merge commit, a fast-forward, a squash into one new
// commit, or the branch's own commits replayed on top (a rebase). The
// preview says beforehand how far apart the two are and which files
// would conflict. A merge, squash or rebase that conflicts stops there,
// for the Changes tab to settle and the banner to continue or abort
// (operation.ts).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IntegrateMethod, MergePreview } from "@shared/schemas";
import { onIndex } from "./changes";
import { run, runLenient, splitZ } from "./core";
import { gitDirOf, hasStagedChanges, readOperation } from "./operation";
import { countCommits, ownCommitCounts, refTip } from "./refs";

async function resolveCommit(
  worktreePath: string,
  ref: string,
): Promise<string> {
  const hash = await refTip(worktreePath, `${ref}^{commit}`);
  if (!hash) throw new Error(`There is no branch or commit named ${ref}.`);
  return hash;
}

export async function readMergePreview(
  worktreePath: string,
  ref: string,
): Promise<MergePreview> {
  const target = await resolveCommit(worktreePath, ref);
  const [incoming, ownCounts, merged] = await Promise.all([
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
  ]);
  const incomingSubject =
    incoming === 1
      ? (
          await run(worktreePath, ["log", "-1", "--format=%s", target, "--"])
        ).trim()
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
  };
}

// Runs the move and reads a failure that left git waiting on the user
// (a merge or rebase on conflicts, a squash's conflicted files) as a
// stop rather than an error. Anything else, git's refusal over local
// edits in the way above all, still throws.
async function stopsOnConflict(
  worktreePath: string,
  args: string[],
): Promise<boolean> {
  try {
    await run(worktreePath, args);
    return false;
  } catch (err) {
    const { operation, conflicted } = await readOperation(worktreePath);
    if (operation === null && conflicted === 0) throw err;
    return true;
  }
}

// A plain merge of `ref`, left stopped on its conflicts: the way on
// from a sync, from the primary branch or the upstream, that conflicts.
// Whether it stopped.
export function mergeKeepingConflicts(
  worktreePath: string,
  ref: string,
): Promise<boolean> {
  return onIndex(worktreePath, () =>
    stopsOnConflict(worktreePath, [
      "merge",
      "--no-edit",
      "--ff",
      "--end-of-options",
      ref,
    ]),
  );
}

// Whether it stopped on conflicts. A squash commits with `message`
// once its changes are in, the message kept in SQUASH_MSG for the
// continue to commit with where the commit can't be made yet.
export function mergeBranch(
  worktreePath: string,
  ref: string,
  method: IntegrateMethod,
  message: string | undefined,
): Promise<boolean> {
  return onIndex(worktreePath, async () => {
    await resolveCommit(worktreePath, ref);
    switch (method) {
      case "fastForward":
        await run(worktreePath, [
          "merge",
          "--ff-only",
          "--end-of-options",
          ref,
        ]);
        return false;
      case "merge":
        return stopsOnConflict(worktreePath, [
          "merge",
          "--no-ff",
          "--no-edit",
          "--end-of-options",
          ref,
        ]);
      case "rebase":
        return stopsOnConflict(worktreePath, [
          "rebase",
          "--end-of-options",
          ref,
        ]);
      case "squash": {
        if (!message) throw new Error("A squash needs a commit message.");
        // `--ff` over a `merge.ff` setting, which `--squash` can't take.
        const stopped = await stopsOnConflict(worktreePath, [
          "merge",
          "--squash",
          "--ff",
          "--end-of-options",
          ref,
        ]);
        // The message waits where the continue reads it, should the
        // commit stop too: on a conflict, or a hook refusing it.
        const squashMessage = join(await gitDirOf(worktreePath), "SQUASH_MSG");
        await writeFile(squashMessage, `${message}\n`);
        if (stopped) return true;
        if (!(await hasStagedChanges(worktreePath))) {
          await run(worktreePath, ["reset", "--merge"]);
          throw new Error(`Everything on ${ref} is already on this branch.`);
        }
        await run(worktreePath, ["commit", "--file", squashMessage]);
        return false;
      }
    }
  });
}
