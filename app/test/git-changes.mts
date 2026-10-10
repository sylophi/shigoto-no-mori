// Durable proof for the changes page's git (host/lib/git/changes.ts and
// commit.ts) against a REAL repository: the status parser's rows and
// counts, a commit taking exactly the picked files whatever was staged
// (a rename included, a file deleted since skipped, on an unborn branch,
// and a merge still committing as one), amend with the message read
// back or kept as it was, undo and redo along HEAD's line with every refusal
// (moved HEAD, a commit off the line, a merge), and discard with its
// snapshot ref, the way back through restoreDiscard, the nested-repo
// refusal and the snapshot prune.
//
// Run: pnpm test git-changes.
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
import { only } from "@shigomori/contracts/util/only";
import {
  sandboxGit,
  scrubbedGitEnv,
  scrubProcessGitEnv,
  tempDir,
} from "./lib/checkKit.mts";
import { it } from "vitest";
import { promised } from "./lib/gitPromises.mts";
import { trackTest } from "./lib/vitestKit.mts";

// changes.ts runs git under this process's environment. The pre-commit
// hook's GIT_* variables would point that git at the commit in
// progress, so they go before anything is imported. Commits need an
// identity, and the global config is cut off, so pin one here.
const gitEnv = scrubbedGitEnv();
scrubProcessGitEnv({
  GIT_AUTHOR_NAME: "sm",
  GIT_AUTHOR_EMAIL: "sm@example.test",
  GIT_COMMITTER_NAME: "sm",
  GIT_COMMITTER_EMAIL: "sm@example.test",
});

const {
  discardChanges,
  listChangedFiles,
  listChangesForPage,
  readCommitMessage,
  resetSoft,
  restoreDiscard,
} = promised(await import("../host/lib/git/changes.ts"));
const { commitPicks } = promised(await import("../host/lib/git/commit.ts"));

// A commit of whole files, the way the page sends one with nothing
// ticked by hunk.
const commitPaths = (
  repo: string,
  message: { summary?: string; description?: string; amend?: boolean },
  paths: string[],
) => commitPicks(repo, { ...message, paths, hunks: [] });

const git = sandboxGit(gitEnv);

