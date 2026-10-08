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
import { gitDirOf, readOperation } from "./operation";

async function resolveCommit(
  worktreePath: string,
  ref: string,
): Promise<string> {
  const hash = (
    await runLenient(worktreePath, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${ref}^{commit}`,
    ])
  ).trim();
  if (!hash) throw new Error(`There is no branch or commit named ${ref}.`);
  return hash;
}

async function countCommits(
  worktreePath: string,
  revs: string[],
): Promise<number> {
  const out = await run(worktreePath, [
    "rev-list",
    "--count",
    "--end-of-options",
    ...revs,
  ]);
  return Number(out.trim());
}

export async function readMergePreview(
  worktreePath: string,
  ref: string,
): Promise<MergePreview> {
  const target = await resolveCommit(worktreePath, ref);
  const upstream = (
    await runLenient(worktreePath, ["rev-parse", "--verify", "--quiet", "@{u}"])
  ).trim();
  const [incoming, own, unpushed, merged] = await Promise.all([
    countCommits(worktreePath, [`HEAD..${target}`]),
    countCommits(worktreePath, [`${target}..HEAD`]),
    upstream
      ? countCommits(worktreePath, [`${target}..HEAD`, `^${upstream}`])
      : null,
    // The tree a merge would make, then the paths it left conflicted.
    // Exit 1 on a conflict, so read leniently. Unrelated histories fail
    // outright and read as none, and the merge itself says so.
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
  return {
    incoming,
    own,
    pushed: unpushed === null ? 0 : own - unpushed,
    conflicts: splitZ(merged).slice(1),
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

// Whether it stopped on conflicts. A squash commits with `message`
// once its changes are in, and when they conflict the message waits in
// SQUASH_MSG for the continue to commit with.
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
        const stopped = await stopsOnConflict(worktreePath, [
          "merge",
          "--squash",
          "--end-of-options",
          ref,
        ]);
        if (stopped) {
          await writeFile(
            join(await gitDirOf(worktreePath), "SQUASH_MSG"),
            `${message}\n`,
          );
          return true;
        }
        const staged = await run(worktreePath, [
          "diff",
          "--cached",
          "--name-only",
          "-z",
        ]);
        if (staged === "") {
          await run(worktreePath, ["reset", "--merge"]);
          throw new Error(`Everything on ${ref} is already on this branch.`);
        }
        await run(worktreePath, ["commit", "-m", message]);
        return false;
      }
    }
  });
}
