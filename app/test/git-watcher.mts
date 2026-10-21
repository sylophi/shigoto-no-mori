// Durable proof for the per-project git-directory watcher
// (host/lib/GitWatcher.ts) against a REAL git repository with a
// linked worktree: a commit made in the worktree, a checkout there and
// a branch deleted from the main checkout each surface as exactly one
// project-scoped change, while the churn the allowlist exists to
// ignore (`git status` refreshing the index, objects written, lock
// files, a file edit in the working tree, the app's own refs)
// surfaces as none. The watcher's loop-safety rests on that allowlist
// (the app's own `git status` must never feed a refetch that feeds a
// `git status`), so this is where it is pinned. Also covered:
// commonDirOf resolving a linked worktree's `.git` file to the
// repository's common dir, the reconcile dropping a project that left
// the registry, and the working trees' watch: an edit in the main
// checkout or a linked worktree lands as one files change, `.git`
// churn as none, and a worktree added or removed is followed. A
// checkout's index written is a signal of its own: a burst of writes is
// one, a burst with a ref in it is the project change alone, and the
// app's own reads of the changes and the operation write none. And the
// backstop: with the git directory's events lost on purpose, a stage is
// found as its index alone, a ref and an index moved together are the
// project change alone, a ref move a beat finds while the watch hears
// an index is still said, a commit is still signalled, once, a ref
// directory appearing or going (a namespace, a remote, one with no
// ref), a ref moving inside one and a checkout are signalled, an own
// ref and a ref directory's churn not at all, a working tree whose
// watch ended is watched again, and the mirror's index watch fires for
// a stage it never heard.
//
// Run: pnpm test git-watcher.
import assert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { mkdirSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Git from "@shigomori/engine/Git";
import {
  isIndexPath,
  isRelevantGitPath,
  isWorkingTreeChange,
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
import { runHost } from "./lib/hostRuntime.mts";
import { watchIndexFile } from "../host/mirror/gitState.ts";
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

it("allowlist: refs, HEAD, packed-refs, a worktree's HEAD and a stopped operation's markers count, while objects, logs, index, FETCH_HEAD, lock files and the app's own refs do not, and a checkout's index is its own signal", async () => {
  for (const path of [
    "HEAD",
    "ORIG_HEAD",
    "packed-refs",
    "refs",
    "refs/heads/main",
    "refs/remotes/origin/main",
    "refs/shigomori-feat/x",
    "refs/shigomorix",
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
    "refs/shigomori",
    "refs/shigomori/dirty/0123456789ab",
    "refs/shigomori/incoming/feat",
    "refs/shigomori/index/0123456789ab",
    "refs\\shigomori\\discards\\1",
  ]) {
    assert.ok(!isRelevantGitPath(path), `${path} must not count`);
  }
  // A checkout's index is a signal of its own.
  for (const path of [
    "index",
    "worktrees/feat/index",
    "worktrees\\feat\\index",
  ]) {
    assert.ok(isIndexPath(path), `${path} is an index`);
  }
  for (const path of [
    "index.lock",
    "worktrees/feat/index.lock",
    "sharedindex.0123",
    "logs/index",
    "refs/heads/index",
    "worktrees/index",
    "worktrees/feat/sub/index",
  ]) {
    assert.ok(!isIndexPath(path), `${path} is no index`);
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

const commonDir = (path: string) =>
  Effect.runPromise(
    Git.commonDirOf(path).pipe(Effect.provide(NodeServices.layer)),
  );

// Every index signal the watcher gives from now on, while it runs.
const indexSignals = async (
  runtime: ManagedRuntime.ManagedRuntime<GitWatcher, never>,
) => {
  const heard: string[] = [];
  const subscribed = Effect.runSync(Deferred.make<void>());
  runtime.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const written = yield* (yield* GitWatcher).indexWritten;
        yield* Deferred.succeed(subscribed, undefined);
        yield* Stream.runForEach(written, (projectId) =>
          Effect.sync(() => {
            heard.push(projectId);
          }),
        );
      }),
    ),
  );
  await Effect.runPromise(Deferred.await(subscribed));
  return heard;
};

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
    await commonDir(worktree),
    join(repo, ".git"),
    "a linked worktree's .git file must resolve to the common dir",
  );
  assert.equal(await commonDir(repo), join(repo, ".git"));
  assert.equal(await commonDir(join(root, "nowhere")), null);

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
        // The events alone: the backstop's own proof is below.
        backstop: "1 hour",
      }).pipe(Layer.provide(NodeServices.layer)),
    );
    await runtime.context();
    await delay(150);
  };
  trackTest(stop);
  await restart();
  const indexed = await indexSignals(running());

  // Noise first: status refreshes, a working-tree edit, and the
  // objects a `git add` writes, none of which may ping. The stage
  // writes the worktree's index, which is its own signal.
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
  await waitFor(() => indexed.length >= 1, "the stage to signal its index");
  assert.ok(indexed.every((projectId) => projectId === "p1"));
  await waitFor(() => edits.length >= 1, "the edit to land");
  await delay(1200);
  assert.deepEqual(edits, ["p1"], "the edit lands as one files change");

  // The changes and the operation views' reads, which an index signal
  // brings, write no index, so they bring no other: a file saved
  // unchanged, which a plain `git status` refreshes into the index.
  writeFileSync(join(worktree, "a.txt"), "one\n");
  await delay(1200);
  const heard = indexed.length;
  await runHost(
    Effect.flatMap(Git.Git, (reads) =>
      Effect.andThen(reads.changes(worktree), reads.readOperation(worktree)),
    ),
  );
  await delay(700);
  assert.equal(indexed.length, heard, "the app's own reads wrote the index");
  git(worktree, "status", "--porcelain");
  await waitFor(
    () => indexed.length > heard,
    "a plain status to write the index (else the line above proves nothing)",
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

  // The app's own refs, written and deleted, are no change.
  git(repo, "update-ref", "refs/shigomori/dirty/0123456789ab", "HEAD");
  git(repo, "update-ref", "-d", "refs/shigomori/dirty/0123456789ab");
  await delay(700);
  assert.deepEqual(changes, ["p1", "p1", "p1"], "an own ref must not ping");

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

it("backstop: a commit whose events were all lost is signalled once, a ref directory appearing or going, a ref moving inside one and a checkout are signalled, an own ref and a ref directory's churn are not, and a working tree whose watch ended is watched again and its edits said unseen", async () => {
  const root = tempDir("sm-gitwatch-backstop-", trackTest);
  const repo = join(root, "repo");
  git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "one");
  const changes: string[] = [];
  const edits: string[] = [];
  let treeWatches = 0;
  const runtime = ManagedRuntime.make(
    gitWatcherLayer({
      onChange: (projectId) => changes.push(projectId),
      onFilesChanged: (projectId) => edits.push(projectId),
      projects: () => [{ id: "p1", name: "repo", path: repo }],
      // Every event of the git directory lost, and the working tree's
      // first watch ending as soon as it starts.
      watch: (path) =>
        path.endsWith(".git")
          ? Stream.never
          : treeWatches++ === 0
            ? Stream.empty
            : Stream.never,
      backstop: "200 millis",
    }).pipe(Layer.provide(NodeServices.layer)),
  );
  trackTest(() => runtime.dispose());
  await runtime.context();
  const indexed = await indexSignals(runtime);
  await waitFor(() => edits.length >= 1, "the ended tree watch to be noticed");
  assert.ok(treeWatches >= 2, "the ended tree watch was not started again");
  assert.deepEqual(edits, ["p1"]);
  await delay(600);
  assert.deepEqual(changes, [], "a tick with nothing moved signalled");
  assert.deepEqual(indexed, [], "a tick with nothing moved signalled");
  // A stage moves the index alone.
  writeFileSync(join(repo, "b.txt"), "two\n");
  git(repo, "add", "b.txt");
  await waitFor(() => indexed.length >= 1, "the lost stage to be found");
  await delay(600);
  assert.deepEqual(indexed, ["p1"], "one signal per move, not per tick");
  assert.deepEqual(changes, [], "a stage is no project change");
  git(repo, "commit", "-q", "--allow-empty", "-m", "two");
  await waitFor(() => changes.length >= 1, "the lost commit to be found");
  await delay(600);
  assert.deepEqual(changes, ["p1"], "one signal per move, not per tick");
  git(repo, "update-ref", "refs/shigomori/index/0123456789ab", "HEAD");
  await delay(600);
  git(repo, "update-ref", "-d", "refs/shigomori/index/0123456789ab");
  await delay(600);
  assert.deepEqual(changes, ["p1"], "an own ref is no move");
  // A lock made and removed in a ref directory, as a fetch that moves
  // nothing leaves it, moves only the directory's mtime.
  const lock = join(repo, ".git", "refs", "heads", "main.lock");
  writeFileSync(lock, "");
  rmSync(lock);
  await delay(600);
  assert.deepEqual(changes, ["p1"], "a ref directory's churn is no move");
  // A ref directory appearing and going, HEAD unmoved: a namespace
  // under refs/heads, a remote's (and its ref moving inside it), and one
  // with no ref in it.
  git(repo, "branch", "feature/x");
  await waitFor(() => changes.length >= 2, "the lost branch to be found");
  git(repo, "branch", "-D", "feature/x");
  await waitFor(() => changes.length >= 3, "the lost delete to be found");
  git(repo, "update-ref", "refs/remotes/upstream/main", "HEAD");
  await waitFor(() => changes.length >= 4, "the lost remote to be found");
  git(repo, "update-ref", "refs/remotes/upstream/main", "HEAD~1");
  await waitFor(() => changes.length >= 5, "the remote's move to be found");
  git(repo, "update-ref", "-d", "refs/remotes/upstream/main");
  await waitFor(() => changes.length >= 6, "the remote's going to be found");
  const empty = join(repo, ".git", "refs", "heads", "empty");
  mkdirSync(empty);
  await waitFor(() => changes.length >= 7, "the bare directory to be found");
  rmSync(empty, { recursive: true });
  await waitFor(() => changes.length >= 8, "its going to be found");
  git(repo, "checkout", "-q", "-b", "other");
  await waitFor(() => changes.length >= 9, "the lost checkout to be found");
});