// A repository with one commit holding a.txt, b.txt and dir/c.txt.
function seedRepo(): string {
  const repo = tempDir("sm-changes-", trackTest);
  git(repo, "init", "-q", "-b", "main");
  write(repo, "a.txt", "one\ntwo\nthree\n");
  write(repo, "b.txt", "bee\n");
  mkdirSync(join(repo, "dir"));
  write(repo, "dir/c.txt", "sea\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

// seedRepo plus a second commit editing a.txt, for the undo checks.
async function seedWithSecond() {
  const repo = seedRepo();
  const root = rev(repo, "HEAD");
  write(repo, "a.txt", "second\n");
  await commitPaths(repo, { summary: "Second" }, ["a.txt"]);
  return { repo, root, second: rev(repo, "HEAD") };
}

const read = (repo: string, path: string): string =>
  readFileSync(join(repo, path), "utf8");
const write = (repo: string, path: string, text: string | Uint8Array): void =>
  writeFileSync(join(repo, path), text);
const rev = (repo: string, ref: string): string =>
  git(repo, "rev-parse", ref).trim();
const discardRefs = (repo: string): string[] =>
  git(repo, "for-each-ref", "--format=%(refname)", "refs/shigomori/discards/")
    .split("\n")
    .filter(Boolean);

// The row for `path`, so an assertion names the file it is about.
function rowOf(files: readonly ChangedFile[], path: string): ChangedFile {
  const row = files.find((f) => f.path === path);
  assert.ok(row, `no row for ${path} in ${JSON.stringify(files)}`);
  return row;
}

it("the page lists each kind of change with its counts, sorted by path", async () => {
  const repo = seedRepo();
  write(repo, "a.txt", "one\n2\nthree\nfour\n"); // edit
  rmSync(join(repo, "b.txt")); // delete
  git(repo, "mv", "dir/c.txt", "dir/moved.txt"); // staged rename
  mkdirSync(join(repo, "new"));
  write(repo, "new/x.txt", "x\ny"); // no final newline
  write(repo, "new/bin", Buffer.from([1, 0, 2]));
  write(repo, "new/sub dir.txt", "space in name\n");

  const files = await listChangesForPage(repo);
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
  // Binary: git says no counts, and so does the disk scan.
  assert.deepEqual(rowOf(files, "new/bin"), {
    path: "new/bin",
    kind: "added",
    staged: "none",
  });
  assert.equal(rowOf(files, "new/sub dir.txt").counts?.additions, 1);

  // The sidebar's cheap form folds an untracked directory into one
  // row and skips the counts.
  const cheap = await listChangedFiles(repo);
  assert.deepEqual(rowOf(cheap, "new/"), {
    path: "new/",
    kind: "added",
    staged: "none",
  });
  assert.equal(rowOf(cheap, "a.txt").counts, undefined);
});

it("a file edited in the index and again since reads as partial", async () => {
  const repo = seedRepo();
  write(repo, "a.txt", "staged\n");
  git(repo, "add", "a.txt");
  write(repo, "a.txt", "staged then edited\n");
  const files = await listChangesForPage(repo);
  assert.equal(rowOf(files, "a.txt").staged, "partial");
  // A staged addition edited since: the index says A, the tree M.
  write(repo, "d.txt", "d\n");
  git(repo, "add", "d.txt");
  write(repo, "d.txt", "dd\n");
  const again = await listChangesForPage(repo);
  assert.deepEqual(rowOf(again, "d.txt"), {
    path: "d.txt",
    kind: "added",
    staged: "partial",
    counts: { additions: 1, deletions: 0 },
  });
});

it("a commit takes exactly the picked paths, and what was staged but not picked stays out and on disk", async () => {
  const repo = seedRepo();
  write(repo, "a.txt", "edited\n");
  rmSync(join(repo, "b.txt"));
  write(repo, "a[1].txt", "glob-shaped name\n");
  git(repo, "mv", "dir/c.txt", "dir/moved.txt"); // staged rename
  write(repo, "staged.txt", "an agent's git add\n");
  git(repo, "add", "staged.txt");

  const hash = await commitPaths(
    repo,
    {
      summary: "Edit, remove, add, move",
      description: "  Body line one.\n\nBody line two.  ",
    },
    ["a.txt", "b.txt", "a[1].txt", "dir/c.txt", "dir/moved.txt"],
  );
  assert.equal(rev(repo, "HEAD").startsWith(hash), true);
  assert.equal(
    git(repo, "show", "--name-status", "-M", "--format=", "HEAD").trim(),
    "M\ta.txt\nA\ta[1].txt\nD\tb.txt\nR100\tdir/c.txt\tdir/moved.txt",
  );
  assert.deepEqual(await readCommitMessage(repo, "HEAD"), {
    summary: "Edit, remove, add, move",
    description: "Body line one.\n\nBody line two.",
  });
  assert.deepEqual(
    (await listChangesForPage(repo)).map((f) => [f.path, f.staged]),
    [["staged.txt", "none"]],
  );
  assert.equal(read(repo, "staged.txt"), "an agent's git add\n");

  // No body: the message is the summary alone.
  write(repo, "a.txt", "again\n");
  await commitPaths(repo, { summary: "Only a subject", description: "   " }, [
    "a.txt",
  ]);
  assert.deepEqual(await readCommitMessage(repo, "HEAD"), {
    summary: "Only a subject",
    description: "",
  });
});

it("a picked file deleted before the commit is skipped, not a refusal", async () => {
  const repo = seedRepo();
  write(repo, "a.txt", "edited\n");
  await commitPaths(repo, { summary: "Edit a" }, ["a.txt", "scratch.txt"]);
  assert.equal(
    git(repo, "show", "--name-only", "--format=", "HEAD").trim(),
    "a.txt",
  );
});

it("a file staged past .gitignore still commits", async () => {
  const repo = seedRepo();
  write(repo, ".gitignore", "*.log\n");
  write(repo, "out.log", "forced\n");
  git(repo, "add", "-f", "out.log");
  await commitPaths(repo, { summary: "Forced" }, ["out.log"]);
  assert.equal(
    git(repo, "show", "--name-only", "--format=", "HEAD").trim(),
    "out.log",
  );
});

it("a commit git refuses puts the index back the way it was", async () => {
  const repo = seedRepo();
  git(repo, "mv", "dir/c.txt", "dir/moved.txt");
  write(repo, "a.txt", "edited\n");
  write(repo, ".git/hooks/pre-commit", "#!/bin/sh\necho no >&2\nexit 1\n");
  execFileSync("chmod", ["+x", join(repo, ".git/hooks/pre-commit")]);
  const before = git(repo, "diff", "--cached", "--name-status", "-M");
  await assert.rejects(
    commitPaths(repo, { summary: "Refused" }, ["a.txt"]),
    /no/,
  );
  assert.equal(git(repo, "diff", "--cached", "--name-status", "-M"), before);
});

it("a commit lands on an unborn branch", async () => {
  const repo = tempDir("sm-changes-unborn-", trackTest);
  git(repo, "init", "-q", "-b", "main");
  write(repo, "first.txt", "first\n");
  write(repo, "later.txt", "later\n");
  await commitPaths(repo, { summary: "First" }, ["first.txt"]);
  assert.equal(
    git(repo, "show", "--name-only", "--format=", "HEAD").trim(),
    "first.txt",
  );
});

it("a merge in progress still commits as a merge", async () => {
  const repo = seedRepo();
  git(repo, "checkout", "-q", "-b", "other");
  write(repo, "b.txt", "from other\n");
  git(repo, "commit", "-q", "-am", "Other");
  git(repo, "checkout", "-q", "main");
  write(repo, "a.txt", "from main\n");
  git(repo, "commit", "-q", "-am", "Main");
  git(repo, "merge", "-q", "--no-ff", "--no-commit", "other");
  await commitPaths(repo, { summary: "Merge other" }, ["b.txt"]);
  assert.equal(
    git(repo, "rev-list", "--parents", "-n1", "HEAD").trim().split(" ").length,
    3,
  );
  assert.equal(read(repo, "b.txt"), "from other\n");
  assert.equal(git(repo, "status", "--porcelain"), "");
});

it("amend folds the picks into HEAD under a new message or the one it has, or rewrites only the message", async () => {
  const repo = seedRepo();
  const root = rev(repo, "HEAD");
  write(repo, "a.txt", "first\n");
  await commitPaths(repo, { summary: "First try" }, ["a.txt"]);
  write(repo, "b.txt", "fixed up\n");
  const hash = await commitPaths(repo, { summary: "Second try", amend: true }, [
    "b.txt",
  ]);
  assert.equal(rev(repo, "HEAD").startsWith(hash), true);
  assert.equal(rev(repo, "HEAD~1"), root, "still one commit above root");
  assert.equal(
    git(repo, "show", "--name-only", "--format=", "HEAD").trim(),
    "a.txt\nb.txt",
  );
  assert.equal((await readCommitMessage(repo, "HEAD")).summary, "Second try");

  write(repo, "dir/c.txt", "left out\n");
  git(repo, "add", "dir/c.txt");
  await commitPaths(repo, { summary: "Third try", amend: true }, []);
  assert.equal(
    git(repo, "show", "--name-only", "--format=", "HEAD").trim(),
    "a.txt\nb.txt",
  );
  assert.equal((await readCommitMessage(repo, "HEAD")).summary, "Third try");

  // No summary: the files go in under the message HEAD already has.
  git(repo, "commit", "-q", "--amend", "-m", "Fourth try", "-m", "Body");
  await commitPaths(repo, { amend: true }, ["dir/c.txt"]);
  assert.equal(rev(repo, "HEAD~1"), root);
  assert.equal(
    git(repo, "show", "--name-only", "--format=", "HEAD").trim(),
    "a.txt\nb.txt\ndir/c.txt",
  );
  assert.deepEqual(await readCommitMessage(repo, "HEAD"), {
    summary: "Fourth try",
    description: "Body",
  });
});

it("undo soft-resets to an ancestor, keeps the files, and redo needs HEAD where it was", async () => {
  const { repo, root, second } = await seedWithSecond();

  const was = await resetSoft(repo, root, undefined);
  assert.equal(was, second);
  assert.equal(rev(repo, "HEAD"), root);
  assert.equal(read(repo, "a.txt"), "second\n", "content untouched");
  assert.equal(rowOf(await listChangesForPage(repo), "a.txt").staged, "all");

  // Redo: forwards to the descendant, pinned to where HEAD must be.
  const back = await resetSoft(repo, second, root);
  assert.equal(back, root);
  assert.equal(rev(repo, "HEAD"), second);
  assert.deepEqual(await listChangesForPage(repo), []);

  // A forwards move is never taken without the pin.
  await resetSoft(repo, root, undefined);
  await assert.rejects(
    resetSoft(repo, second, undefined),
    /isn't on this branch's history/,
  );
  assert.equal(rev(repo, "HEAD"), root);
});

it("undo refuses a moved HEAD, a commit off the line, and a range over a merge", async () => {
  const { repo, root, second } = await seedWithSecond();

  // Moved on: the pin names a commit HEAD no longer is.
  await assert.rejects(resetSoft(repo, root, root), /branch has moved on/);
  assert.equal(rev(repo, "HEAD"), second);

  // Off the line: a commit on another branch.
  git(repo, "checkout", "-q", "-b", "side", root);
  write(repo, "side.txt", "side\n");
  git(repo, "add", "side.txt");
  git(repo, "commit", "-q", "-m", "side");
  const side = rev(repo, "HEAD");
  git(repo, "checkout", "-q", "main");
  await assert.rejects(
    resetSoft(repo, side, undefined),
    /isn't on this branch's history/,
  );
  assert.equal(rev(repo, "HEAD"), second);

  // Across a merge.
  git(repo, "merge", "-q", "--no-ff", "-m", "merge side", "side");
  await assert.rejects(
    resetSoft(repo, root, undefined),
    /across a merge commit/,
  );
  assert.equal(rev(repo, "HEAD~1"), second);
  assert.equal(read(repo, "side.txt"), "side\n");
});

it("discard restores tracked files, removes untracked ones, and keeps a snapshot ref", async () => {
  const repo = seedRepo();
  write(repo, "a.txt", "edited\n"); // edit, unstaged
  write(repo, "b.txt", "staged edit\n");
  git(repo, "add", "b.txt"); // edit, staged
  rmSync(join(repo, "dir", "c.txt")); // deleted
  mkdirSync(join(repo, "fresh"));
  write(repo, "fresh/n.txt", "new\n"); // untracked in a fresh dir
  write(repo, "added.txt", "added\n");
  git(repo, "add", "added.txt"); // staged addition
  write(repo, "kept.txt", "not picked\n");

  const paths = ["a.txt", "b.txt", "dir/c.txt", "fresh/n.txt", "added.txt"];
  const snapshot = await discardChanges(repo, paths);

  assert.equal(read(repo, "a.txt"), "one\ntwo\nthree\n");
  assert.equal(read(repo, "b.txt"), "bee\n");
  assert.equal(read(repo, "dir/c.txt"), "sea\n");
  // `clean` takes the file. Its now-empty folder stays behind, which
  // git neither lists nor tracks, so the page reads clean.
  assert.equal(existsSync(join(repo, "fresh", "n.txt")), false);
  assert.equal(existsSync(join(repo, "added.txt")), false);
  assert.equal(read(repo, "kept.txt"), "not picked\n", "unpicked file stays");
  assert.deepEqual(
    (await listChangesForPage(repo)).map((f) => f.path),
    ["kept.txt"],
  );

  // The snapshot is a commit on HEAD holding the discarded state.
  const ref = only(discardRefs(repo));
  assert.ok(ref !== undefined, "expected exactly one discard ref");
  assert.equal(rev(repo, ref), snapshot);
  assert.equal(rev(repo, `${snapshot}^`), rev(repo, "HEAD"));
  assert.equal(git(repo, "show", `${snapshot}:a.txt`), "edited\n");
  assert.equal(git(repo, "show", `${snapshot}:fresh/n.txt`), "new\n");
  assert.equal(git(repo, "show", `${snapshot}:added.txt`), "added\n");
  // The deletion is recorded as the path's absence from the tree.
  const inSnapshot = (path: string): string =>
    git(repo, "ls-tree", "--name-only", snapshot, path).trim();
  assert.equal(inSnapshot("dir/c.txt"), "", "deletion recorded");
  // The real index was left alone by the snapshot: kept.txt is
  // still untracked, not swept into the commit.
  assert.equal(inSnapshot("kept.txt"), "");
});

it("restoreDiscard puts the discard back, unstaged, and re-deletes what was deleted", async () => {
  const repo = seedRepo();
  write(repo, "a.txt", "edited\n");
  rmSync(join(repo, "b.txt"));
  mkdirSync(join(repo, "fresh"));
  write(repo, "fresh/n.txt", "new\n");
  const snapshot = await discardChanges(repo, [
    "a.txt",
    "b.txt",
    "fresh/n.txt",
  ]);
  assert.deepEqual(await listChangesForPage(repo), []);

  await restoreDiscard(repo, snapshot);
  assert.equal(read(repo, "a.txt"), "edited\n");
  assert.equal(existsSync(join(repo, "b.txt")), false);
  assert.equal(read(repo, "fresh/n.txt"), "new\n");
  const files = await listChangesForPage(repo);
  assert.deepEqual(
    files.map((f) => [f.path, f.kind, f.staged]),
    [
      ["a.txt", "modified", "none"],
      ["b.txt", "deleted", "none"],
      ["fresh/n.txt", "added", "none"],
    ],
  );
});

it("a discard on an unborn branch snapshots as a root commit and restores", async () => {
  const repo = tempDir("sm-changes-unborn-", trackTest);
  git(repo, "init", "-q", "-b", "main");
  write(repo, "first.txt", "first\n");
  const snapshot = await discardChanges(repo, ["first.txt"]);
  assert.equal(existsSync(join(repo, "first.txt")), false);
  assert.equal(git(repo, "rev-list", "--count", snapshot).trim(), "1");
  await restoreDiscard(repo, snapshot);
  assert.equal(read(repo, "first.txt"), "first\n");
});

it("a nested repository is left in place and named in the error", async () => {
  const repo = seedRepo();
  const nested = join(repo, "vendor", "inner");
  mkdirSync(nested, { recursive: true });
  git(nested, "init", "-q", "-b", "main");
  write(nested, "f.txt", "inner\n");
  write(repo, "plain.txt", "plain\n");
  const untracked = (await listChangesForPage(repo)).map((f) => f.path);
  assert.deepEqual(untracked, ["plain.txt", "vendor/inner/"]);

  // With no commit inside, git can't even record the gitlink, so
  // the snapshot fails and nothing is touched: the discard is off.
  await assert.rejects(discardChanges(repo, untracked));
  assert.equal(read(repo, "plain.txt"), "plain\n");
  assert.equal(discardRefs(repo).length, 0, "no half snapshot kept");

  // With a commit, the snapshot holds the gitlink, `clean` walks
  // past the repository, and the error says what stayed.
  git(nested, "add", "f.txt");
  git(nested, "commit", "-q", "-m", "inner");
  await assert.rejects(
    discardChanges(repo, untracked),
    /Couldn't remove vendor\/inner\/. A nested git repository/,
  );
  assert.equal(read(nested, "f.txt"), "inner\n");
  assert.equal(existsSync(join(repo, "plain.txt")), false);
});

it("only the newest 40 discard snapshots are kept", async () => {
  const repo = seedRepo();
  // 41 older snapshots seeded by name: millisecond timestamps of the
  // same width as Date.now(), all in the past, so the real discard's
  // ref sorts newest.
  const head = rev(repo, "HEAD");
  const seeded = Array.from(
    { length: 41 },
    (_, i) => `refs/shigomori/discards/${1_000_000_000_000 + i}`,
  );
  execFileSync("git", ["update-ref", "--stdin"], {
    cwd: repo,
    env: gitEnv,
    input: seeded.map((ref) => `create ${ref} ${head}\n`).join(""),
  });
  write(repo, "a.txt", "edited\n");
  const snapshot = await discardChanges(repo, ["a.txt"]);
  const refs = git(
    repo,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/shigomori/discards/",
  )
    .trim()
    .split("\n")
    .map((line) => line.split(" "));
  // The two oldest seeded refs went, and the real discard's ref is last.
  assert.deepEqual(
    refs.slice(0, -1).map(([ref]) => ref),
    seeded.slice(2),
  );
  assert.equal(refs.at(-1)?.[1], snapshot, "the real discard's ref is kept");
  assert.equal(refs.length, 40);
});
