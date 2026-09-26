// Durable proof for the shelf's auto-unshelve (cli/shelf.go, run by
// `sm worktrees list`) against a REAL git repository, read the way the
// app reads it: the host's listWorktreesViaCli over the sm binary
// built from cli/. The first listing of a shelved worktree records a
// snapshot in registry.json, a later listing leaves it shelved while
// nothing moved (the changes it was shelved with included), and
// unshelves it once it is worked in: an edit, a new file, a deleted
// file, a commit, a new edit to an already changed file. The cheap
// --identities form settles nothing. An auto-pull worktree that only
// fast-forwards stays shelved, and a commit made in one still
// unshelves it. A listing that read a snapshot before a reshelve
// doesn't undo the reshelve, and a snapshot whose head couldn't be
// read (the app's own, from before the CLI took the listing over)
// doesn't count every later head as work.
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test shelf.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { delay, makeProof, waitFor } from "./lib/checkKit.mjs";
import { cliSandbox } from "./lib/cliSandbox.mjs";

// Scrubs this process's GIT_* (the pull below runs the app's git in
// it) and pins the fixture identity.
const fixture = cliSandbox("sm-shelf-");
await fixture.buildSm();
fixture.useCli();
const { dataDir, git, gitOut, commitFile, sandbox } = fixture;

const {
  listWorktreeIdentitiesViaCli,
  listWorktreesViaCli,
  setAutoPullViaCli,
  setShelvedViaCli,
} = await import("../host/ipc/cliDelegate.ts");
const { autoPullWorktree } =
  await import("../host/lib/worktrees/autoPullSweep.ts");

const { check, done, fail } = makeProof("shelf proof");

const registryPath = join(dataDir, "registry.json");
const readRegistry = () => JSON.parse(readFileSync(registryPath, "utf8"));
const snapshotOf = (id) => readRegistry().shelfSnapshots?.[id];
const markedShelved = (id) => readRegistry().shelvedWorktrees?.[id] === true;