it("index: a burst of index writes is one index signal and no project change, and a burst with a ref in it one project change alone", async () => {
  const root = tempDir("sm-gitwatch-index-", trackTest);
  const repo = join(root, "repo");
  git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "one");
  const events = Effect.runSync(Queue.unbounded<FileSystem.WatchEvent>());
  const changes: string[] = [];
  const runtime = ManagedRuntime.make(
    gitWatcherLayer({
      onChange: (projectId) => changes.push(projectId),
      onFilesChanged: () => {},
      projects: () => [{ id: "p1", name: "repo", path: repo }],
      // The git directory's events as the check writes them.
      watch: (path) =>
        path.endsWith(".git") ? Stream.fromQueue(events) : Stream.never,
      backstop: "1 hour",
    }).pipe(Layer.provide(NodeServices.layer)),
  );
  trackTest(() => runtime.dispose());
  await runtime.context();
  const indexed = await indexSignals(runtime);
  // Each path a moment after the last, the whole longer than the
  // debounce.
  const burst = async (paths: readonly string[]) => {
    for (const path of paths) {
      Effect.runSync(Queue.offer(events, { _tag: "Update", path }));
      await delay(20);
    }
  };
  // An agent's `git status`, `git add` and `git diff` in a row, in the
  // main checkout and a worktree, each rewriting an index.
  await burst(
    Array.from({ length: 20 }, (_, at) =>
      at % 2 === 0 ? "index" : "worktrees/feat/index",
    ),
  );
  await waitFor(() => indexed.length >= 1, "the burst to signal");
  await delay(700);
  assert.deepEqual(indexed, ["p1"], "one signal per burst");
  assert.deepEqual(changes, [], "an index written is no project change");
  // A commit: its index and its ref in one burst.
  await burst(["index", "refs/heads/main", "index"]);
  await waitFor(() => changes.length >= 1, "the commit to signal");
  await delay(700);
  assert.deepEqual(changes, ["p1"]);
  assert.deepEqual(indexed, ["p1"], "a commit's index is in its change");
});

