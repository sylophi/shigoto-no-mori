// What the Git section's commit menu does to history beyond amend and
// undo (changes.ts): revert a commit, copy one onto another worktree's
// branch, and reword or squash commits that exist nowhere but here.
import * as Effect from "effect/Effect";
import { onIndex } from "./changes";
import { GitRefusal, run, runLenient } from "./core";
import { conflictedPaths, refuseMidOperation } from "./operation";
import { isAncestor, verifyRev } from "./refs";

// --- revert and cherry-pick -------------------------------------------

// Both make a new commit and refuse to leave anything half done: a
// conflict aborts, so the worktree is exactly as it was and the error
// says so. Git's own refusal over local edits it would overwrite rides
// along as it is.
const applyCommit = (
  worktreePath: string,
  verb: "revert" | "cherry-pick",
  hash: string,
) =>
  onIndex(
    worktreePath,
    Effect.gen(function* () {
      yield* refuseMidOperation(worktreePath);
      // A merge is applied as what it brought into its first parent.
      const parents = yield* run(worktreePath, [
        "rev-list",
        "--parents",
        "-n",
        "1",
        "--end-of-options",
        hash,
      ]);
      const mainline =
        parents.trim().split(" ").length > 2 ? ["--mainline", "1"] : [];
      yield* run(worktreePath, [
        verb,
        "--no-edit",
        ...mainline,
        "--end-of-options",
        hash,
      ]).pipe(
        Effect.catch((err) =>
          Effect.gen(function* () {
            const inProgress = yield* runLenient(worktreePath, [
              "rev-parse",
              "--verify",
              "--quiet",
              verb === "revert" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD",
            ]);
            if (inProgress.trim() === "") return yield* err;
            const conflicted =
              (yield* conflictedPaths(worktreePath)).length > 0;
            yield* runLenient(worktreePath, [verb, "--abort"]);
            if (/is now empty|nothing to commit/.test(err.reason)) {
              return yield* new GitRefusal({
                reason: "That change is already on this branch.",
              });
            }
            // Stopped for another reason (a hook refusing the commit):
            // git's own words, the move undone.
            if (!conflicted) return yield* err;
            return yield* new GitRefusal({
              reason:
                verb === "revert"
                  ? `Reverting ${hash} conflicts with this branch, so nothing was changed.`
                  : `${hash} conflicts with this branch, so nothing was changed.`,
            });
          }),
        ),
      );
    }),
  );

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

const readCommit = (worktreePath: string, hash: string) =>
  Effect.map(
    run(worktreePath, [
      "show",
      "-s",
      "--date=raw",
      "--format=%T%x00%P%x00%an%x00%ae%x00%ad%x00%B",
      "--end-of-options",
      hash,
      "--",
    ]),
    (out): CommitSpec => {
      const [
        tree = "",
        parents = "",
        name = "",
        email = "",
        date = "",
        ...rest
      ] = out.split("\0");
      return {
        tree,
        parents: parents.split(" ").filter(Boolean),
        authorName: name,
        authorEmail: email,
        authorDate: date,
        message: rest.join("\0").trim(),
      };
    },
  );

// Rebuilds HEAD's line from `oldest` up with `edit` applied, by
// plumbing: every new commit reuses a tree that already exists, so the
// index and the working tree are never touched and uncommitted work
// stays where it is. Authors and their dates carry over. `edit` gets the
// commits oldest first and answers with the line to write in their
// place, the first of which takes `oldest`'s parents.
//
// Refused once HEAD has moved past `expectHead`, and across a merge,
// which a line of single-parent commits can't express.
const rewriteLine = (
  worktreePath: string,
  oldest: string,
  expectHead: string,
  edit: (commits: CommitSpec[]) => CommitSpec[],
) =>
  onIndex(
    worktreePath,
    Effect.gen(function* () {
      yield* refuseMidOperation(worktreePath);
      const [head, expected] = yield* Effect.all(
        [verifyRev(worktreePath, "HEAD"), verifyRev(worktreePath, expectHead)],
        { concurrency: 2 },
      );
      if (head !== expected) {
        return yield* new GitRefusal({
          reason:
            "The branch has moved on since this was loaded. Reload and try again.",
        });
      }
      if (!(yield* isAncestor(worktreePath, oldest, head))) {
        return yield* new GitRefusal({
          reason: "That commit isn't on this branch's history.",
        });
      }
      const newer = (yield* run(worktreePath, [
        "rev-list",
        "--reverse",
        "--end-of-options",
        `${oldest}..${head}`,
      ]))
        .split("\n")
        .filter(Boolean);
      const commits = yield* Effect.forEach(
        [oldest, ...newer],
        (hash) => readCommit(worktreePath, hash),
        { concurrency: "unbounded" },
      );
      if (commits.some((commit) => commit.parents.length > 1)) {
        return yield* new GitRefusal({
          reason: "Can't rewrite history across a merge commit.",
        });
      }
      let tip: string | undefined;
      // Each commit names the one before it as its parent.
      for (const spec of edit(commits)) {
        const parents = tip === undefined ? (commits[0]?.parents ?? []) : [tip];
        const out = yield* run(
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
      if (tip === undefined) {
        return yield* new GitRefusal({ reason: "Nothing left to write." });
      }
      yield* run(worktreePath, [
        "update-ref",
        "-m",
        "shigomori: rewrite",
        "HEAD",
        tip,
        head,
      ]);
    }),
  );

export function rewordCommit(
  worktreePath: string,
  hash: string,
  message: { summary: string; description?: string },
  expectHead: string,
) {
  const body = message.description?.trim();
  const text = body ? `${message.summary.trim()}\n\n${body}` : message.summary;
  return rewriteLine(worktreePath, hash, expectHead, ([first, ...rest]) =>
    first ? [{ ...first, message: text.trim() }, ...rest] : [],
  );
}

// Folds `hash` into the commit before it: one commit with the later
// tree, the earlier commit's author, and both messages, earlier first.
export const squashIntoParent = Effect.fnUntraced(function* (
  worktreePath: string,
  hash: string,
  expectHead: string,
) {
  const { parents } = yield* readCommit(worktreePath, hash);
  const [parent] = parents;
  if (parent === undefined || parents.length > 1) {
    return yield* new GitRefusal({
      reason: "Only a commit with one parent can be squashed into it.",
    });
  }
  yield* rewriteLine(
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
});
