// Durable proof for the changes page's hunks (host/lib/git/hunks.ts)
// against a REAL repository: a file's changes read with which are
// staged, ticked in and out one at a time with the index holding
// exactly HEAD plus the ticked ones, insertions, deletions and a
// missing final newline among them, a discard that takes one change
// out of the file and the index and comes back through its snapshot,
// a CRLF checkout keeping its line endings through a discard, and the
// refusals (an index holding what the file doesn't, a pick the file no
// longer has).
//
// Run: pnpm test git-hunks.
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

const gitEnv = scrubbedGitEnv();
scrubProcessGitEnv({
  GIT_AUTHOR_NAME: "sm",
  GIT_AUTHOR_EMAIL: "sm@example.test",
  GIT_COMMITTER_NAME: "sm",
  GIT_COMMITTER_EMAIL: "sm@example.test",
});

const { discardHunks, readHunkStates, setHunksStaged } =
  await import("../host/lib/git/hunks.ts");
const { restoreDiscard } = await import("../host/lib/git/changes.ts");

const git = sandboxGit(gitEnv);

const { check, done, fail } = makeProof("git-hunks proof");
console.log("git-hunks proof\n");

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join("");
const crlf = (text: string) => text.replaceAll("\n", "\r\n");
const read = (repo: string) => readFileSync(join(repo, "f.txt"), "utf8");
const staged = (repo: string) => git(repo, "show", ":f.txt");

// f.txt at twenty lines, then edited in three places far enough apart
// to be three changes: line 2 changed, a line inserted after 10, and
// line 19 deleted with the final newline dropped (one change: 19-20
// become one line).
const EDITED = lines(20)
  .replace("line 2\n", "line two\n")
  .replace("line 10\n", "line 10\ninserted\n")
  .replace("line 19\n", "")
  .replace(/\n$/, "");

function seed(track: Track): string {
  const repo = tempDir("sm-hunks-", track);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "f.txt"), lines(20));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  writeFileSync(join(repo, "f.txt"), EDITED);
  return repo;
}

async function main() {
  await check(
    "ticking one change at a time leaves the index at HEAD plus exactly those",
    async (track) => {
      const repo = seed(track);
      const { changes, editable } = await readHunkStates(repo, "f.txt");
      assert.equal(editable, true);
      assert.equal(changes.length, 3, JSON.stringify(changes));
      assert.ok(changes.every((c) => !c.staged));
      const [edit, insert] = changes;
      assert.ok(edit && insert);

      await setHunksStaged(repo, "f.txt", [insert], true);
      assert.equal(
        staged(repo),
        lines(20).replace("line 10\n", "line 10\ninserted\n"),
      );
      await setHunksStaged(repo, "f.txt", [edit], true);
      const after = await readHunkStates(repo, "f.txt");
      assert.deepEqual(
        after.changes.map((c) => c.staged),
        [true, true, false],
      );

      await setHunksStaged(repo, "f.txt", [insert], false);
      assert.equal(staged(repo), lines(20).replace("line 2\n", "line two\n"));

      // Every change ticked is the working tree, final newline and all.
      await setHunksStaged(repo, "f.txt", after.changes, true);
      assert.equal(staged(repo), EDITED);
      assert.equal(read(repo), EDITED);
    },
  );

  await check(
    "a discard takes one change out of the file and the index, and its snapshot brings it back",
    async (track) => {
      const repo = seed(track);
      const { changes } = await readHunkStates(repo, "f.txt");
      const [edit, insert] = changes;
      assert.ok(edit && insert);
      await setHunksStaged(repo, "f.txt", [edit, insert], true);
      const snapshot = await discardHunks(repo, "f.txt", [insert]);
      assert.equal(read(repo), EDITED.replace("inserted\n", ""));
      assert.equal(staged(repo), lines(20).replace("line 2\n", "line two\n"));
      await restoreDiscard(repo, snapshot);
      assert.equal(read(repo), EDITED);
    },
  );

  await check(
    "an index holding what the file doesn't is not editable, and a stale pick is refused",
    async (track) => {
      const repo = seed(track);
      const { changes } = await readHunkStates(repo, "f.txt");
      const [edit] = changes;
      assert.ok(edit);
      writeFileSync(
        join(repo, "f.txt"),
        lines(20).replace("line 5\n", "five\n"),
      );
      git(repo, "add", "f.txt");
      writeFileSync(join(repo, "f.txt"), EDITED);
      const states = await readHunkStates(repo, "f.txt");
      assert.equal(states.editable, false);
      await assert.rejects(
        setHunksStaged(repo, "f.txt", [edit], true),
        /whole file/,
      );
      git(repo, "reset", "-q");
      await assert.rejects(
        setHunksStaged(repo, "f.txt", [{ ...edit, newCount: 9 }], true),
        /changed since/,
      );
    },
  );

  await check(
    "in a CRLF checkout a discard keeps every line's ending",
    async (track) => {
      const repo = tempDir("sm-hunks-crlf-", track);
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "core.autocrlf", "true");
      writeFileSync(join(repo, "f.txt"), crlf(lines(20)));
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "init");
      writeFileSync(
        join(repo, "f.txt"),
        crlf(lines(20).replace("line 2\n", "two\n").replace("line 18\n", "")),
      );
      const { changes } = await readHunkStates(repo, "f.txt");
      const [, removal] = changes;
      assert.ok(removal && changes.length === 2);
      await discardHunks(repo, "f.txt", [removal]);
      assert.equal(read(repo), crlf(lines(20).replace("line 2\n", "two\n")));
    },
  );

  done();
}

main().catch(fail);
