// Durable proof that a watched path whose open does not return can't
// stop the host (host/lib/watchPath.ts; V3.md, "A watch that froze the
// host"). `fs.watch` opens its path on the calling thread, so before
// the bounded open a project with such a working tree froze the host's
// loop as GitWatcher started (and every host after it). macOS's held
// open (the Files and Folders prompt for an external disk) can't be
// made on demand, so a FIFO stands in: its open blocks the same way
// until a writer comes. Asserts:
//   - the real GitWatcher over a repository whose worktrees include a
//     FIFO keeps the loop turning, and still follows the other trees;
//   - a path that can't be watched yet is watched once it can be,
//     without a reconcile;
//   - a path that does not open in time is said in words, a consent
//     wait for one on another volume.
//
// Run: pnpm test watch-open.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { it } from "vitest";
import { layer as gitWatcherLayer } from "../host/lib/GitWatcher.ts";
import { heldOpen, unwatchable, watchPath } from "../host/lib/watchPath.ts";
import {
  delay,
  sandboxGit,
  scrubbedGitEnv,
  tempDir,
  waitFor,
} from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";

const git = sandboxGit(scrubbedGitEnv());

// A FIFO at `path`, and a writer that opens it after `afterMs`, which
// is what lets a blocked open go: a run whose loop froze ends late
// rather than never, and fails on the gap it measured.
function fifoReleasedAfter(path: string, afterMs: number): void {
  execFileSync("mkfifo", [path]);
  const writer: ChildProcess = spawn(
    "sh",
    ["-c", `sleep ${afterMs / 1000}; : > "$0"`, path],
    { stdio: "ignore" },
  );
  trackTest(() => {
    writer.kill("SIGKILL");
  });
}

// The longest the loop went without a turn while `during` ran.
async function longestStall(during: () => Promise<void>): Promise<number> {
  let last = Date.now();
  let longest = 0;
  const ticker = setInterval(() => {
    const now = Date.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 50);
  try {
    await during();
  } finally {
    clearInterval(ticker);
  }
  return Math.max(longest, Date.now() - last);
}

it("a worktree whose open blocks leaves the host's loop turning, and the other trees followed", async () => {
  const root = tempDir("sm-watch-open-", trackTest);
  const repo = join(root, "repo");
  const feat = join(root, "feat");
  git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "one");
  git(repo, "worktree", "add", "-q", "-b", "feat", feat);
  // A worktree entry naming a tree whose open blocks.
  const stuck = join(root, "stuck");
  mkdirSync(join(repo, ".git", "worktrees", "stuck"));
  writeFileSync(
    join(repo, ".git", "worktrees", "stuck", "gitdir"),
    `${join(stuck, ".git")}\n`,
  );
  fifoReleasedAfter(stuck, 6_000);

  const edits: string[] = [];
  const runtime = ManagedRuntime.make(
    gitWatcherLayer({
      onChange: () => {},
      onFilesChanged: (projectId) => edits.push(projectId),
      projects: () => [{ id: "p1", name: "repo", path: repo }],
    }).pipe(Layer.provide(NodeServices.layer)),
  );
  trackTest(() => runtime.dispose());
  const stall = await longestStall(async () => {
    await runtime.context();
    await delay(3_000);
  });
  assert.ok(
    stall < 1_000,
    `the loop stopped for ${stall} ms as the watches started`,
  );

  writeFileSync(join(feat, "b.txt"), "two\n");
  await waitFor(() => edits.length > 0, "an edit in the other worktree");
});

it("a path that can't be watched yet is watched once it can be", async () => {
  const root = tempDir("sm-watch-later-", trackTest);
  const path = join(root, "later");
  execFileSync("mkfifo", [path]);
  const fs = await Effect.runPromise(
    Effect.provide(Effect.service(FileSystem.FileSystem), NodeServices.layer),
  );
  const events: string[] = [];
  const watching = Effect.runFork(
    watchPath(fs, path, undefined, { retryEvery: "200 millis" }).pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event.path))),
      Effect.ignore,
    ),
  );
  trackTest(() => Effect.runPromise(Fiber.interrupt(watching)));
  await delay(500);
  // The FIFO gives way to a folder, the next try watches it.
  rmSync(path);
  mkdirSync(path);
  await waitFor(() => {
    writeFileSync(join(path, "x.txt"), String(Date.now()));
    return events.length > 0;
  }, "an event from the folder once it can be watched");
});

it("a path that does not open in time is said in words, and one that is no folder or file too", async () => {
  assert.match(
    heldOpen("/Volumes/an-external-disk/project", "5 seconds"),
    /waiting for permission to read files on a removable or network volume/,
  );
  assert.match(
    heldOpen("/Users/someone/project", "5 seconds"),
    /did not open within 5s/,
  );
  const root = tempDir("sm-watch-kind-", trackTest);
  const fifo = join(root, "fifo");
  execFileSync("mkfifo", [fifo]);
  assert.equal(
    Option.getOrNull(await Effect.runPromise(unwatchable(fifo))),
    "is not a folder or a file",
  );
  assert.ok(Option.isNone(await Effect.runPromise(unwatchable(root))));
  assert.ok(
    Option.isNone(await Effect.runPromise(unwatchable(join(root, "gone")))),
    "a path that fails to open is left to the watch to say",
  );
});
