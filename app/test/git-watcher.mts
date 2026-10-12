// Durable proof for the per-project git-directory watcher
// (host/lib/GitWatcher.ts) against a REAL git repository with a
// linked worktree: a commit made in the worktree, a checkout there and
// a branch deleted from the main checkout each surface as exactly one
// project-scoped change, while the churn the allowlist exists to
// ignore (`git status` refreshing the index, objects written, lock
// files, a file edit in the working tree) surfaces as none. The
// watcher's loop-safety rests on that allowlist (the app's own
// `git status` must never feed a refetch that feeds a `git status`),
// so this is where it is pinned. Also covered: refsDirOf resolving a
// linked worktree's `.git` file to the repository's common dir, the
// reconcile dropping a project that left the registry, and the working
// trees' watch: an edit in the main checkout or a linked worktree
// lands as one files change, `.git` churn as none, and a worktree
// added or removed is followed.
//
// Run: pnpm test git-watcher.
import assert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { mkdirSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isRelevantGitPath,
  isWorkingTreeChange,
  refsDirOf,
  GitWatcher,
  layer as gitWatcherLayer,
} from "../host/lib/GitWatcher.ts";
import {
  delay,
  sandboxGit,
  scrubbedGitEnv,
  tempDir,
  waitFor,
} from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";
import { it } from "vitest";

// The sandbox's git commands run under the scrubbed environment: this
// check runs from the pre-commit hook, whose GIT_* variables would
// otherwise point every command below at the commit in progress.
const gitEnv = scrubbedGitEnv();

const git = sandboxGit(gitEnv);

// FSEvents hands a new watch the events from just before it began, so
// the setup's own ref writes could reach the watcher as a ping. Once a
// throwaway watch on the same directory sees a marker written now,
// every earlier write is behind it, and a watch started after that
// sees none of them. Each call has a marker of its own, so an earlier
// call's late events cannot stand in for it.
let markers = 0;
async function caughtUp(gitDir: string): Promise<void> {
  const name = `sm-check-marker-${markers++}`;
  let seen = false;
  const marker = watch(
    gitDir,
    { recursive: true, persistent: false },
    (_event, file) => {
      if (file === name) seen = true;
    },
  );
  try {
    let writes = 0;
    await waitFor(() => {
      if (!seen) writeFileSync(join(gitDir, name), String(writes++));
      return seen;
    }, "the git directory's watch to catch up");
  } finally {
    marker.close();
  }
}

it("allowlist: refs, HEAD, packed-refs, a worktree's HEAD and a stopped operation's markers count, while objects, logs, index, FETCH_HEAD and lock files do not", async () => {
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
    "MERGE_HEAD",
    "SQUASH_MSG",
    "rebase-merge",
    "worktrees/feat/MERGE_HEAD",
    "worktrees/feat/rebase-apply",
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
    "rebase-merge/done",
    "worktrees/feat/rebase-merge/msgnum",
  ]) {
    assert.ok(!isRelevantGitPath(path), `${path} must not count`);
  }
});

it("working trees: a file anywhere counts, and anything under a .git does not", () => {
  for (const path of [
    "a.txt",
    "src/b.ts",
    "node_modules/x/y.js",
    ".github/ci.yml",
    ".gitignore",
  ]) {
    assert.ok(isWorkingTreeChange(path), `${path} must count`);
  }
  for (const path of [
    ".git",
    ".git/index",
    ".git/objects/ab/cd",
    "sub/.git",
    "sub/.git/index",
    "sub\\.git\\HEAD",
  ]) {
    assert.ok(!isWorkingTreeChange(path), `${path} must not count`);
  }
});

const refsDir = (path: string) =>
  Effect.runPromise(refsDirOf(path).pipe(Effect.provide(NodeServices.layer)));

