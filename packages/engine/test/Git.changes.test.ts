// The changes page's git, through the service: listing with counts,
// ticking, committing, undo and redo, and discard with its snapshot.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ChangedFile } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import { it } from "vitest";
import {
  DISCARD_REF_PREFIX,
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
} from "./sandbox.ts";

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
async function seedWithSecond() {
  const repo = seedRepo();
  const root = rev(repo, "HEAD");
  write(repo, "a.txt", "second\n");
  await withGit((g) =>
    g.commit({ worktree: repo, summary: "Second", stagePaths: ["a.txt"] }),
  );
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

it("ticking stages an addition, an edit and a removal, and unticking takes each back", async () => {
  const repo = seedRepo();
  write(repo, "a.txt", "edited\n");
  rmSync(join(repo, "b.txt"));
  write(repo, "a[1].txt", "glob-shaped name\n");
  const paths = ["a.txt", "b.txt", "a[1].txt"];

  const staged = await withGit((g) =>
    g.setStaged({ worktree: repo, paths, staged: true }),
  );
  assert.deepEqual(
    paths.map((p) => rowOf(staged, p).staged),
    ["all", "all", "all"],
  );
  assert.equal(rowOf(staged, "b.txt").kind, "deleted");

  const unstaged = await withGit((g) =>
    g.setStaged({ worktree: repo, paths, staged: false }),
  );
  assert.deepEqual(
    paths.map((p) => rowOf(unstaged, p).staged),
    ["none", "none", "none"],
  );
  assert.equal(git(repo, "diff", "--cached", "--name-only"), "");
  assert.equal(read(repo, "a[1].txt"), "glob-shaped name\n");
});

it("quick ticks on one worktree wait for each other instead of failing on the lock", async () => {
  const repo = seedRepo();
  const paths = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
  for (const path of paths) write(repo, path, `${path}\n`);
  // One service, as a process has: the lock is per service.
  await withGit((g) =>
    Effect.all(
      paths.map((path, i) =>
        g.setStaged({ worktree: repo, paths: [path], staged: i % 2 === 0 }),
      ),
      { concurrency: "unbounded" },
    ),
  );
  const staged = git(repo, "diff", "--cached", "--name-only")
    .split("\n")
    .filter(Boolean);
  assert.equal(staged.length, 10);
});

it("a commit takes the ticked files plus stagePaths, and the message reads back split", async () => {
  const repo = seedRepo();
  write(repo, "a.txt", "edited\n");
  write(repo, "b.txt", "also edited\n");
  write(repo, "loose.txt", "left out\n");
  git(repo, "add", "a.txt");

  const hash = await withGit((g) =>
    g.commit({
      worktree: repo,
      summary: "Edit a and b",
      description: "  Body line one.\n\nBody line two.  ",
      stagePaths: ["b.txt"],
    }),
  );
  assert.ok(rev(repo, "HEAD").startsWith(hash));
  assert.equal(
    git(repo, "show", "--name-only", "--format=", "HEAD").trim(),
    "a.txt\nb.txt",
  );
  assert.deepEqual(await withGit((g) => g.readCommitMessage(repo, "HEAD")), {
    summary: "Edit a and b",
    description: "Body line one.\n\nBody line two.",
  });
  assert.deepEqual(
    (await changes(repo)).map((f) => f.path),
    ["loose.txt"],
  );
});

it("amend folds the index into HEAD under the new message", async () => {
  const repo = seedRepo();
  const root = rev(repo, "HEAD");
  write(repo, "a.txt", "first\n");
  await withGit((g) =>
    g.commit({ worktree: repo, summary: "First try", stagePaths: ["a.txt"] }),
  );
  write(repo, "b.txt", "fixed up\n");
  await withGit((g) =>
    g.commit({
      worktree: repo,
      summary: "Second try",
      amend: true,
      stagePaths: ["b.txt"],
    }),
  );
  assert.equal(rev(repo, "HEAD~1"), root);
  assert.equal(
    (await withGit((g) => g.readCommitMessage(repo, "HEAD"))).summary,
    "Second try",
  );
});

it("undo soft-resets to an ancestor, and redo needs HEAD where it was", async () => {
  const { repo, root, second } = await seedWithSecond();
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
  const { repo, root, second } = await seedWithSecond();
  const refusal = async (target: string, expectHead?: string) => {
    return failureAs(UndoRefusedError, (g) =>
      g.resetSoft({ worktree: repo, target, expectHead }),
    );
  };

  assert.equal(
    (await refusal(root, root)).message,
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
