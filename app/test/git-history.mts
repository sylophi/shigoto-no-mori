// Durable proof for the Git section's commit menu and stashes
// (host/lib/git/history.ts, host/lib/git/stash.ts) against a REAL
// repository: revert and cherry-pick with their conflict abort, reword
// and squash of local commits leaving the working tree alone with every
// refusal (moved HEAD, a merge, a commit off the line), and stashes
// listed per branch, applied, popped and dropped by hash.
//
// Run: pnpm test git-history.
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

// Same as git-changes: the hook's GIT_* variables go before the git
// modules load, and commits need a pinned identity.
const gitEnv = scrubbedGitEnv();
scrubProcessGitEnv({
  GIT_AUTHOR_NAME: "sm",
  GIT_AUTHOR_EMAIL: "sm@example.test",
  GIT_COMMITTER_NAME: "sm",
  GIT_COMMITTER_EMAIL: "sm@example.test",
});

const { cherryPickCommit, revertCommit, rewordCommit, squashIntoParent } =
  await import("../host/lib/git/history.ts");
const { applyStash, dropStash, listStashes, restoreStash, stashChanges } =
  await import("../host/lib/git/stash.ts");

const git = sandboxGit(gitEnv);

const { check, done, fail } = makeProof("git-history proof");
console.log("git-history proof\n");

const read = (repo: string, path: string): string =>
  readFileSync(join(repo, path), "utf8");
const write = (repo: string, path: string, text: string): void =>
  writeFileSync(join(repo, path), text);
const rev = (repo: string, ref: string): string =>
  git(repo, "rev-parse", "--short", ref).trim();
const subjects = (repo: string): string[] =>
  git(repo, "log", "--format=%s").trim().split("\n");
const commit = (repo: string, path: string, text: string, msg: string) => {
  write(repo, path, text);
  git(repo, "add", path);
  git(repo, "commit", "-q", "-m", msg);
  return rev(repo, "HEAD");
};

// main with three commits: init (a.txt), Second (b.txt), Third (c.txt).
function seedRepo(track: Track): string {
  const repo = tempDir("sm-history-", track);
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "a.txt", "a\n", "init");
  commit(repo, "b.txt", "b\n", "Second");
  commit(repo, "c.txt", "c\n", "Third");
  return repo;
}

