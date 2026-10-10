// Durable proof for the changes page's hunks (host/lib/git/hunks.ts)
// against a REAL repository: a file's changes read, a commit of some of
// them taking HEAD plus exactly those (insertions, deletions and a
// missing final newline among them), a pick still found after an edit
// above it, a discard that takes one change out of the file and the
// index and comes back through its snapshot, an index holding what the
// file doesn't left alone, a CRLF checkout keeping its line endings
// through a discard and committing clean, a symlink or non-UTF-8 file
// left whole, and a pick the file no longer has refused.
//
// Run: pnpm test git-hunks.
import assert from "node:assert/strict";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LineChange } from "@shigomori/contracts/schemas";
import {
  sandboxGit,
  scrubbedGitEnv,
  scrubProcessGitEnv,
  tempDir,
} from "./lib/checkKit.mts";
import { it } from "vitest";
import { trackTest } from "./lib/vitestKit.mts";

const gitEnv = scrubbedGitEnv();
scrubProcessGitEnv({
  GIT_AUTHOR_NAME: "sm",
  GIT_AUTHOR_EMAIL: "sm@example.test",
  GIT_COMMITTER_NAME: "sm",
  GIT_COMMITTER_EMAIL: "sm@example.test",
});

const { discardHunks, readHunks } = await import("../host/lib/git/hunks.ts");
const { restoreDiscard } = await import("../host/lib/git/changes.ts");
const { commitPicks } = await import("../host/lib/git/commit.ts");

const git = sandboxGit(gitEnv);

console.log("git-hunks proof\n");

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join("");
const crlf = (text: string) => text.replaceAll("\n", "\r\n");
const read = (repo: string) => readFileSync(join(repo, "f.txt"), "utf8");
const staged = (repo: string) => git(repo, "show", ":f.txt");
const committed = (repo: string) => git(repo, "show", "HEAD:f.txt");
const head = (repo: string) => git(repo, "rev-parse", "HEAD").trim();
const commitHunks = (repo: string, changes: readonly LineChange[]) =>
  commitPicks(repo, {
    summary: "Some of f",
    paths: [],
    hunks: [{ path: "f.txt", base: head(repo), changes }],
  });

// f.txt at twenty lines, then edited in three places far enough apart
// to be three changes: line 2 changed, a line inserted after 10, and
// line 19 deleted with the final newline dropped (one change: 19-20
// become one line).
const EDITED = lines(20)
  .replace("line 2\n", "line two\n")
  .replace("line 10\n", "line 10\ninserted\n")
  .replace("line 19\n", "")
  .replace(/\n$/, "");

function seed(): string {
  const repo = tempDir("sm-hunks-", trackTest);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "f.txt"), lines(20));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  writeFileSync(join(repo, "f.txt"), EDITED);
  return repo;
}

// f.txt at twenty lines in a CRLF checkout, then line 2 changed and
// line 18 deleted.
function seedCrlf(): string {
  const repo = tempDir("sm-hunks-crlf-", trackTest);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "core.autocrlf", "true");
  writeFileSync(join(repo, "f.txt"), crlf(lines(20)));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  writeFileSync(
    join(repo, "f.txt"),
    crlf(lines(20).replace("line 2\n", "two\n").replace("line 18\n", "")),
  );
  return repo;
}

it("a commit of some changes takes HEAD plus exactly those, and leaves the file as it is", async () => {
  const repo = seed();
  const changes = (await readHunks(repo, "f.txt")).changes;
  assert.equal(changes.length, 3, JSON.stringify(changes));
  const [edit, insert, removal] = changes;
  assert.ok(edit && insert && removal);

  await commitHunks(repo, [insert]);
  assert.equal(
    committed(repo),
    lines(20).replace("line 10\n", "line 10\ninserted\n"),
  );
  assert.equal(read(repo), EDITED);

  // The rest, final newline and all, is the working tree.
  const rest = (await readHunks(repo, "f.txt")).changes;
  await commitHunks(repo, rest);
  assert.equal(committed(repo), EDITED);
});

it("a pick is found by its place in HEAD after an edit above it moves it, and one the file no longer has is refused", async () => {
  const repo = seed();
  const [, , removal] = (await readHunks(repo, "f.txt")).changes;
  assert.ok(removal);
  writeFileSync(
    join(repo, "f.txt"),
    EDITED.replace("line 5\n", "line 5\nextra\n"),
  );
  await commitHunks(repo, [removal]);
  assert.equal(
    committed(repo),
    lines(20).replace("line 19\n", "").replace(/\n$/, ""),
  );
  await assert.rejects(
    commitHunks(repo, [{ ...removal, oldStart: 7 }]),
    /f\.txt changed since/,
  );
  rmSync(join(repo, "f.txt"));
  await assert.rejects(commitHunks(repo, [removal]), /f\.txt changed since/);
});