it("real repository: a commit, a checkout and a branch delete each land as one project change, while status, objects and working-tree edits land as none, and a project leaving the registry stops its watch", async () => {
  // realpath: macOS puts tmpdir behind a symlink and git records the real
  // path in a worktree's .git file, so the paths compared below must
  // agree on it.
  const root = tempDir("sm-gitwatch-", trackTest);
  const repo = join(root, "repo");
  const worktree = join(root, "feat");
  git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "one");
  git(repo, "worktree", "add", "-q", "-b", "feat", worktree);

  assert.equal(
    await refsDir(worktree),
    join(repo, ".git"),
    "a linked worktree's .git file must resolve to the common dir",
  );
  assert.equal(await refsDir(repo), join(repo, ".git"));
  assert.equal(await refsDir(join(root, "nowhere")), null);

  const changes: string[] = [];
  const edits: string[] = [];
  let projects = [{ id: "p1", name: "repo", path: repo }];
  // (Re)start the watcher over the sandbox, past what came before, and
  // let the platform watcher settle before producing events.
  let runtime: ManagedRuntime.ManagedRuntime<GitWatcher, never> | null = null;
  const running = () => {
    assert.ok(runtime !== null, "the watcher is not running");
    return runtime;
  };
  const stop = async () => {
    await runtime?.dispose();
    runtime = null;
  };
  const restart = async () => {
    await stop();
    await caughtUp(join(repo, ".git"));
    runtime = ManagedRuntime.make(
      gitWatcherLayer({
        onChange: (projectId) => changes.push(projectId),
        onFilesChanged: (projectId) => edits.push(projectId),
        projects: () => projects,
      }).pipe(Layer.provide(NodeServices.layer)),
    );
    await runtime.context();
    await delay(150);
  };
  trackTest(stop);
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
  await waitFor(() => edits.length >= 1, "the edit to land");
  await delay(1200);
  assert.deepEqual(edits, ["p1"], "the edit lands as one files change");

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

  // Edits in either working tree land as files changes, and `.git`
  // churn (status refreshing the main checkout's index) as none.
  edits.length = 0;
  git(repo, "status", "--porcelain");
  await delay(1500);
  assert.deepEqual(edits, [], "the main checkout's .git churn is no edit");
  writeFileSync(join(repo, "c.txt"), "three\n");
  await waitFor(() => edits.length >= 1, "the main checkout's edit");
  writeFileSync(join(worktree, "c.txt"), "three\n");
  await waitFor(() => edits.length >= 2, "the linked worktree's edit");
  await delay(1200);
  assert.deepEqual(edits, ["p1", "p1"]);

  // A worktree kept inside the main checkout counts once, by the main
  // checkout's watch.
  const nested = join(repo, "nested");
  git(repo, "worktree", "add", "-q", "-b", "nested", nested);
  await waitFor(() => changes.length >= 4, "the nested worktree to ping");
  await delay(1500);
  edits.length = 0;
  writeFileSync(join(nested, "n.txt"), "nested\n");
  await waitFor(() => edits.length >= 1, "the nested worktree's edit");
  await delay(1500);
  assert.deepEqual(edits, ["p1"], "an edit in a nested worktree counts once");
  git(repo, "worktree", "remove", "--force", nested);
  await waitFor(() => changes.length >= 5, "the nested removal to ping");

  // A worktree added after the watch began is followed, and one
  // removed stops being watched.
  const later = join(root, "later");
  git(repo, "worktree", "add", "-q", "-b", "later", later);
  await waitFor(() => changes.length >= 6, "the new worktree to ping");
  await delay(350);
  edits.length = 0;
  writeFileSync(join(later, "e.txt"), "five\n");
  await waitFor(() => edits.length >= 1, "the added worktree's edit");
  git(repo, "worktree", "remove", "--force", later);
  await waitFor(() => changes.length >= 7, "the removal to ping");
  await delay(350);
  edits.length = 0;
  mkdirSync(later);
  writeFileSync(join(later, "f.txt"), "six\n");
  await delay(1500);
  assert.deepEqual(edits, [], "a removed worktree is no longer watched");

  // The project leaves the registry: its watch closes and a later
  // commit is not observed.
  await restart();
  projects = [];
  await running().runPromise(
    Effect.gen(function* () {
      yield* (yield* GitWatcher).reconcile;
    }),
  );
  const before = changes.length;
  edits.length = 0;
  writeFileSync(join(worktree, "d.txt"), "four\n");
  git(worktree, "add", "d.txt");
  git(worktree, "commit", "-q", "-m", "four");
  await delay(1500);
  assert.equal(
    changes.length,
    before,
    "a project dropped from the registry must not ping",
  );
  assert.deepEqual(edits, [], "nor report its edits");
});