async function main() {
  await check("revert adds a commit undoing the one named", async (track) => {
    const repo = seedRepo(track);
    await revertCommit(repo, rev(repo, "HEAD~1"));
    assert.equal(subjects(repo)[0], 'Revert "Second"');
    assert.equal(git(repo, "ls-files").includes("b.txt"), false);
  });

  await check(
    "a revert that conflicts aborts and leaves the branch as it was",
    async (track) => {
      const repo = seedRepo(track);
      const edit = commit(repo, "a.txt", "edited\n", "Edit a");
      commit(repo, "a.txt", "edited again\n", "Edit a again");
      const head = rev(repo, "HEAD");
      await assert.rejects(
        revertCommit(repo, edit),
        /conflicts with this branch, so nothing was changed/,
      );
      assert.equal(rev(repo, "HEAD"), head);
      assert.equal(git(repo, "status", "--porcelain"), "");
    },
  );

  await check(
    "cherry-pick copies a commit from another worktree's branch",
    async (track) => {
      const repo = seedRepo(track);
      const other = join(tempDir("sm-history-wt-", track), "wt");
      git(repo, "worktree", "add", "-q", "-b", "side", other, "HEAD~2");
      const picked = rev(repo, "HEAD");
      await cherryPickCommit(other, picked);
      assert.equal(subjects(other)[0], "Third");
      assert.equal(read(other, "c.txt"), "c\n");
      // A second pick of the same change conflicts with nothing but
      // comes out empty, which git refuses: aborted all the same.
      const head = rev(other, "HEAD");
      await assert.rejects(
        cherryPickCommit(other, picked),
        /already on this branch/,
      );
      assert.equal(rev(other, "HEAD"), head);
      assert.equal(git(other, "status", "--porcelain"), "");
    },
  );

  await check(
    "reword rewrites one message and keeps the trees, the newer commits and the working tree",
    async (track) => {
      const repo = seedRepo(track);
      const tree = rev(repo, "HEAD^{tree}");
      write(repo, "a.txt", "uncommitted\n");
      git(repo, "add", "a.txt");
      write(repo, "a.txt", "uncommitted, edited since\n");
      await rewordCommit(
        repo,
        rev(repo, "HEAD~1"),
        { summary: "Second, reworded", description: "With a body." },
        rev(repo, "HEAD"),
      );
      assert.deepEqual(subjects(repo), ["Third", "Second, reworded", "init"]);
      assert.equal(
        git(repo, "log", "-1", "--format=%B", "HEAD~1").trim(),
        "Second, reworded\n\nWith a body.",
      );
      assert.equal(rev(repo, "HEAD^{tree}"), tree);
      assert.equal(read(repo, "a.txt"), "uncommitted, edited since\n");
      assert.equal(
        git(repo, "diff", "--cached", "--name-only").trim(),
        "a.txt",
      );
    },
  );

  await check("reword works on the root commit", async (track) => {
    const repo = seedRepo(track);
    await rewordCommit(
      repo,
      rev(repo, "HEAD~2"),
      { summary: "Root" },
      rev(repo, "HEAD"),
    );
    assert.deepEqual(subjects(repo), ["Third", "Second", "Root"]);
  });

  await check(
    "squash folds a commit into the one before it, both messages kept",
    async (track) => {
      const repo = seedRepo(track);
      const tree = rev(repo, "HEAD^{tree}");
      await squashIntoParent(repo, rev(repo, "HEAD~1"), rev(repo, "HEAD"));
      assert.deepEqual(subjects(repo), ["Third", "init"]);
      assert.equal(
        git(repo, "log", "-1", "--format=%B", "HEAD~1").trim(),
        "init\n\nSecond",
      );
      assert.equal(rev(repo, "HEAD^{tree}"), tree);
      assert.equal(git(repo, "show", "HEAD~1:b.txt"), "b\n");
    },
  );

  await check(
    "rewrites are refused once HEAD moved, off the line, or across a merge",
    async (track) => {
      const repo = seedRepo(track);
      const loaded = rev(repo, "HEAD");
      commit(repo, "d.txt", "d\n", "Fourth");
      await assert.rejects(
        rewordCommit(repo, rev(repo, "HEAD~1"), { summary: "x" }, loaded),
        /moved on/,
      );
      git(repo, "checkout", "-q", "-b", "side", "HEAD~2");
      const offLine = commit(repo, "e.txt", "e\n", "Side");
      git(repo, "checkout", "-q", "main");
      await assert.rejects(
        rewordCommit(repo, offLine, { summary: "x" }, rev(repo, "HEAD")),
        /isn't on this branch/,
      );
      git(repo, "merge", "-q", "--no-edit", "side");
      await assert.rejects(
        squashIntoParent(repo, rev(repo, "HEAD~1"), rev(repo, "HEAD")),
        /merge commit/,
      );
    },
  );

  await check(
    "stashes are listed per branch, and apply, pop and drop go by hash",
    async (track) => {
      const repo = seedRepo(track);
      write(repo, "a.txt", "first stash\n");
      write(repo, "new.txt", "untracked\n");
      await stashChanges(repo, "Named");
      assert.equal(git(repo, "status", "--porcelain"), "");
      write(repo, "b.txt", "second stash\n");
      await stashChanges(repo, undefined);
      git(repo, "checkout", "-q", "-b", "other");
      write(repo, "c.txt", "elsewhere\n");
      await stashChanges(repo, "On other");
      git(repo, "checkout", "-q", "main");

      const stashes = await listStashes(repo, "main");
      assert.deepEqual(
        stashes.map((s) => [s.message, s.named]),
        [
          ["Third", false],
          ["Named", true],
        ],
      );
      const [unnamed = "", named = ""] = stashes.map((s) => s.hash);
      assert.deepEqual(
        (await listStashes(repo, "other")).map((s) => s.message),
        ["On other"],
      );

      // Pop the older one while a newer one sits above it in the list.
      await applyStash(repo, named, true);
      assert.equal(read(repo, "a.txt"), "first stash\n");
      assert.equal(read(repo, "new.txt"), "untracked\n");
      assert.deepEqual(
        (await listStashes(repo, "main")).map((s) => s.hash),
        [unnamed],
      );

      git(repo, "stash", "push", "-q", "-u");
      await applyStash(repo, unnamed, false);
      assert.equal(read(repo, "b.txt"), "second stash\n");
      assert.equal((await listStashes(repo, "main")).length, 2);

      await dropStash(repo, unnamed);
      assert.equal(
        (await listStashes(repo, "main")).some((s) => s.hash === unnamed),
        false,
      );
      await assert.rejects(dropStash(repo, unnamed), /gone/);
      // A drop's undo lists it again, on top, on the same branch.
      await restoreStash(repo, "main", unnamed, {
        message: "Third",
        named: false,
      });
      const restored = await listStashes(repo, "main");
      assert.equal(restored.length, 2);
      assert.deepEqual(restored[0] && { ...restored[0], date: "" }, {
        hash: unnamed,
        message: "Third",
        named: false,
        date: "",
      });
    },
  );

  await check(
    "a pop that conflicts keeps the stash and says so",
    async (track) => {
      const repo = seedRepo(track);
      write(repo, "a.txt", "stashed\n");
      await stashChanges(repo, "Mine");
      commit(repo, "a.txt", "committed since\n", "Meanwhile");
      const [stash] = await listStashes(repo, "main");
      await assert.rejects(applyStash(repo, stash?.hash ?? "", true), /kept/);
      assert.equal((await listStashes(repo, "main")).length, 1);
    },
  );

  done();
}

main().catch(fail);
