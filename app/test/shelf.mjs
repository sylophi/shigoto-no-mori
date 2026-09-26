// Durable proof for the shelf's auto-unshelve (host/lib/worktrees/
// shelved.ts, wired into listWorktrees) against a REAL git repository:
// the first listing of a shelved worktree records a snapshot, a later
// listing leaves it shelved while nothing moved (the changes it was
// shelved with included), and unshelves it once it is worked in: an
// edit, a commit, a deleted file, a new edit to an already changed
// file. An auto-pull worktree that only fast-forwards stays shelved,
// and a commit made in one still unshelves it. A listing that read a
// snapshot before a reshelve doesn't undo the reshelve, and a snapshot
// whose head couldn't be read doesn't count every later head as work.
//
// Runs under test/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. Run: pnpm test shelf.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  delay,
  makeProof,
  sandboxGit,
  scrubbedGitEnv,
} from "./lib/checkKit.mjs";

// The listing runs git under this process's environment. The
// pre-commit hook's GIT_* variables would point that git at the commit
// in progress, so they go before anything is imported.
const gitEnv = scrubbedGitEnv();
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const { initDataDirAt } = await import("../host/lib/util/paths.ts");
const { isShelved, setShelved, settleShelf, shelfSnapshots } =
  await import("../host/lib/worktrees/shelved.ts");
const { setAutoPull, dropAutoPull } =
  await import("../host/lib/worktrees/autoPull.ts");
const { autoPullWorktree } =
  await import("../host/lib/worktrees/autoPullSweep.ts");
const { listWorktrees, worktreeIdFromPath } =
  await import("../host/lib/git/worktrees.ts");
const { worktreePathForProject } =
  await import("../host/lib/worktrees/paths.ts");

const git = sandboxGit(gitEnv);

const { check, done, fail } = makeProof("shelf proof");

const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "sm-shelf-data-")));
initDataDirAt(dataDir);

