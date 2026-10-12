// The changes page's git, through the service: listing with counts,
// undo and redo, and discard with its snapshot.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ChangedFile } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { it } from "vitest";
import {
  DISCARD_REF_PREFIX,
  BranchMovedError,
  GitCommandError,
  UndoRefusedError,
} from "../src/Git.ts";
import {
  failureAs,
  failureOf,
  git,
  rev,
  seedRepo,
  tempDir,
  withGit,
  write,
} from "./lib/gitRepos.ts";

const read = (repo: string, path: string): string =>
  readFileSync(join(repo, path), "utf8");

const discardRefs = (repo: string): string[] =>
  git(repo, "for-each-ref", "--format=%(refname)", DISCARD_REF_PREFIX)
    .split("\n")
    .filter(Boolean);

function rowOf(files: readonly ChangedFile[], path: string): ChangedFile {
  const row = files.find((file) => file.path === path);
  assert.ok(
    row,
    `no row for ${path} in ${files.map((f) => f.path).join(", ")}`,
  );
  return row;
}

const changes = (repo: string) => withGit((g) => g.changes(repo));

// seedRepo plus a second commit editing a.txt, for undo.
function seedWithSecond() {
  const repo = seedRepo();
  const root = rev(repo, "HEAD");
  write(repo, "a.txt", "second\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "Second");
  return { repo, root, second: rev(repo, "HEAD") };
}

it("lists each kind of change with its counts, sorted by path", async () => {
  const repo = seedRepo();
  write(repo, "a.txt", "one\n2\nthree\nfour\n");
  rmSync(join(repo, "b.txt"));
  git(repo, "mv", "dir/c.txt", "dir/moved.txt");
  write(repo, "new/x.txt", "x\ny");
  write(repo, "new/bin", Buffer.from([1, 0, 2]));
  write(repo, "new/sub dir.txt", "space in name\n");

  const files = await changes(repo);
  assert.deepEqual(
    files.map((f) => f.path),
    [
      "a.txt",
      "b.txt",
      "dir/moved.txt",
      "new/bin",
      "new/sub dir.txt",
      "new/x.txt",
    ],
  );
  assert.deepEqual(rowOf(files, "a.txt"), {
    path: "a.txt",
    kind: "modified",
    staged: "none",
    counts: { additions: 2, deletions: 1 },
  });
  assert.deepEqual(rowOf(files, "b.txt"), {
    path: "b.txt",
    kind: "deleted",
    staged: "none",
    counts: { additions: 0, deletions: 1 },
  });
  // A pure rename: numstat names the new path and counts nothing.
  assert.deepEqual(rowOf(files, "dir/moved.txt"), {
    path: "dir/moved.txt",
    kind: "renamed",
    prevPath: "dir/c.txt",
    staged: "all",
    counts: { additions: 0, deletions: 0 },
  });
  assert.deepEqual(rowOf(files, "new/x.txt"), {
    path: "new/x.txt",
    kind: "added",
    staged: "none",
    counts: { additions: 2, deletions: 0 },
  });
  // Binary: no counts from git, none from the disk either.
  assert.deepEqual(rowOf(files, "new/bin"), {
    path: "new/bin",
    kind: "added",
    staged: "none",
  });
  assert.equal(rowOf(files, "new/sub dir.txt").counts?.additions, 1);

  // The cheap form folds an untracked directory into one row, without
  // counts, and the row probe counts and dates the same listing.
  const cheap = await withGit((g) => g.status(repo));
  assert.deepEqual(rowOf(cheap, "new/"), {
    path: "new/",
    kind: "added",
    staged: "none",
  });
  assert.equal(rowOf(cheap, "a.txt").counts, undefined);
  const row = await withGit((g) => g.workingTreeChanges(repo));
  assert.equal(row.count, cheap.length);
  assert.ok(row.lastChangeAt > 0);
});

it("an untracked file the user's setting hides still counts for the guards", async () => {
  const repo = seedRepo();
  git(repo, "config", "status.showUntrackedFiles", "no");
  write(repo, "loose.txt", "x\n");
  assert.equal((await withGit((g) => g.status(repo))).length, 0);
  assert.equal(await withGit((g) => g.changedCount(repo)), 1);
});

it("a file edited in the index and again since reads as partial", async () => {
  const repo = seedRepo();
  write(repo, "a.txt", "staged\n");
  git(repo, "add", "a.txt");
  write(repo, "a.txt", "staged then edited\n");
  assert.equal(rowOf(await changes(repo), "a.txt").staged, "partial");
  write(repo, "d.txt", "d\n");
  git(repo, "add", "d.txt");
  write(repo, "d.txt", "dd\n");
  assert.deepEqual(rowOf(await changes(repo), "d.txt"), {
    path: "d.txt",
    kind: "added",
    staged: "partial",
    counts: { additions: 1, deletions: 0 },
  });
});

it("undo soft-resets to an ancestor, and redo needs HEAD where it was", async () => {
  const { repo, root, second } = seedWithSecond();
  assert.equal(
    await withGit((g) => g.resetSoft({ worktree: repo, target: root })),
    second,
  );
  assert.equal(rev(repo, "HEAD"), root);
  assert.equal(read(repo, "a.txt"), "second\n");
  assert.equal(rowOf(await changes(repo), "a.txt").staged, "all");

  assert.equal(
    await withGit((g) =>
      g.resetSoft({ worktree: repo, target: second, expectHead: root }),
    ),
    root,
  );
  assert.equal(rev(repo, "HEAD"), second);

  // Forwards is never taken without the pin.
  await withGit((g) => g.resetSoft({ worktree: repo, target: root }));
  const error = await failureAs(UndoRefusedError, (g) =>
    g.resetSoft({ worktree: repo, target: second }),
  );
  assert.equal(error.reason, "off-history");
  assert.equal(rev(repo, "HEAD"), root);
});

it("undo refuses a moved HEAD, a commit off the line, and a range over a merge", async () => {
  const { repo, root, second } = seedWithSecond();
  const refusal = async (target: string, expectHead?: string) => {
    return failureAs(UndoRefusedError, (g) =>
      g.resetSoft({ worktree: repo, target, expectHead }),
    );
  };

  const moved = await failureAs(BranchMovedError, (g) =>
    g.resetSoft({ worktree: repo, target: root, expectHead: root }),
  );
  assert.equal(
    moved.message,
    "The branch has moved on since this was loaded. Reload and try again.",
  );

  git(repo, "checkout", "-q", "-b", "side", root);
  write(repo, "side.txt", "side\n");
  git(repo, "add", "side.txt");
  git(repo, "commit", "-q", "-m", "side");
  const side = rev(repo, "HEAD");
  git(repo, "checkout", "-q", "main");
  assert.equal((await refusal(side)).reason, "off-history");
  assert.equal(rev(repo, "HEAD"), second);

  git(repo, "merge", "-q", "--no-ff", "-m", "merge side", "side");
  assert.equal((await refusal(root)).reason, "across-merge");
  assert.equal(rev(repo, "HEAD~1"), second);

  // The merge on top, undone to its first parent, comes off whole, and
  // its redo puts it back.
  const merge = rev(repo, "HEAD");
  assert.equal(
    await withGit((g) => g.resetSoft({ worktree: repo, target: second })),
    merge,
  );
  assert.equal(rev(repo, "HEAD"), second);
  assert.equal(git(repo, "status", "--porcelain").trim(), "");
  await withGit((g) =>
    g.resetSoft({ worktree: repo, target: merge, expectHead: second }),
  );
  assert.equal(rev(repo, "HEAD"), merge);
});

it("discard restores tracked files, removes untracked ones, and keeps a snapshot ref", async () => {
  const repo = seedRepo();
  write(repo, "a.txt", "edited\n");
  write(repo, "b.txt", "staged edit\n");
  git(repo, "add", "b.txt");
  rmSync(join(repo, "dir", "c.txt"));
  write(repo, "fresh/n.txt", "new\n");
  write(repo, "added.txt", "added\n");
  git(repo, "add", "added.txt");
  write(repo, "kept.txt", "not picked\n");

  const paths = ["a.txt", "b.txt", "dir/c.txt", "fresh/n.txt", "added.txt"];
  const snapshot = await withGit((g) => g.discard({ worktree: repo, paths }));

  assert.equal(read(repo, "a.txt"), "one\ntwo\nthree\n");
  assert.equal(read(repo, "b.txt"), "bee\n");
  assert.equal(read(repo, "dir/c.txt"), "sea\n");
  assert.equal(existsSync(join(repo, "fresh", "n.txt")), false);
  assert.equal(existsSync(join(repo, "added.txt")), false);
  assert.deepEqual(
    (await changes(repo)).map((f) => f.path),
    ["kept.txt"],
  );

  const refs = discardRefs(repo);
  assert.equal(refs.length, 1);
  assert.equal(rev(repo, refs[0] ?? ""), snapshot);
  assert.equal(rev(repo, `${snapshot}^`), rev(repo, "HEAD"));
  assert.equal(git(repo, "show", `${snapshot}:a.txt`), "edited\n");
  assert.equal(git(repo, "show", `${snapshot}:fresh/n.txt`), "new\n");
  assert.equal(
    git(repo, "ls-tree", "--name-only", snapshot, "dir/c.txt").trim(),
    "",
  );
  assert.equal(
    git(repo, "ls-tree", "--name-only", snapshot, "kept.txt").trim(),
    "",
  );
});

it("restoreDiscard puts the discard back, unstaged, and re-deletes what was deleted", async () => {
  const repo = seedRepo();
  write(repo, "a.txt", "edited\n");
  rmSync(join(repo, "b.txt"));
  write(repo, "fresh/n.txt", "new\n");
  const snapshot = await withGit((g) =>
    g.discard({ worktree: repo, paths: ["a.txt", "b.txt", "fresh/n.txt"] }),
  );
  assert.deepEqual(await changes(repo), []);

  await withGit((g) => g.restoreDiscard({ worktree: repo, snapshot }));
  assert.deepEqual(
    (await changes(repo)).map((f) => [f.path, f.kind, f.staged]),
    [
      ["a.txt", "modified", "none"],
      ["b.txt", "deleted", "none"],
      ["fresh/n.txt", "added", "none"],
    ],
  );
});

it("a discard on an unborn branch snapshots as a root commit and restores", async () => {
  const repo = tempDir("unborn-");
  git(repo, "init", "-q", "-b", "main");
  write(repo, "first.txt", "first\n");
  const snapshot = await withGit((g) =>
    g.discard({ worktree: repo, paths: ["first.txt"] }),
  );
  assert.equal(existsSync(join(repo, "first.txt")), false);
  assert.equal(git(repo, "rev-list", "--count", snapshot).trim(), "1");
  await withGit((g) => g.restoreDiscard({ worktree: repo, snapshot }));
  assert.equal(read(repo, "first.txt"), "first\n");
});

it("a nested repository is left in place and named in the error", async () => {
  const repo = seedRepo();
  const nested = join(repo, "vendor", "inner");
  mkdirSync(nested, { recursive: true });
  git(nested, "init", "-q", "-b", "main");
  write(nested, "f.txt", "inner\n");
  write(repo, "plain.txt", "plain\n");
  const untracked = (await changes(repo)).map((f) => f.path);
  assert.deepEqual(untracked, ["plain.txt", "vendor/inner/"]);

  // No commit inside: git can't record the gitlink, the snapshot
  // fails, and nothing is touched.
  await failureAs(GitCommandError, (g) =>
    g.discard({ worktree: repo, paths: untracked }),
  );
  assert.equal(read(repo, "plain.txt"), "plain\n");
  assert.equal(discardRefs(repo).length, 0);

  git(nested, "add", "f.txt");
  git(nested, "commit", "-q", "-m", "inner");
  const error = await failureOf((g) =>
    g.discard({ worktree: repo, paths: untracked }),
  );
  assert.equal(
    error.message,
    "Couldn't remove vendor/inner/. A nested git repository has to be removed by hand.",
  );
  assert.equal(read(nested, "f.txt"), "inner\n");
  assert.equal(existsSync(join(repo, "plain.txt")), false);
});

it("only the newest 40 discard snapshots are kept", async () => {
  const repo = seedRepo();
  const head = rev(repo, "HEAD");
  const seeded = Array.from(
    { length: 41 },
    (_, i) => `${DISCARD_REF_PREFIX}${1_000_000_000_000 + i}`,
  );
  execFileSync("git", ["update-ref", "--stdin"], {
    cwd: repo,
    input: seeded.map((ref) => `create ${ref} ${head}\n`).join(""),
  });
  write(repo, "a.txt", "edited\n");
  const snapshot = await withGit((g) =>
    g.discard({ worktree: repo, paths: ["a.txt"] }),
  );
  const refs = git(
    repo,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    DISCARD_REF_PREFIX,
  )
    .trim()
    .split("\n")
    .map((line) => line.split(" "));
  assert.deepEqual(
    refs.slice(0, -1).map(([ref]) => ref),
    seeded.slice(2),
  );
  assert.equal(refs.at(-1)?.[1], snapshot);
});

it("undoing a discard fails when a file it would delete can't go", async () => {
  const repo = seedRepo();
  rmSync(join(repo, "b.txt"));
  const snapshot = await withGit((g) =>
    g.discard({ worktree: repo, paths: ["b.txt"] }),
  );
  // The discard put b.txt back. Where it was is a folder now, which the
  // undo's deletion can't take.
  rmSync(join(repo, "b.txt"));
  mkdirSync(join(repo, "b.txt"));
  writeFileSync(join(repo, "b.txt", "inside.txt"), "x\n");
  await failureOf((g) => g.restoreDiscard({ worktree: repo, snapshot }));
  assert.ok(existsSync(join(repo, "b.txt", "inside.txt")));
});

it("a squash message that can't be cleared fails the read rather than lingering", async () => {
  const repo = seedRepo();
  const message = join(repo, ".git", "SQUASH_MSG");
  mkdirSync(message);
  writeFileSync(join(message, "stuck"), "x\n");
  await failureOf((g) => g.readOperation(repo));
});

it("a commit's patch keeps the files git printed before a later one failed", async () => {
  const repo = seedRepo();
  write(repo, ".gitattributes", "b.txt diff=broken\n");
  git(repo, "config", "diff.broken.textconv", "false");
  write(repo, "a.txt", "changed\n");
  write(repo, "b.txt", "changed too\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "both");
  const patch = await withGit((g) => g.commitDiff(repo, rev(repo, "HEAD")));
  assert.match(patch, /^diff --git a\/\.gitattributes/m);
  assert.match(patch, /^diff --git a\/a\.txt/m);
});

it("a hunk discard in a file that starts with a byte order mark keeps the mark", async () => {
  const repo = seedRepo();
  const BOM = "﻿";
  write(repo, "bom.txt", `${BOM}one\ntwo\nthree\nfour\nfive\nsix\n`);
  git(repo, "add", "bom.txt");
  git(repo, "commit", "-q", "-m", "bom");
  write(repo, "bom.txt", `${BOM}one\n2\nthree\nfour\nfive\n6\n`);
  const hunks = await withGit((g) => g.readHunks(repo, "bom.txt"));
  const [first] = hunks.changes;
  assert.ok(first);
  await withGit((g) =>
    g.discardHunks({ worktree: repo, path: "bom.txt", changes: [first] }),
  );
  assert.equal(read(repo, "bom.txt"), `${BOM}one\ntwo\nthree\nfour\nfive\n6\n`);
});

// A commit the app quits on (a long pre-commit hook) never ran to its
// commit, so what was staged before it (an agent's `git add`) is staged
// again, as when git refuses one.
it("a commit cut short before it committed puts the index back", async () => {
  const repo = seedRepo();
  write(repo, "a.txt", "staged by someone else\n");
  git(repo, "add", "a.txt");
  write(repo, "b.txt", "ticked\n");
  const started = join(repo, ".git", "hook-started");
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  writeFileSync(
    join(repo, ".git", "hooks", "pre-commit"),
    `#!/bin/sh\ntouch '${started}'\nexec sleep 30\n`,
    { mode: 0o755 },
  );
  await withGit((g) =>
    Effect.gen(function* () {
      const committing = yield* Effect.forkChild(
        g.commitPicks(repo, { summary: "b", paths: ["b.txt"], hunks: [] }),
      );
      while (!existsSync(started)) yield* Effect.sleep("20 millis");
      yield* Fiber.interrupt(committing);
    }),
  );
  assert.deepEqual(
    git(repo, "diff", "--cached", "--name-only").split("\n").filter(Boolean),
    ["a.txt"],
  );
});
