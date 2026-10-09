// Durable proof for the Git section's commit menu, stashes and
// conflicts (host/lib/git/history.ts, stash.ts, operation.ts, and the
// sync from primary in sync.ts) against a REAL
// repository: revert and cherry-pick with their conflict abort, reword
// and squash of local commits leaving the working tree alone with every
// refusal (moved HEAD, a merge, a commit off the line), stashes listed
// per branch, applied, popped and dropped by hash, and a sync that
// conflicts: refused clean, then merged anyway, settled file by file
// and continued, or a rebase settled with the sides the right way round,
// or aborted. A sync rebases only commits that are pushed nowhere and
// hold no merge, and merges otherwise, and a split with the upstream
// that conflicts merges and stops.
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
const {
  applyStash,
  dropStash,
  listStashes,
  readStashDiff,
  restoreStash,
  stashChanges,
} = await import("../host/lib/git/stash.ts");

const { abortOperation, continueOperation, readOperation, resolveConflict } =
  await import("../host/lib/git/operation.ts");
const {
  mergePrimaryKeepingConflicts,
  mergeUpstreamKeepingConflicts,
  pullRebaseOrMergeAndPush,
  syncWithPrimary,
} = await import("../host/lib/git/sync.ts");
const { isSyncConflictsError } = await import("../shared/errors.ts");
const { listCommits, readBranchHistory } =
  await import("../host/lib/git/worktrees.ts");

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
      // What a stash holds reads as one patch, untracked files and all.
      const held = await readStashDiff(repo, named);
      assert.match(held, /\+first stash/);
      assert.match(held, /new file mode[\s\S]*\+untracked/);
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

  await check(
    "the timeline reads a branch's own commits back to where it left main, and its upstream",
    async (track) => {
      const repo = seedRepo(track);
      const fork = rev(repo, "HEAD");
      const remote = tempDir("sm-history-remote-", track);
      git(remote, "init", "-q", "--bare");
      git(repo, "remote", "add", "origin", remote);
      git(repo, "checkout", "-q", "-b", "feature");
      commit(repo, "d.txt", "d\n", "Fourth");
      git(repo, "push", "-q", "-u", "origin", "feature");
      commit(repo, "e.txt", "e\n", "Fifth");
      git(repo, "checkout", "-q", "main");
      commit(repo, "a.txt", "main moved\n", "Main moves on");
      git(repo, "checkout", "-q", "feature");

      const history = await readBranchHistory(repo, {
        base: "main",
        count: 50,
      });
      assert.deepEqual(
        history.commits.map((c) => c.subject),
        ["Fifth", "Fourth"],
      );
      assert.deepEqual(history.base, { ref: "main", hash: fork });
      assert.equal(history.upstream, "origin/feature");
      assert.equal(history.more, false);

      const cut = await readBranchHistory(repo, { base: "main", count: 1 });
      assert.deepEqual(
        cut.commits.map((c) => c.subject),
        ["Fifth"],
      );
      assert.equal(cut.more, true);

      // No base: HEAD's newest, and no upstream on main.
      git(repo, "checkout", "-q", "main");
      const plain = await readBranchHistory(repo, {
        base: undefined,
        count: 2,
      });
      assert.deepEqual(
        plain.commits.map((c) => c.subject),
        ["Main moves on", "Third"],
      );
      assert.equal(plain.base, null);
      assert.equal(plain.upstream, null);

      // The history before the branch: from where it left main.
      const earlier = await listCommits(repo, {
        skip: 0,
        count: 10,
        from: fork,
      });
      assert.deepEqual(
        earlier.map((c) => c.subject),
        ["Third", "Second", "init"],
      );
    },
  );

  await check(
    "against a split upstream, the history says what each side alone holds and where they last agreed",
    async (track) => {
      const repo = seedRepo(track);
      const remote = tempDir("sm-history-remote-", track);
      git(remote, "init", "-q", "--bare");
      git(repo, "remote", "add", "origin", remote);
      git(repo, "checkout", "-q", "-b", "feature");
      const fourth = commit(repo, "d.txt", "d\n", "Fourth");
      git(repo, "push", "-q", "-u", "origin", "feature");
      // A teammate pushes on top of Fourth from a clone of their own.
      const theirs = join(tempDir("sm-history-theirs-", track), "theirs");
      git(repo, "clone", "-q", "-b", "feature", remote, theirs);
      commit(theirs, "t.txt", "t\n", "Theirs");
      git(theirs, "push", "-q", "origin", "feature");
      const fifth = commit(repo, "e.txt", "e\n", "Fifth");
      git(repo, "fetch", "-q", "origin");

      const history = await readBranchHistory(repo, {
        base: "main",
        count: 50,
      });
      assert.deepEqual(history.unpushed, [fifth]);
      assert.deepEqual(
        history.incoming.map((c) => c.subject),
        ["Theirs"],
      );
      assert.equal(history.incomingMore, false);
      assert.equal(history.upstreamFork, fourth);

      // In step with the upstream: nothing either way.
      git(repo, "reset", "-q", "--hard", "origin/feature");
      const even = await readBranchHistory(repo, { base: "main", count: 50 });
      assert.deepEqual(even.unpushed, []);
      assert.deepEqual(even.incoming, []);
    },
  );

  // A feature branch pushed to a bare origin, with `main` moved on
  // after it (Main, m.txt), checked out on feature.
  function seedPushed(track: Track): { repo: string; remote: string } {
    const repo = seedRepo(track);
    const remote = tempDir("sm-history-remote-", track);
    git(remote, "init", "-q", "--bare");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "checkout", "-q", "-b", "feature");
    commit(repo, "d.txt", "d\n", "Fourth");
    git(repo, "push", "-q", "-u", "origin", "feature");
    git(repo, "checkout", "-q", "main");
    commit(repo, "m.txt", "m\n", "Main");
    git(repo, "checkout", "-q", "feature");
    return { repo, remote };
  }

  const parentCount = (repo: string): number =>
    git(repo, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ")
      .length - 1;

  await check(
    "a sync from primary merges once the branch's commits are pushed, and rebases those that aren't",
    async (track) => {
      const { repo } = seedPushed(track);
      const pushed = rev(repo, "HEAD");
      await syncWithPrimary(repo, repo, "main");
      assert.equal(parentCount(repo), 2);
      assert.equal(rev(repo, "HEAD^1"), pushed);

      // Pushed to a remote branch it doesn't track counts as pushed.
      const elsewhere = seedRepo(track);
      git(elsewhere, "checkout", "-q", "-b", "feature");
      commit(elsewhere, "d.txt", "d\n", "Fourth");
      git(elsewhere, "update-ref", "refs/remotes/origin/copy", "HEAD");
      git(elsewhere, "checkout", "-q", "main");
      commit(elsewhere, "m.txt", "m\n", "Main");
      git(elsewhere, "checkout", "-q", "feature");
      git(elsewhere, "config", "merge.ff", "only");
      await syncWithPrimary(elsewhere, elsewhere, "main");
      assert.equal(parentCount(elsewhere), 2);

      const fresh = seedRepo(track);
      git(fresh, "checkout", "-q", "-b", "feature");
      commit(fresh, "d.txt", "d\n", "Fourth");
      git(fresh, "checkout", "-q", "main");
      commit(fresh, "m.txt", "m\n", "Main");
      git(fresh, "checkout", "-q", "feature");
      await syncWithPrimary(fresh, fresh, "main");
      assert.equal(parentCount(fresh), 1);
      assert.equal(rev(fresh, "HEAD^1"), rev(fresh, "main"));
    },
  );

  await check(
    "a pull and push keeps a merge the branch holds rather than flattening it",
    async (track) => {
      const { repo, remote } = seedPushed(track);
      const theirs = join(tempDir("sm-history-theirs-", track), "theirs");
      git(repo, "clone", "-q", "-b", "feature", remote, theirs);
      commit(theirs, "t.txt", "t\n", "Theirs");
      git(theirs, "push", "-q", "origin", "feature");
      git(repo, "merge", "-q", "--no-edit", "main");
      const merge = rev(repo, "HEAD");
      await pullRebaseOrMergeAndPush(repo);
      assert.equal(parentCount(repo), 2);
      assert.equal(rev(repo, "HEAD^1"), merge);
      assert.equal(rev(repo, "HEAD"), rev(repo, "origin/feature"));
    },
  );

  await check(
    "a split with the upstream that conflicts merges and stops on the conflicts",
    async (track) => {
      const { repo, remote } = seedPushed(track);
      const theirs = join(tempDir("sm-history-theirs-", track), "theirs");
      git(repo, "clone", "-q", "-b", "feature", remote, theirs);
      commit(theirs, "a.txt", "theirs\n", "Theirs");
      git(theirs, "push", "-q", "origin", "feature");
      commit(repo, "a.txt", "mine\n", "Mine");
      assert.equal(await mergeUpstreamKeepingConflicts(repo), true);
      assert.deepEqual(await readOperation(repo), {
        operation: "merge",
        continuable: true,
        conflicted: 1,
        rebasing: null,
      });
    },
  );

  // main and a side branch that both edited a.txt.
  function seedConflict(track: Track): string {
    const repo = seedRepo(track);
    git(repo, "checkout", "-q", "-b", "side");
    commit(repo, "a.txt", "side\n", "Side edit");
    git(repo, "checkout", "-q", "main");
    commit(repo, "a.txt", "main\n", "Main edit");
    git(repo, "checkout", "-q", "side");
    return repo;
  }

  await check(
    "a sync from primary that conflicts is refused with the tree as it was",
    async (track) => {
      const repo = seedConflict(track);
      const head = rev(repo, "HEAD");
      await assert.rejects(syncWithPrimary(repo, repo, "main"), (err) =>
        isSyncConflictsError(err),
      );
      assert.equal(rev(repo, "HEAD"), head);
      assert.deepEqual(await readOperation(repo), {
        operation: null,
        continuable: false,
        conflicted: 0,
        rebasing: null,
      });
    },
  );

  await check(
    "merged anyway, the conflict is settled with this branch's side and the merge continues",
    async (track) => {
      const repo = seedConflict(track);
      await mergePrimaryKeepingConflicts(repo, repo, "main");
      assert.deepEqual(await readOperation(repo), {
        operation: "merge",
        continuable: true,
        conflicted: 1,
        rebasing: null,
      });
      await assert.rejects(continueOperation(repo), /Resolve/);
      await resolveConflict(repo, "a.txt", "mine");
      assert.equal(read(repo, "a.txt"), "side\n");
      assert.equal((await readOperation(repo)).conflicted, 0);
      await continueOperation(repo);
      assert.equal(
        git(repo, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ")
          .length,
        3,
      );
      assert.equal((await readOperation(repo)).operation, null);
    },
  );

  await check(
    "in a rebase, mine is the worktree's own commit, and abort puts it back",
    async (track) => {
      const repo = seedConflict(track);
      const head = rev(repo, "HEAD");
      assert.throws(() => git(repo, "rebase", "main"));
      assert.equal((await readOperation(repo)).operation, "rebase");
      assert.equal((await readOperation(repo)).rebasing, "side");
      await resolveConflict(repo, "a.txt", "mine");
      assert.equal(read(repo, "a.txt"), "side\n");
      await abortOperation(repo);
      assert.equal(rev(repo, "HEAD"), head);
      assert.equal((await readOperation(repo)).operation, null);

      assert.throws(() => git(repo, "rebase", "main"));
      await resolveConflict(repo, "a.txt", "theirs");
      assert.equal(read(repo, "a.txt"), "main\n");
      // Taking main's side leaves the commit empty, and the continue
      // drops it: the branch ends up on main.
      await continueOperation(repo);
      assert.equal((await readOperation(repo)).operation, null);
      assert.equal(rev(repo, "HEAD"), rev(repo, "main"));
    },
  );

  await check(
    "a conflict settled in an editor is taken as it stands",
    async (track) => {
      const repo = seedConflict(track);
      await mergePrimaryKeepingConflicts(repo, repo, "main");
      writeFileSync(join(repo, "a.txt"), "both\n");
      await resolveConflict(repo, "a.txt", "as-is");
      assert.equal((await readOperation(repo)).conflicted, 0);
      assert.equal(git(repo, "show", ":a.txt"), "both\n");
    },
  );

  done();
}

main().catch(fail);
