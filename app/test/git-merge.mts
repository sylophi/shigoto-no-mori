// Durable proof for bringing another branch in (host/lib/git/merge.ts)
// against a REAL repository: the preview's counts and conflicts, a
// merge commit even where a fast-forward would do, a fast-forward
// refused once the branch has its own commits, a squash into one commit
// with its message (and its conflicts stopped, continued with that
// message, or aborted), and a rebase that stops on conflicts. A merge
// continued after its conflicts keeps git's conflict list out of its
// message. The merge commit made reads as one in the history, with
// what it brought in as its diff and counts, and reverts. One on top
// is undone whole, back to its first parent, and redone.
//
// Run: pnpm test git-merge.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeProof,
  sandboxGit,
  scrubbedGitEnv,
  scrubProcessGitEnv,
  tempDir,
  type Track,
} from "./lib/checkKit.mts";

const gitEnv = scrubbedGitEnv();
scrubProcessGitEnv({
  GIT_AUTHOR_NAME: "sm",
  GIT_AUTHOR_EMAIL: "sm@example.test",
  GIT_COMMITTER_NAME: "sm",
  GIT_COMMITTER_EMAIL: "sm@example.test",
});

const { mergeBranch, readMergePreview } =
  await import("../host/lib/git/merge.ts");
const { abortOperation, continueOperation, readOperation, resolveConflict } =
  await import("../host/lib/git/operation.ts");
const { readBranchHistory } = await import("../host/lib/git/worktrees.ts");
const { getCommitDiff } = await import("../host/lib/git/diff.ts");
const { revertCommit } = await import("../host/lib/git/history.ts");
const { resetSoft } = await import("../host/lib/git/changes.ts");

const git = sandboxGit(gitEnv);

const { check, done, fail } = makeProof("git-merge proof");
console.log("git-merge proof\n");

const read = (repo: string, path: string): string =>
  readFileSync(join(repo, path), "utf8");
const rev = (repo: string, ref: string): string =>
  git(repo, "rev-parse", "--short", ref).trim();
const parents = (repo: string, ref = "HEAD"): number =>
  git(repo, "rev-list", "--parents", "-n", "1", ref).trim().split(" ").length -
  1;
const message = (repo: string): string =>
  git(repo, "log", "-1", "--format=%B").trim();
const commit = (repo: string, path: string, text: string, msg: string) => {
  writeFileSync(join(repo, path), text);
  git(repo, "add", path);
  git(repo, "commit", "-q", "-m", msg);
};
const clean = async (repo: string) => {
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal((await readOperation(repo)).operation, null);
};

// main with a.txt. `feature` off it with "Feature" (f.txt), checked
// out. With `diverge`, main gets "Main" (m.txt) after, so the two each
// hold a commit. With `conflict`, both edit a.txt instead.
function seed(
  track: Track,
  { diverge = false, conflict = false } = {},
): string {
  const repo = tempDir("sm-merge-", track);
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "a.txt", "a\n", "init");
  git(repo, "checkout", "-q", "-b", "feature");
  if (conflict) commit(repo, "a.txt", "feature\n", "Feature");
  else commit(repo, "f.txt", "f\n", "Feature");
  if (diverge || conflict) {
    git(repo, "checkout", "-q", "main");
    if (conflict) commit(repo, "a.txt", "main\n", "Main");
    else commit(repo, "m.txt", "m\n", "Main");
    git(repo, "checkout", "-q", "feature");
  }
  return repo;
}