// A bare origin, a project cloned from it and registered through the
// CLI, and a linked worktree of it under the managed root (an external
// worktree can't be shelved) on its own pushed branch. The seed clone
// plays the colleague.
let sandboxes = 0;
async function makeSandbox(track) {
  sandboxes += 1;
  const root = join(sandbox, `box${sandboxes}`);
  mkdirSync(root);
  track(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  await git(root, ["init", "--bare", "-q", "-b", "main", origin]);
  const seed = join(root, "seed");
  await git(root, ["init", "-q", "-b", "main", seed]);
  await git(seed, ["remote", "add", "origin", origin]);
  writeFileSync(join(seed, "a.txt"), "a\n");
  await commitFile(seed, "b.txt", "b\n", "seed");
  await git(seed, ["push", "-q", "-u", "origin", "main"]);
  // A basename of its own, so each sandbox gets its own managed base.
  const project = join(root, `project${sandboxes}`);
  await git(root, ["clone", "-q", origin, project]);
  const worktree = join(dataDir, "worktrees", basename(project), "linked");
  track(() => rmSync(worktree, { recursive: true, force: true }));
  await git(project, ["worktree", "add", "-q", "-b", "feature", worktree]);
  await git(worktree, ["push", "-q", "-u", "origin", "feature"]);
  const projectId = await fixture.projectIdOf(project);
  const rows = await listWorktreesViaCli(projectId);
  const row = rows.find((w) => w.path === worktree);
  assert.ok(row, "the linked worktree is listed");
  assert.equal(row.isExternal, false, "the linked worktree is managed");
  return {
    root,
    seed,
    project,
    worktree,
    id: row.id,
    projectRef: { id: projectId },
  };
}

async function listedShelved(box) {
  const rows = await listWorktreesViaCli(box.projectRef.id);
  const row = rows.find((w) => w.id === box.id);
  assert.ok(row, "the linked worktree is listed");
  return row.shelved;
}

// Shelve, then the listing that records the snapshot.
async function shelve(box) {
  await setShelvedViaCli(box.projectRef, box.id, true);
  assert.equal(snapshotOf(box.id), undefined, "a shelve starts unsnapshotted");
  assert.equal(await listedShelved(box), true, "shelved on first listing");
  const snapshot = snapshotOf(box.id);
  assert.ok(snapshot, "the listing took a snapshot");
  assert.deepEqual(Object.keys(snapshot).toSorted(), ["at", "changed", "head"]);
  assert.equal(await listedShelved(box), true, "unchanged stays shelved");
  assert.deepEqual(snapshotOf(box.id), snapshot, "and keeps its snapshot");
  // Past the snapshot's timestamp, so an edit reads as newer than it.
  await delay(20);
  return snapshot;
}

function assertUnshelved(box) {
  assert.equal(markedShelved(box.id), false, "the mark is gone");
  assert.equal(snapshotOf(box.id), undefined, "the snapshot too");
}

async function main() {
  console.log("shelf proof\n");

  await check(
    "an edit to a clean shelved worktree unshelves it, on the full listing only",
    async (track) => {
      const box = await makeSandbox(track);
      const snapshot = await shelve(box);
      assert.equal(snapshot.changed, 0);
      assert.equal(
        snapshot.head,
        await gitOut(box.worktree, "log", "-1", "--format=%h"),
      );
      writeFileSync(join(box.worktree, "a.txt"), "edited\n");
      const [identity] = await listWorktreeIdentitiesViaCli({
        projectId: box.projectRef.id,
        worktreeId: box.id,
      });
      assert.equal(identity.shelved, true, "--identities settles nothing");
      assert.deepEqual(snapshotOf(box.id), snapshot);
      assert.equal(await listedShelved(box), false);
      assertUnshelved(box);
    },
  );

  await check("a new untracked file unshelves it", async (track) => {
    const box = await makeSandbox(track);
    await shelve(box);
    writeFileSync(join(box.worktree, "new.txt"), "new\n");
    assert.equal(await listedShelved(box), false);
    assertUnshelved(box);
  });

  await check(
    "changes it was shelved with keep it shelved, a new edit to one of them doesn't",
    async (track) => {
      const box = await makeSandbox(track);
      writeFileSync(join(box.worktree, "a.txt"), "dirty\n");
      const snapshot = await shelve(box);
      assert.equal(snapshot.changed, 1);
      assert.equal(await listedShelved(box), true);
      writeFileSync(join(box.worktree, "a.txt"), "dirtier\n");
      assert.equal(await listedShelved(box), false);
      assertUnshelved(box);
    },
  );

  await check("a deleted file unshelves it", async (track) => {
    const box = await makeSandbox(track);
    await shelve(box);
    unlinkSync(join(box.worktree, "b.txt"));
    assert.equal(await listedShelved(box), false);
  });

  await check(
    "a commit unshelves it, even one that leaves the tree clean",
    async (track) => {
      const box = await makeSandbox(track);
      writeFileSync(join(box.worktree, "a.txt"), "dirty\n");
      await shelve(box);
      await git(box.worktree, ["commit", "-q", "-am", "work"]);
      assert.equal(await listedShelved(box), false);
      assertUnshelved(box);
    },
  );

  await check(
    "a shelve after an unshelve starts from a fresh snapshot",
    async (track) => {
      const box = await makeSandbox(track);
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
      const box = await makeSandbox(track);
      await setAutoPullViaCli(box.projectRef, box.id, true);
      await shelve(box);
      await git(box.seed, ["fetch", "-q", "origin"]);
      await git(box.seed, ["checkout", "-q", "feature"]);
      await commitFile(box.seed, "remote.txt", "remote\n", "remote");
      await git(box.seed, ["push", "-q", "origin", "feature"]);
      await git(box.worktree, ["fetch", "-q"]);
      const outcome = await autoPullWorktree(
        { path: box.worktree, detached: false },
        { busy: false },
      );
      assert.equal(outcome.kind, "pulled");
      assert.equal(await listedShelved(box), true, "the pull is not work");
      writeFileSync(join(box.worktree, "a.txt"), "local\n");
      await git(box.worktree, ["commit", "-q", "-am", "local"]);
      assert.equal(await listedShelved(box), false, "the commit is");
      assertUnshelved(box);
    },
  );

  await check(
    "a listing that read the snapshot before a reshelve leaves the reshelve alone",
    async (track) => {
      const box = await makeSandbox(track);
      await shelve(box);
      // Work the first shelf's snapshot would count.
      writeFileSync(join(box.worktree, "a.txt"), "edited\n");
      // Holds the first `git status` that starts while `pause` exists
      // until `resume` does: a listing that has read the registry and
      // not yet written it. git runs the fsmonitor hook on every
      // status, and a failing one only means a full scan.
      const pause = join(box.root, "pause");
      const paused = join(box.root, "paused");
      const resume = join(box.root, "resume");
      const hook = join(box.root, "fsmonitor.sh");
      writeFileSync(
        hook,
        `#!/bin/sh\nif rm "${pause}" 2>/dev/null; then\n  : > "${paused}"\n` +
          `  while [ ! -e "${resume}" ]; do sleep 0.02; done\nfi\nexit 1\n`,
        { mode: 0o755 },
      );
      await git(box.project, ["config", "core.fsmonitor", hook]);
      writeFileSync(pause, "");
      const stale = listWorktreesViaCli(box.projectRef.id);
      track(() => writeFileSync(resume, ""));
      await waitFor(() => existsSync(paused), "the listing to pause");
      // Unshelve, shelve again, and the listing that snapshots the new
      // shelf, all while the first listing holds the old snapshot.
      await setShelvedViaCli(box.projectRef, box.id, false);
      await setShelvedViaCli(box.projectRef, box.id, true);
      assert.equal(await listedShelved(box), true);
      const fresh = snapshotOf(box.id);
      assert.ok(fresh, "the new shelf has its snapshot");
      writeFileSync(resume, "");
      const row = (await stale).find((w) => w.id === box.id);
      assert.equal(row.shelved, true, "the stale listing kept it shelved");
      assert.equal(markedShelved(box.id), true);
      assert.deepEqual(snapshotOf(box.id), fresh);
    },
  );

  await check(
    "a snapshot without a head doesn't read every head as work",
    async (track) => {
      const box = await makeSandbox(track);
      await setShelvedViaCli(box.projectRef, box.id, true);
      // The shape the app wrote before the CLI took the listing over,
      // from a listing whose log came back empty.
      const registry = readRegistry();
      registry.shelfSnapshots = {
        ...registry.shelfSnapshots,
        [box.id]: { at: Date.now(), head: null, changed: 0 },
      };
      writeFileSync(registryPath, JSON.stringify(registry));
      const snapshot = snapshotOf(box.id);
      assert.equal(await listedShelved(box), true);
      assert.equal(markedShelved(box.id), true);
      assert.deepEqual(snapshotOf(box.id), snapshot);
    },
  );

  done();
}

main()
  .catch(fail)
  .finally(() => fixture.remove());
