// What the Git section's commit menu does to history beyond amend and
// undo (changes.ts): revert a commit, copy one onto another worktree's
// branch, and reword or squash commits that exist nowhere but here.
import { onIndex } from "./changes";
import { run, runLenient } from "./core";
import { refuseMidOperation } from "./operation";
import { isAncestor, verifyRev } from "./refs";

// --- revert and cherry-pick -------------------------------------------

// Both make a new commit and refuse to leave anything half done: a
// conflict aborts, so the worktree is exactly as it was and the error
// says so. Git's own refusal over local edits it would overwrite rides
// along as it is.
async function applyCommit(
  worktreePath: string,
  verb: "revert" | "cherry-pick",
  hash: string,
): Promise<void> {
  await onIndex(worktreePath, async () => {
    await refuseMidOperation(worktreePath);
    // A merge is applied as what it brought into its first parent.
    const parents = await run(worktreePath, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      "--end-of-options",
      hash,
    ]);
    const mainline =
      parents.trim().split(" ").length > 2 ? ["--mainline", "1"] : [];
    try {
      await run(worktreePath, [
        verb,
        "--no-edit",
        ...mainline,
        "--end-of-options",
        hash,
      ]);
    } catch (err) {
      const inProgress = await runLenient(worktreePath, [
        "rev-parse",
        "--verify",
        "--quiet",
        verb === "revert" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD",
      ]);
      if (inProgress.trim() === "") throw err;
      await runLenient(worktreePath, [verb, "--abort"]);
      if (/is now empty|nothing to commit/.test((err as Error).message)) {
        throw new Error("That change is already on this branch.", {
          cause: err,
        });
      }
      throw new Error(
        verb === "revert"
          ? `Reverting ${hash} conflicts with this branch, so nothing was changed.`
          : `${hash} conflicts with this branch, so nothing was changed.`,
        { cause: err },
      );
    }
  });
}

export function revertCommit(worktreePath: string, hash: string) {
  return applyCommit(worktreePath, "revert", hash);
}

// Worktrees share one object store, so a commit from any of them
// resolves here.
export function cherryPickCommit(worktreePath: string, hash: string) {
  return applyCommit(worktreePath, "cherry-pick", hash);
}

// --- rewriting local commits ------------------------------------------

interface CommitSpec {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  message: string;
}

async function readCommit(
  worktreePath: string,
  hash: string,
): Promise<CommitSpec> {
  const out = await run(worktreePath, [
    "show",
    "-s",
    "--date=raw",
    "--format=%T%x00%P%x00%an%x00%ae%x00%ad%x00%B",
    "--end-of-options",
    hash,
    "--",
  ]);
  const [tree = "", parents = "", name = "", email = "", date = "", ...rest] =
    out.split("\0");
  return {
    tree,
    parents: parents.split(" ").filter(Boolean),
    authorName: name,
    authorEmail: email,
    authorDate: date,
    message: rest.join("\0").trim(),
  };
}

// Rebuilds HEAD's line from `oldest` up with `edit` applied, by
// plumbing: every new commit reuses a tree that already exists, so the
// index and the working tree are never touched and uncommitted work
// stays where it is. Authors and their dates carry over. `edit` gets the
// commits oldest first and answers with the line to write in their
// place, the first of which takes `oldest`'s parents.
//
// Refused once HEAD has moved past `expectHead`, and across a merge,
// which a line of single-parent commits can't express.
async function rewriteLine(
  worktreePath: string,
  oldest: string,
  expectHead: string,
  edit: (commits: CommitSpec[]) => CommitSpec[],
): Promise<void> {
  await onIndex(worktreePath, async () => {
    await refuseMidOperation(worktreePath);
    const [head, expected] = await Promise.all([
      verifyRev(worktreePath, "HEAD"),
      verifyRev(worktreePath, expectHead),
    ]);
    if (head !== expected) {
      throw new Error(
        "The branch has moved on since this was loaded. Reload and try again.",
      );
    }
    if (!(await isAncestor(worktreePath, oldest, head))) {
      throw new Error("That commit isn't on this branch's history.");
    }
    const newer = (
      await run(worktreePath, [
        "rev-list",
        "--reverse",
        "--end-of-options",
        `${oldest}..${head}`,
      ])
    )
      .split("\n")
      .filter(Boolean);
    const commits = await Promise.all(
      [oldest, ...newer].map((hash) => readCommit(worktreePath, hash)),
    );
    if (commits.some((commit) => commit.parents.length > 1)) {
      throw new Error("Can't rewrite history across a merge commit.");
    }
    let tip: string | undefined;
    for (const spec of edit(commits)) {
      const parents = tip === undefined ? (commits[0]?.parents ?? []) : [tip];
      // oxlint-disable-next-line no-await-in-loop -- each commit names the one before it as its parent
      const out = await run(
        worktreePath,
        [
          "commit-tree",
          ...parents.flatMap((parent) => ["-p", parent]),
          "-m",
          spec.message,
          spec.tree,
        ],
        {
          env: {
            GIT_AUTHOR_NAME: spec.authorName,
            GIT_AUTHOR_EMAIL: spec.authorEmail,
            GIT_AUTHOR_DATE: spec.authorDate,
          },
        },
      );
      tip = out.trim();
    }
    if (tip === undefined) throw new Error("Nothing left to write.");
    await run(worktreePath, [
      "update-ref",
      "-m",
      "shigomori: rewrite",
      "HEAD",
      tip,
      head,
    ]);
  });
}

export function rewordCommit(
  worktreePath: string,
  hash: string,
  message: { summary: string; description?: string },
  expectHead: string,
): Promise<void> {
  const body = message.description?.trim();
  const text = body ? `${message.summary.trim()}\n\n${body}` : message.summary;
  return rewriteLine(worktreePath, hash, expectHead, ([first, ...rest]) =>
    first ? [{ ...first, message: text.trim() }, ...rest] : [],
  );
}

// Folds `hash` into the commit before it: one commit with the later
// tree, the earlier commit's author, and both messages, earlier first.
export async function squashIntoParent(
  worktreePath: string,
  hash: string,
  expectHead: string,
): Promise<void> {
  const { parents } = await readCommit(worktreePath, hash);
  const [parent] = parents;
  if (parent === undefined || parents.length > 1) {
    throw new Error("Only a commit with one parent can be squashed into it.");
  }
  await rewriteLine(
    worktreePath,
    parent,
    expectHead,
    ([earlier, later, ...rest]) =>
      earlier && later
        ? [
            {
              ...earlier,
              tree: later.tree,
              message: `${earlier.message}\n\n${later.message}`,
            },
            ...rest,
          ]
        : [],
  );
}