async function main() {
  await check(
    "the preview counts each side's commits and names the conflicts",
    async (track) => {
      const repo = seed(track, { conflict: true });
      assert.deepEqual(await readMergePreview(repo, "main"), {
        incoming: 1,
        own: 1,
        pushed: 0,
        conflicts: ["a.txt"],
        incomingSubject: "Main",
      });
      const clear = seed(track, { diverge: true });
      assert.deepEqual((await readMergePreview(clear, "main")).conflicts, []);
      await assert.rejects(
        readMergePreview(repo, "nope"),
        /no branch or commit named nope/,
      );
    },
  );

  await check(
    "the preview counts the branch's own commits a remote has",
    async (track) => {
      const repo = seed(track, { diverge: true });
      git(repo, "remote", "add", "origin", repo);
      git(repo, "update-ref", "refs/remotes/origin/feature", "HEAD");
      git(repo, "branch", "-q", "--set-upstream-to", "origin/feature");
      commit(repo, "g.txt", "g\n", "Unpushed");
      const preview = await readMergePreview(repo, "main");
      assert.equal(preview.own, 2);
      assert.equal(preview.pushed, 1);
    },
  );

  await check(
    "a merge makes a merge commit, even where a fast-forward would do",
    async (track) => {
      const repo = seed(track);
      git(repo, "checkout", "-q", "main");
      assert.equal(
        await mergeBranch(repo, "feature", "merge", undefined),
        false,
      );
      assert.equal(parents(repo), 2);
      assert.equal(message(repo), "Merge branch 'feature'");
      await clean(repo);
    },
  );

  await check(
    "a fast-forward moves the branch up, and is refused once it has its own commits",
    async (track) => {
      const repo = seed(track);
      git(repo, "checkout", "-q", "main");
      await mergeBranch(repo, "feature", "fastForward", undefined);
      assert.equal(rev(repo, "HEAD"), rev(repo, "feature"));

      const diverged = seed(track, { diverge: true });
      const head = rev(diverged, "HEAD");
      await assert.rejects(
        mergeBranch(diverged, "main", "fastForward", undefined),
      );
      assert.equal(rev(diverged, "HEAD"), head);
    },
  );

  await check(
    "a squash lands as one commit with its message",
    async (track) => {
      const repo = seed(track, { diverge: true });
      git(repo, "checkout", "-q", "main");
      const before = rev(repo, "HEAD");
      await mergeBranch(repo, "feature", "squash", "Add the feature");
      assert.equal(parents(repo), 1);
      assert.equal(rev(repo, "HEAD~1"), before);
      assert.equal(message(repo), "Add the feature");
      assert.equal(read(repo, "f.txt"), "f\n");
      await clean(repo);
      await assert.rejects(
        mergeBranch(repo, "feature", "squash", "Again"),
        /already on this branch/,
      );
      await clean(repo);
    },
  );

  await check(
    "a squash that conflicts stops, and continues with its message",
    async (track) => {
      const repo = seed(track, { conflict: true });
      assert.equal(
        await mergeBranch(repo, "main", "squash", "Take main"),
        true,
      );
      assert.deepEqual(await readOperation(repo), {
        operation: "squash",
        continuable: true,
        conflicted: 1,
      });
      await resolveConflict(repo, "a.txt", "theirs");
      await continueOperation(repo);
      assert.equal(message(repo), "Take main");
      assert.equal(parents(repo), 1);
      assert.equal(read(repo, "a.txt"), "main\n");
      await clean(repo);
    },
  );

  await check(
    "a squash that conflicts aborts back to as it was",
    async (track) => {
      const repo = seed(track, { conflict: true });
      const head = rev(repo, "HEAD");
      await mergeBranch(repo, "main", "squash", "Take main");
      await abortOperation(repo);
      assert.equal(rev(repo, "HEAD"), head);
      assert.equal(read(repo, "a.txt"), "feature\n");
      await clean(repo);
    },
  );

  await check(
    "a merge that conflicts stops, and its commit leaves out git's conflict list",
    async (track) => {
      const repo = seed(track, { conflict: true });
      assert.equal(await mergeBranch(repo, "main", "merge", undefined), true);
      assert.equal((await readOperation(repo)).operation, "merge");
      await resolveConflict(repo, "a.txt", "mine");
      await continueOperation(repo);
      assert.equal(parents(repo), 2);
      assert.equal(message(repo), "Merge branch 'main' into feature");
      await clean(repo);
    },
  );

  await check(
    "a rebase replays the branch on top, and stops on conflicts",
    async (track) => {
      const repo = seed(track, { diverge: true });
      assert.equal(await mergeBranch(repo, "main", "rebase", undefined), false);
      assert.equal(rev(repo, "HEAD~1"), rev(repo, "main"));
      assert.equal(parents(repo), 1);

      const conflicted = seed(track, { conflict: true });
      const head = rev(conflicted, "HEAD");
      assert.equal(
        await mergeBranch(conflicted, "main", "rebase", undefined),
        true,
      );
      assert.equal((await readOperation(conflicted)).operation, "rebase");
      await abortOperation(conflicted);
      assert.equal(rev(conflicted, "HEAD"), head);
    },
  );

  await check(
    "local edits in the way are git's refusal, not a stop",
    async (track) => {
      const repo = seed(track, { conflict: true });
      writeFileSync(join(repo, "a.txt"), "dirty\n");
      await assert.rejects(mergeBranch(repo, "main", "merge", undefined));
      assert.equal((await readOperation(repo)).operation, null);
      assert.equal(read(repo, "a.txt"), "dirty\n");
    },
  );

  await check(
    "a merge commit is marked in the history, counted, shown and reverted as what it brought in",
    async (track) => {
      const repo = seed(track, { diverge: true });
      git(repo, "checkout", "-q", "main");
      await mergeBranch(repo, "feature", "merge", undefined);
      const merge = rev(repo, "HEAD");
      const history = await readBranchHistory(repo, {
        base: undefined,
        count: 10,
      });
      assert.deepEqual(history.merges, [
        { hash: merge, firstParent: rev(repo, "HEAD^1") },
      ]);
      const row = history.commits.find((c) => c.hash === merge);
      assert.equal(row?.additions, 1);
      const diff = await getCommitDiff(repo, merge);
      assert.match(diff, /^diff --git a\/f\.txt b\/f\.txt$/m);
      assert.doesNotMatch(diff, /m\.txt/);
      await revertCommit(repo, merge);
      assert.equal(git(repo, "ls-files").includes("f.txt"), false);
      assert.equal(read(repo, "m.txt"), "m\n");
    },
  );

  await check(
    "a merge on top is undone whole and redone, and nothing undoes across one",
    async (track) => {
      const repo = seed(track, { diverge: true });
      git(repo, "checkout", "-q", "main");
      const before = rev(repo, "HEAD");
      await mergeBranch(repo, "feature", "merge", undefined);
      const merge = rev(repo, "HEAD");
      const previous = await resetSoft(repo, before, merge);
      assert.equal(rev(repo, "HEAD"), before);
      await clean(repo);
      await resetSoft(repo, previous, before);
      assert.equal(rev(repo, "HEAD"), merge);
      await clean(repo);
      commit(repo, "n.txt", "n\n", "After");
      await assert.rejects(
        resetSoft(repo, before, rev(repo, "HEAD")),
        /across a merge/,
      );
    },
  );

  done();
}

main().catch(fail);