it("picks read against an older HEAD are refused, whatever they line up with now", async () => {
  const repo = seed();
  const { head: base, changes } = await readHunks(repo, "f.txt");
  const [, insert] = changes;
  assert.ok(insert);
  // A commit from a terminal that shifts every line of HEAD down.
  const edited = read(repo);
  writeFileSync(join(repo, "f.txt"), `top\n${lines(20)}`);
  git(repo, "commit", "-q", "-am", "top");
  writeFileSync(join(repo, "f.txt"), `top\n${edited}`);
  await assert.rejects(
    commitPicks(repo, {
      summary: "Stale",
      paths: [],
      hunks: [{ path: "f.txt", base, changes: [insert] }],
    }),
    /f\.txt changed since/,
  );
  assert.equal(committed(repo), `top\n${lines(20)}`);
});

it("a discard takes one change out of the file and the index, and its snapshot brings it back", async () => {
  const repo = seed();
  const [, insert] = (await readHunks(repo, "f.txt")).changes;
  assert.ok(insert);
  git(repo, "add", "f.txt");
  const snapshot = await discardHunks(repo, "f.txt", [insert]);
  assert.equal(read(repo), EDITED.replace("inserted\n", ""));
  assert.equal(staged(repo), EDITED.replace("inserted\n", ""));
  await restoreDiscard(repo, snapshot);
  assert.equal(read(repo), EDITED);
});

it("a discard leaves an index holding what the file doesn't alone, and refuses a stale pick", async () => {
  const repo = seed();
  const [edit] = (await readHunks(repo, "f.txt")).changes;
  assert.ok(edit);
  const other = lines(20).replace("line 5\n", "five\n");
  writeFileSync(join(repo, "f.txt"), other);
  git(repo, "add", "f.txt");
  writeFileSync(join(repo, "f.txt"), EDITED);
  await assert.rejects(
    discardHunks(repo, "f.txt", [{ ...edit, newCount: 9 }]),
    /changed since/,
  );
  await discardHunks(repo, "f.txt", [edit]);
  assert.equal(read(repo), EDITED.replace("line two\n", "line 2\n"));
  assert.equal(staged(repo), other);
});

it("in a CRLF checkout a discard keeps every line's ending", async () => {
  const repo = seedCrlf();
  const changes = (await readHunks(repo, "f.txt")).changes;
  const [, removal] = changes;
  assert.ok(removal && changes.length === 2);
  await discardHunks(repo, "f.txt", [removal]);
  assert.equal(read(repo), crlf(lines(20).replace("line 2\n", "two\n")));
});

it("in a CRLF checkout a picked change commits clean", async () => {
  const repo = seedCrlf();
  const [first] = (await readHunks(repo, "f.txt")).changes;
  assert.ok(first);
  await commitHunks(repo, [first]);
  assert.equal(committed(repo), lines(20).replace("line 2\n", "two\n"));
  assert.equal(
    read(repo),
    crlf(lines(20).replace("line 2\n", "two\n").replace("line 18\n", "")),
  );
});

it("a symlink or a file that isn't UTF-8 has no hunks and is never written by the line", async () => {
  const repo = seed();
  writeFileSync(join(repo, "target.txt"), "t\n");
  symlinkSync("target.txt", join(repo, "link"));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "link");
  rmSync(join(repo, "link"));
  symlinkSync("f.txt", join(repo, "link"));
  assert.deepEqual((await readHunks(repo, "link")).changes, []);
  const pick = { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 };
  await assert.rejects(discardHunks(repo, "link", [pick]), /whole/);
  await assert.rejects(
    commitPicks(repo, {
      summary: "Link by the line",
      paths: [],
      hunks: [{ path: "link", base: head(repo), changes: [pick] }],
    }),
    /whole/,
  );
  assert.equal(readFileSync(join(repo, "f.txt"), "utf8"), EDITED);

  const latin = Buffer.from("caf\xe9\n", "latin1");
  writeFileSync(join(repo, "l.txt"), latin);
  git(repo, "add", "l.txt");
  git(repo, "commit", "-q", "-m", "latin");
  writeFileSync(join(repo, "l.txt"), Buffer.concat([latin, latin]));
  assert.deepEqual((await readHunks(repo, "l.txt")).changes, []);
});
