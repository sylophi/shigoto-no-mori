// Durable proof for the per-project git-directory watcher
// (main/electron/gitWatcher.ts) against a REAL git repository with a
// linked worktree: a commit made in the worktree, a checkout there and
// a branch deleted from the main checkout each surface as exactly one
// project-scoped change, while the churn the allowlist exists to
// ignore (`git status` refreshing the index, objects written, lock
// files, a file edit in the working tree) surfaces as none. The
// watcher's loop-safety rests on that allowlist (the app's own
// `git status` must never feed a refetch that feeds a `git status`),
// so this is where it is pinned. Also covered: gitDirOf resolving a
// linked worktree's `.git` file to the repository's common dir, and
// the reconcile dropping a project that left the registry.
//
// Runs under scripts/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. See package.json "gitwatch:check".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitDirOf,
  isRelevantGitPath,
  reconcileGitWatchers,
  startGitWatcher,
  stopGitWatcher,
} from "../main/electron/gitWatcher.ts";
import { delay, makeProof, scrubbedGitEnv, waitFor } from "./lib/checkKit.mjs";

// The sandbox's git commands run under the scrubbed environment: this
// check runs from the pre-commit hook, whose GIT_* variables would
// otherwise point every command below at the commit in progress.
const gitEnv = scrubbedGitEnv();

function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=sm", "-c", "user.email=sm@example.test", ...args],
    { cwd, env: gitEnv, encoding: "utf8" },
  );
}

const { check, done, fail } = makeProof("git-watcher proof");

async function main() {
  console.log("git-watcher proof\n");

  await check(
    "allowlist: refs, HEAD, packed-refs and a worktree's HEAD count, while objects, logs, index, FETCH_HEAD and lock files do not",
    async () => {
      for (const path of [
        "HEAD",
        "ORIG_HEAD",
        "packed-refs",
        "refs",
        "refs/heads/main",
        "refs/remotes/origin/main",
        "worktrees/feat",
        "worktrees/feat/HEAD",
        "worktrees\\feat\\HEAD",
      ]) {
        assert.ok(isRelevantGitPath(path), `${path} must count`);
      }
      for (const path of [
        "index",
        "FETCH_HEAD",
        "COMMIT_EDITMSG",
        "config",
        "objects/ab/cdef0123",
        "logs/HEAD",
        "logs/refs/heads/main",
        "refs/heads/main.lock",
        "HEAD.lock",
        "packed-refs.lock",
        "worktrees/feat/index",
        "worktrees/feat/logs/HEAD",
        "worktrees/feat/COMMIT_EDITMSG",
      ]) {
        assert.ok(!isRelevantGitPath(path), `${path} must not count`);
      }
    },
  );

  await check(
    "real repository: a commit, a checkout and a branch delete each land as one project change, while status, objects and working-tree edits land as none, and a project leaving the registry stops its watch",
    async (track) => {
      // realpath: macOS puts tmpdir behind a symlink and git records the real
      // path in a worktree's .git file, so the paths compared below must
      // agree on it.
      const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-gitwatch-")));
      track(() => rmSync(root, { recursive: true, force: true }));
      const repo = join(root, "repo");
      const worktree = join(root, "feat");
      git(root, "init", "-q", "-b", "main", repo);
      writeFileSync(join(repo, "a.txt"), "one\n");
      git(repo, "add", "a.txt");
      git(repo, "commit", "-q", "-m", "one");
      git(repo, "worktree", "add", "-q", "-b", "feat", worktree);

      assert.equal(
        gitDirOf(worktree),
        join(repo, ".git"),
        "a linked worktree's .git file must resolve to the common dir",
      );
      assert.equal(gitDirOf(repo), join(repo, ".git"));
      assert.equal(gitDirOf(join(root, "nowhere")), null);

      const changes = [];
      let projects = [{ id: "p1", name: "repo", path: repo }];
      // (Re)start the watcher over the sandbox and let the platform
      // watcher settle before producing events.
      const restart = async (suppressed = false) => {
        stopGitWatcher();
        startGitWatcher({
          onChange: (projectId) => changes.push(projectId),
          suppressed: () => suppressed,
          projects: () => projects,
        });
        await delay(150);
      };
      track(() => stopGitWatcher());
      await restart();

      // Noise first: status refreshes, a working-tree edit, and the
      // objects a `git add` writes, none of which may ping.
      git(worktree, "status", "--porcelain");
      writeFileSync(join(worktree, "b.txt"), "two\n");
      git(worktree, "status", "--porcelain");
      git(worktree, "add", "b.txt");
      await delay(700);
      assert.deepEqual(
        changes,
        [],
        "status, an edit and a staged add must not ping (they would loop)",
      );

      // A commit in the linked worktree moves refs/heads/feat.
      git(worktree, "commit", "-q", "-m", "two");
      await waitFor(() => changes.length >= 1, "the commit to ping");
      await delay(350);
      assert.deepEqual(changes, ["p1"], "one debounced ping per commit");

      // A checkout in the worktree moves worktrees/feat/HEAD.
      git(worktree, "checkout", "-q", "-b", "other");
      await waitFor(() => changes.length >= 2, "the checkout to ping");
      await delay(350);
      assert.deepEqual(changes, ["p1", "p1"]);

      // A branch deleted from the main checkout moves refs/heads.
      git(repo, "branch", "-D", "feat");
      await waitFor(() => changes.length >= 3, "the branch delete to ping");
      await delay(350);
      assert.deepEqual(changes, ["p1", "p1", "p1"]);

      // Suppressed events (a running sm CLI child) never ping.
      await restart(true);
      writeFileSync(join(worktree, "c.txt"), "three\n");
      git(worktree, "add", "c.txt");
      git(worktree, "commit", "-q", "-m", "three");
      await delay(700);
      assert.equal(changes.length, 3, "a suppressed commit must not ping");

      // The project leaves the registry: its watch closes and a later
      // commit is not observed.
      await restart();
      projects = [];
      reconcileGitWatchers();
      writeFileSync(join(worktree, "d.txt"), "four\n");
      git(worktree, "add", "d.txt");
      git(worktree, "commit", "-q", "-m", "four");
      await delay(700);
      assert.equal(
        changes.length,
        3,
        "a project dropped from the registry must not ping",
      );
    },
  );

  done();
}

main().catch(fail);