// A bare origin, a project cloned from it, and a managed linked
// worktree of the project on its own pushed branch (an external
// worktree can't be shelved). The seed clone plays the colleague.
let sandboxes = 0;
function makeSandbox(track) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-shelf-")));
  track(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  git(root, "init", "--bare", "-q", "-b", "main", origin);
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", seed);
  git(seed, "remote", "add", "origin", origin);
  writeFileSync(join(seed, "a.txt"), "a\n");
  writeFileSync(join(seed, "b.txt"), "b\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "-u", "origin", "main");
  const project = join(root, "project");
  git(root, "clone", "-q", origin, project);
  sandboxes += 1;
  const worktree = worktreePathForProject(project, null, `linked${sandboxes}`);
  track(() => rmSync(worktree, { recursive: true, force: true }));
  git(project, "worktree", "add", "-q", "-b", "feature", worktree);
  git(worktree, "push", "-q", "-u", "origin", "feature");
  const id = worktreeIdFromPath(worktree);
  track(() => {
    setShelved(id, false);
    shelfSnapshots.drop(id);
    dropAutoPull(id);
  });
  return { seed, project, worktree, id };
}

async function listedShelved({ project, id }) {
  const rows = await listWorktrees("proj", project);
  const row = rows.find((w) => w.id === id);
  assert.ok(row, "the linked worktree is listed");
  return row.shelved;
}

// Shelve, then the listing that records the snapshot.
async function shelve(box) {
  setShelved(box.id, true);
  assert.equal(await listedShelved(box), true, "shelved on first listing");
  assert.ok(shelfSnapshots.read()[box.id], "the listing took a snapshot");
  assert.equal(await listedShelved(box), true, "unchanged stays shelved");
  // Past the snapshot's timestamp, so an edit reads as newer than it.
  await delay(20);
}

function assertUnshelved(box) {
  assert.equal(isShelved(box.id), false, "the mark is gone");
  assert.equal(shelfSnapshots.read()[box.id], undefined, "the snapshot too");
}

async function main() {
  console.log("shelf proof\n");

  await check(
    "an edit to a clean shelved worktree unshelves it",
    async (track) => {
      const box = makeSandbox(track);
      await shelve(box);
      writeFileSync(join(box.worktree, "a.txt"), "edited\n");
      assert.equal(await listedShelved(box), false);
      assertUnshelved(box);
    },
  );

  await check("a new untracked file unshelves it", async (track) => {
    const box = makeSandbox(track);
    await shelve(box);
    writeFileSync(join(box.worktree, "new.txt"), "new\n");
    assert.equal(await listedShelved(box), false);
  });

  await check(
    "changes it was shelved with keep it shelved, a new edit to one of them doesn't",
    async (track) => {
      const box = makeSandbox(track);
      writeFileSync(join(box.worktree, "a.txt"), "dirty\n");
      await shelve(box);
      assert.equal(await listedShelved(box), true);
      writeFileSync(join(box.worktree, "a.txt"), "dirtier\n");
      assert.equal(await listedShelved(box), false);
    },
  );

  await check("a deleted file unshelves it", async (track) => {
    const box = makeSandbox(track);
    await shelve(box);
    unlinkSync(join(box.worktree, "b.txt"));
    assert.equal(await listedShelved(box), false);
  });

  await check(
    "a commit unshelves it, even one that leaves the tree clean",
    async (track) => {
      const box = makeSandbox(track);
      writeFileSync(join(box.worktree, "a.txt"), "dirty\n");
      await shelve(box);
      git(box.worktree, "commit", "-q", "-am", "work");
      assert.equal(await listedShelved(box), false);
    },
  );

  await check(
    "a shelve after an unshelve starts from a fresh snapshot",
    async (track) => {
      const box = makeSandbox(track);
      await shelve(box);
      writeFileSync(join(box.worktree, "a.txt"), "edited\n");
      assert.equal(await listedShelved(box), false);
      await shelve(box);
      assert.equal(await listedShelved(box), true);
    },
  );

  await check(
    "an auto-pull worktree stays shelved through a fast-forward, not through a commit",
    async (track) => {
      const box = makeSandbox(track);
      setAutoPull(box.id, true);
      await shelve(box);
      git(box.seed, "fetch", "-q", "origin");
      git(box.seed, "checkout", "-q", "feature");
      writeFileSync(join(box.seed, "remote.txt"), "remote\n");
      git(box.seed, "add", ".");
      git(box.seed, "commit", "-q", "-m", "remote");
      git(box.seed, "push", "-q", "origin", "feature");
      git(box.worktree, "fetch", "-q");
      const outcome = await autoPullWorktree(
        { path: box.worktree, detached: false },
        { busy: false },
      );
      assert.equal(outcome.kind, "pulled");
      assert.equal(await listedShelved(box), true, "the pull is not work");
      writeFileSync(join(box.worktree, "a.txt"), "local\n");
      git(box.worktree, "commit", "-q", "-am", "local");
      assert.equal(await listedShelved(box), false, "the commit is");
    },
  );

  await check(
    "a listing that read the snapshot before a reshelve leaves the reshelve alone",
    async (track) => {
      const box = makeSandbox(track);
      await shelve(box);
      const stale = shelfSnapshots.read()[box.id];
      // Unshelve, work, shelve again: the CLI's path, then the listing
      // that snapshots the new shelf.
      setShelved(box.id, false);
      writeFileSync(join(box.worktree, "a.txt"), "edited\n");
      await shelve(box);
      const worked = {
        at: Date.now(),
        head: null,
        changed: 5,
        followsUpstream: false,
      };
      assert.equal(settleShelf(box.id, stale, worked), true);
      assert.equal(isShelved(box.id), true);
      assert.notEqual(shelfSnapshots.read()[box.id], undefined);
    },
  );

  await check(
    "a snapshot without a head doesn't read every head as work",
    async (track) => {
      const box = makeSandbox(track);
      setShelved(box.id, true);
      const snapshot = { at: Date.now(), head: null, changed: 0 };
      shelfSnapshots.seed(box.id, snapshot);
      const seen = {
        at: Date.now(),
        head: "abc1234",
        changed: 0,
        followsUpstream: false,
      };
      assert.equal(settleShelf(box.id, snapshot, seen), true);
      assert.equal(isShelved(box.id), true);
    },
  );

  rmSync(dataDir, { recursive: true, force: true });
  done();
}

main().catch(fail);