it("backstop: a reading where the refs and an index both moved is the project change alone, an index alone is the index signal, and a ref move a beat finds while the watch hears an index is still said", async () => {
  const root = tempDir("sm-gitwatch-moved-", trackTest);
  const repo = join(root, "repo");
  git(root, "init", "-q", "-b", "main", repo);
  // The git state as the check sets it, and the git directory's events
  // as it writes them.
  let state = { refs: "a", indexes: "x" };
  const events = Effect.runSync(Queue.unbounded<FileSystem.WatchEvent>());
  const changes: string[] = [];
  const runtime = ManagedRuntime.make(
    gitWatcherLayer({
      onChange: (projectId) => changes.push(projectId),
      onFilesChanged: () => {},
      projects: () => [{ id: "p1", name: "repo", path: repo }],
      watch: (path) =>
        path.endsWith(".git") ? Stream.fromQueue(events) : Stream.never,
      gitState: () => Effect.sync(() => state),
      backstop: "100 millis",
    }).pipe(Layer.provide(NodeServices.layer)),
  );
  trackTest(() => runtime.dispose());
  await runtime.context();
  const indexed = await indexSignals(runtime);
  await delay(300);
  assert.deepEqual([changes, indexed], [[], []], "a beat with nothing moved");
  // A commit, its events lost: its refs and its index.
  state = { refs: "b", indexes: "y" };
  await waitFor(() => changes.length >= 1, "the commit to be found");
  await delay(300);
  assert.deepEqual([changes, indexed], [["p1"], []]);
  // A stage, its events lost: its index alone.
  state = { refs: "b", indexes: "z" };
  await waitFor(() => indexed.length >= 1, "the stage to be found");
  await delay(300);
  assert.deepEqual([changes, indexed], [["p1"], ["p1"]]);
  // A ref whose event was lost moving as the watch hears an index: the
  // beat that finds it leaves the project to the watch for a beat, and
  // the move is still said.
  Effect.runSync(Queue.offer(events, { _tag: "Update", path: "index" }));
  state = { refs: "c", indexes: "z" };
  await waitFor(() => changes.length >= 2, "the lost ref to be said");
  await delay(600);
  assert.deepEqual(changes, ["p1", "p1"]);
});

