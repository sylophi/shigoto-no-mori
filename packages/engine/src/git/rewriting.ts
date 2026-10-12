// Git's history rewrites beyond amend and undo (gitIndex.ts): revert a
// commit, copy one onto another worktree's branch, and reword or squash
// commits that exist nowhere but here.
import * as Effect from "effect/Effect";
import { GitCommandError, GitRefusedError, stderrOf } from "./documents.ts";
import type { OperationArea } from "./operation.ts";
import type { RefsArea } from "./refs.ts";
import type { RunningArea } from "./running.ts";

interface CommitSpec {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  message: string;
}

export const makeRewriting = ({
  running,
  refs,
  operation,
}: {
  readonly running: RunningArea;
  readonly refs: RefsArea;
  readonly operation: OperationArea;
}) =>
  Effect.sync(() => {
    const { run, runLenient, onIndex } = running;
    const { headAt, isAncestor } = refs;
    const { conflictedPaths, refuseMidOperation } = operation;

    // Both make a new commit and refuse to leave anything half done: a
    // conflict aborts, so the worktree is exactly as it was and the error
    // says so. Git's own refusal over local edits it would overwrite
    // rides along as it is.
    const applyCommit = (
      worktree: string,
      verb: "revert" | "cherry-pick",
      hash: string,
    ) =>
      onIndex(
        worktree,
        Effect.gen(function* () {
          yield* refuseMidOperation(worktree);
          // A merge is applied as what it brought into its first parent.
          const parents = yield* run(worktree, [
            "rev-list",
            "--parents",
            "-n",
            "1",
            "--end-of-options",
            hash,
          ]);
          const mainline =
            parents.trim().split(" ").length > 2 ? ["--mainline", "1"] : [];
          yield* run(worktree, [
            verb,
            "--no-edit",
            ...mainline,
            "--end-of-options",
            hash,
          ]).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const inProgress = yield* runLenient(worktree, [
                  "rev-parse",
                  "--verify",
                  "--quiet",
                  verb === "revert" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD",
                ]);
                if (inProgress.trim() === "") return yield* Effect.fail(error);
                const conflicted =
                  (yield* conflictedPaths(worktree)).length > 0;
                yield* runLenient(worktree, [verb, "--abort"]);
                const words =
                  error instanceof GitCommandError
                    ? stderrOf(error)
                    : error.message;
                if (/is now empty|nothing to commit/.test(words)) {
                  return yield* new GitRefusedError({
                    reason: "That change is already on this branch.",
                  });
                }
                // Stopped for another reason (a hook refusing the commit):
                // git's own words, the move undone.
                if (!conflicted) return yield* Effect.fail(error);
                return yield* new GitRefusedError({
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

    const revertCommit = Effect.fn("Git.revertCommit")(function* (
      worktree: string,
      hash: string,
    ) {
      yield* applyCommit(worktree, "revert", hash);
    });

    // Worktrees share one object store, so a commit from any of them
    // resolves here.
    const cherryPickCommit = Effect.fn("Git.cherryPickCommit")(function* (
      worktree: string,
      hash: string,
    ) {
      yield* applyCommit(worktree, "cherry-pick", hash);
    });

    const readCommit = (worktree: string, hash: string) =>
      run(worktree, [
        "show",
        "-s",
        "--date=raw",
        "--format=%T%x00%P%x00%an%x00%ae%x00%ad%x00%B",
        "--end-of-options",
        hash,
        "--",
      ]).pipe(
        Effect.map((out): CommitSpec => {
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
        }),
      );

    // Rebuilds HEAD's line from `oldest` up with `edit` applied, by
    // plumbing: every new commit reuses a tree that already exists, so
    // the index and the working tree are never touched and uncommitted
    // work stays where it is. Authors and their dates carry over. `edit`
    // gets the commits oldest first and answers with the line to write in
    // their place, the first of which takes `oldest`'s parents.
    //
    // Refused once HEAD has moved past `expectHead`, and across a merge,
    // which a line of single-parent commits can't express.
    const rewriteLine = (
      worktree: string,
      oldest: string,
      expectHead: string,
      edit: (commits: CommitSpec[]) => CommitSpec[],
    ) =>
      onIndex(
        worktree,
        Effect.gen(function* () {
          yield* refuseMidOperation(worktree);
          const head = yield* headAt(worktree, expectHead);
          if (!(yield* isAncestor(worktree, oldest, head))) {
            return yield* new GitRefusedError({
              reason: "That commit isn't on this branch's history.",
            });
          }
          const newer = (yield* run(worktree, [
            "rev-list",
            "--reverse",
            "--end-of-options",
            `${oldest}..${head}`,
          ]))
            .split("\n")
            .filter(Boolean);
          const commits = yield* Effect.forEach(
            [oldest, ...newer],
            (hash) => readCommit(worktree, hash),
            { concurrency: "unbounded" },
          );
          if (commits.some((commit) => commit.parents.length > 1)) {
            return yield* new GitRefusedError({
              reason: "Can't rewrite history across a merge commit.",
            });
          }
          let tip: string | undefined;
          // Each commit names the one before it as its parent.
          for (const spec of edit(commits)) {
            const parents =
              tip === undefined ? (commits[0]?.parents ?? []) : [tip];
            const out = yield* run(
              worktree,
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
            return yield* new GitRefusedError({
              reason: "Nothing left to write.",
            });
          }
          yield* run(worktree, [
            "update-ref",
            "-m",
            "shigomori: rewrite",
            "HEAD",
            tip,
            head,
          ]);
        }),
      );

    const rewordCommit = Effect.fn("Git.rewordCommit")(function* (input: {
      readonly worktree: string;
      readonly hash: string;
      readonly summary: string;
      readonly description?: string | undefined;
      readonly expectHead: string;
    }) {
      const body = input.description?.trim();
      const text = body ? `${input.summary.trim()}\n\n${body}` : input.summary;
      yield* rewriteLine(
        input.worktree,
        input.hash,
        input.expectHead,
        ([first, ...rest]) =>
          first ? [{ ...first, message: text.trim() }, ...rest] : [],
      );
    });

    // Folds `hash` into the commit before it: one commit with the later
    // tree, the earlier commit's author, and both messages, earlier first.
    const squashIntoParent = Effect.fn("Git.squashIntoParent")(function* (
      worktree: string,
      hash: string,
      expectHead: string,
    ) {
      const { parents } = yield* readCommit(worktree, hash);
      const [parent] = parents;
      if (parent === undefined || parents.length > 1) {
        return yield* new GitRefusedError({
          reason: "Only a commit with one parent can be squashed into it.",
        });
      }
      yield* rewriteLine(
        worktree,
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

    return { revertCommit, cherryPickCommit, rewordCommit, squashIntoParent };
  });