it("the mirror's index watch: a stage whose event was lost still fires, once", async () => {
  const root = tempDir("sm-indexwatch-", trackTest);
  const repo = join(root, "repo");
  git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "one");
  let fired = 0;
  // A watch that hears nothing.
  const watching = await runHost(
    watchIndexFile(repo, {
      backstop: "200 millis",
      watch: () => Stream.never,
    }).pipe(
      Stream.runForEach(() =>
        Effect.sync(() => {
          fired += 1;
        }),
      ),
      Effect.forkDetach,
    ),
  );
  trackTest(() => Effect.runPromise(Fiber.interrupt(watching)));
  await delay(600);
  assert.equal(fired, 0, "a tick with nothing moved fired");
  writeFileSync(join(repo, "b.txt"), "two\n");
  git(repo, "add", "b.txt");
  await waitFor(() => fired >= 1, "the lost stage to be found");
  await delay(600);
  assert.equal(fired, 1, "one signal per move, not per tick");
});

it("backstop: a working tree whose watch fails every time it starts is said changed once, not every beat", async () => {
  const root = tempDir("sm-gitwatch-failing-", trackTest);
  const repo = join(root, "repo");
  git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "one");
  const edits: string[] = [];
  let treeWatches = 0;
  const runtime = ManagedRuntime.make(
    gitWatcherLayer({
      onChange: () => {},
      onFilesChanged: (projectId) => edits.push(projectId),
      projects: () => [{ id: "p1", name: "repo", path: repo }],
      // A tree watch that ends as it starts, every time (a volume whose
      // watch the user refused).
      watch: (path) => {
        if (path.endsWith(".git")) return Stream.never;
        treeWatches += 1;
        return Stream.empty;
      },
      backstop: "100 millis",
    }).pipe(Layer.provide(NodeServices.layer)),
  );
  trackTest(() => runtime.dispose());
  await runtime.context();
  await waitFor(() => treeWatches >= 6, "the tree watch to be tried again");
  assert.deepEqual(edits, ["p1"], "said changed on every beat");
});

it("backstop: a project whose reading hangs holds another up once, for its deadline, and is not read again while that read is out", async () => {
  const root = realpathSync(tempDir("sm-gitwatch-stall-", trackTest));
  const repos = ["hangs", "fine"].map((name) => {
    const repo = join(root, name);
    git(root, "init", "-q", "-b", "main", repo);
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "one");
    return repo;
  });
  const [hangs = "", fine = ""] = repos;
  const changes: string[] = [];
  let hangingReads = 0;
  const runtime = ManagedRuntime.make(
    gitWatcherLayer({
      onChange: (projectId) => changes.push(projectId),
      onFilesChanged: () => {},
      projects: () => [
        { id: "hangs", name: "hangs", path: hangs },
        { id: "fine", name: "fine", path: fine },
      ],
      // Every event lost, and one project's reading never coming back,
      // as on a volume that holds its opens.
      watch: () => Stream.never,
      gitState: (gitDir) =>
        gitDir.startsWith(hangs)
          ? Effect.suspend(() => {
              hangingReads += 1;
              return Effect.never;
            })
          : undefined,
      backstop: "100 millis",
    }).pipe(Layer.provide(NodeServices.layer)),
  );
  trackTest(() => runtime.dispose());
  await runtime.context();
  git(fine, "commit", "-q", "--allow-empty", "-m", "two");
  await waitFor(
    () => changes.includes("fine"),
    "the other project's lost commit to be found",
    15_000,
  );
  assert.ok(!changes.includes("hangs"));
  assert.ok(
    hangingReads <= 3,
    `the hanging project was read ${hangingReads} times`,
  );
});

it("backstop: a repository whose git directory went, with its events lost, is signalled", async () => {
  const root = tempDir("sm-gitwatch-gone-", trackTest);
  const repo = join(root, "repo");
  git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "one");
  const changes: string[] = [];
  const runtime = ManagedRuntime.make(
    gitWatcherLayer({
      onChange: (projectId) => changes.push(projectId),
      onFilesChanged: () => {},
      projects: () => [{ id: "p1", name: "repo", path: repo }],
      watch: () => Stream.never,
      backstop: "100 millis",
    }).pipe(Layer.provide(NodeServices.layer)),
  );
  trackTest(() => runtime.dispose());
  await runtime.context();
  await delay(400);
  assert.equal(changes.length, 0, "a quiet repository was signalled");
  rmSync(join(repo, ".git"), { recursive: true, force: true });
  await waitFor(
    () => changes.includes("p1"),
    "the gone repository to be signalled",
  );
});
